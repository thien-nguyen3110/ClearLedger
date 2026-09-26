package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/redis/go-redis/v9"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type App struct {
	store *Store
	agent Investigator
	redis *redis.Client
	token string
	slots chan struct{}
}

func env(key, fallback string) string {
	if s := os.Getenv(key); s != "" {
		return s
	}
	return fallback
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, e error) {
	status := http.StatusBadRequest
	if errors.Is(e, ErrConflict) {
		status = 409
	}
	if errors.Is(e, ErrMissing) {
		status = 404
	}
	writeJSON(w, status, map[string]string{"error": e.Error()})
}
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 2*1024*1024)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return e
	}
	if d.Decode(&struct{}{}) != io.EOF {
		return errors.New("exactly one JSON object required")
	}
	return nil
}
func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
		s, e := a.store.read(r.Context())
		if e != nil {
			fail(w, e)
			return
		}
		writeJSON(w, 200, s)
	})
	mux.HandleFunc("GET /api/config", func(w http.ResponseWriter, r *http.Request) {
		mode := "rules"
		if a.agent.URL != "" {
			mode = "ollama:" + a.agent.Model
		}
		storage := "local-file"
		if a.store.db != nil {
			storage = "postgres"
		}
		writeJSON(w, 200, map[string]any{"investigator": mode, "storage": storage, "redis_configured": a.redis != nil, "kafka_configured": os.Getenv("KAFKA_BROKERS") != ""})
	})
	mux.HandleFunc("POST /api/import", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Source string `json:"source"`
			CSV    string `json:"csv"`
		}
		if e := decode(w, r, &input); e != nil {
			fail(w, e)
			return
		}
		e := a.store.update(r.Context(), func(s *State) error {
			return importRecords(s, input.Source, input.CSV, r.Header.Get("Idempotency-Key"))
		})
		if e != nil {
			fail(w, e)
			return
		}
		writeJSON(w, 200, map[string]string{"status": "imported"})
	})
	mux.HandleFunc("POST /api/demo", func(w http.ResponseWriter, r *http.Request) {
		bodies := map[string]string{}
		for _, source := range []string{"processor", "bank"} {
			b, e := os.ReadFile(filepath.Join(env("SAMPLE_DIR", "../samples"), source+".csv"))
			if e != nil {
				fail(w, e)
				return
			}
			bodies[source] = string(b)
		}
		e := a.store.update(r.Context(), func(s *State) error {
			if len(s.Records) > 0 {
				return errors.New("sample data can only be loaded into an empty workspace")
			}
			for _, source := range []string{"processor", "bank"} {
				if e := importRecords(s, source, bodies[source], "demo-"+source+"-v1"); e != nil {
					return e
				}
			}
			return nil
		})
		if e != nil {
			fail(w, e)
			return
		}
		writeJSON(w, 200, map[string]string{"status": "loaded"})
	})
	mux.HandleFunc("POST /api/cases/{id}/investigate", func(w http.ResponseWriter, r *http.Request) {
		select {
		case a.slots <- struct{}{}:
			defer func() { <-a.slots }()
		default:
			writeJSON(w, 429, map[string]string{"error": "Two investigations are already running. Try again shortly."})
			return
		}
		if a.redis != nil {
			script := redis.NewScript(`local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60) end;return n`)
			n, e := script.Run(r.Context(), a.redis, []string{"clearledger:investigations:minute"}).Int()
			if e != nil {
				writeJSON(w, 503, map[string]string{"error": "Investigation rate limiter unavailable"})
				return
			}
			if n > 10 {
				writeJSON(w, 429, map[string]string{"error": "Investigation limit reached. Try again in one minute."})
				return
			}
		}
		s, e := a.store.read(r.Context())
		if e != nil {
			fail(w, e)
			return
		}
		c, e := caseByID(s, r.PathValue("id"))
		if e != nil {
			fail(w, e)
			return
		}
		if c.Status != "open" {
			fail(w, ErrConflict)
			return
		}
		p, e := a.agent.run(r.Context(), c, s.Records)
		if e != nil {
			writeJSON(w, 502, map[string]string{"error": e.Error()})
			return
		}
		e = a.store.update(r.Context(), func(s *State) error { return saveProposal(s, c.ID, c.Fingerprint, p) })
		if e != nil {
			fail(w, e)
			return
		}
		writeJSON(w, 200, p)
	})
	mux.HandleFunc("POST /api/cases/{id}/review", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Fingerprint string `json:"fingerprint"`
			Note        string `json:"note"`
		}
		if e := decode(w, r, &input); e != nil {
			fail(w, e)
			return
		}
		e := a.store.update(r.Context(), func(s *State) error { return reviewCase(s, r.PathValue("id"), input.Fingerprint, input.Note) })
		if e != nil {
			fail(w, e)
			return
		}
		writeJSON(w, 200, map[string]string{"status": "reviewed"})
	})
	mux.HandleFunc("GET /api/export", func(w http.ResponseWriter, r *http.Request) {
		s, e := a.store.read(r.Context())
		if e != nil {
			fail(w, e)
			return
		}
		w.Header().Set("Content-Disposition", "attachment; filename=clearledger-evidence.json")
		writeJSON(w, 200, s)
	})
	mux.Handle("/", http.FileServer(http.Dir(env("WEB_DIR", "../web/dist"))))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
			if a.token != "" && subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")), []byte(a.token)) != 1 {
				writeJSON(w, 401, map[string]string{"error": "Enter your workspace access token to connect."})
				return
			}
			// Same-origin POST requests only. No cookie credentials or permissive CORS.
			if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+r.Host && origin != "https://"+r.Host {
				writeJSON(w, 403, map[string]string{"error": "Origin not allowed"})
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}
func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	s, e := newStore(ctx, os.Getenv("DATABASE_URL"), env("STATE_PATH", "data/state.json"))
	if e != nil {
		log.Fatal(e)
	}
	if s.db != nil {
		defer s.db.Close()
	}
	a := &App{store: s, agent: Investigator{os.Getenv("OLLAMA_URL"), env("OLLAMA_MODEL", "qwen3:4b")}, token: os.Getenv("API_TOKEN"), slots: make(chan struct{}, 2)}
	if u := os.Getenv("REDIS_URL"); u != "" {
		opt, e := redis.ParseURL(u)
		if e != nil {
			log.Fatal(e)
		}
		a.redis = redis.NewClient(opt)
		defer a.redis.Close()
	}
	brokers := os.Getenv("KAFKA_BROKERS")
	if len(os.Args) > 1 && os.Args[1] == "worker" {
		if s.db == nil || brokers == "" {
			log.Fatal("worker requires DATABASE_URL and KAFKA_BROKERS")
		}
		if e = consume(ctx, a, brokers); e != nil && ctx.Err() == nil {
			log.Fatal(e)
		}
		return
	}
	addr := env("ADDR", "127.0.0.1:8080")
	host, _, e := net.SplitHostPort(addr)
	if e != nil {
		log.Fatal(e)
	}
	if host != "127.0.0.1" && host != "localhost" && host != "::1" && len(a.token) < 24 {
		log.Fatal("non-loopback listener requires API_TOKEN of at least 24 characters")
	}
	if s.db != nil && brokers != "" {
		go relay(ctx, s, brokers)
	}
	server := &http.Server{Addr: addr, Handler: a.routes(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 110 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	go func() {
		<-ctx.Done()
		shutdown, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		_ = server.Shutdown(shutdown)
	}()
	fmt.Println("ClearLedger listening at http://" + addr)
	if e = server.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		log.Fatal(e)
	}
}
