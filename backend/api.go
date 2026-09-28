package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/redis/go-redis/v9"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type App struct {
	webDir, sampleDir string
	kafkaConfigured   bool
	store             *Store
	agent             Investigator
	redis             *redis.Client
	token             string
	slots             chan struct{}
	investigationsMu  sync.Mutex
	investigations    map[string]bool
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, e error) {
	status := http.StatusInternalServerError
	message := "The request could not be completed. Please retry."
	if errors.Is(e, ErrInvalid) {
		status = http.StatusBadRequest
	}
	if errors.Is(e, ErrConflict) {
		status = 409
	}
	if errors.Is(e, ErrMissing) {
		status = 404
	}
	if status < 500 {
		message = e.Error()
	}
	writeJSON(w, status, ErrorResponse{Error: message})
}
func decode(w http.ResponseWriter, r *http.Request, v any) (err error) {
	defer func() {
		if err != nil {
			err = fmt.Errorf("%w: %v", ErrInvalid, err)
		}
	}()
	r.Body = http.MaxBytesReader(w, r.Body, 2*1024*1024)
	d := json.NewDecoder(r.Body)
	var raw json.RawMessage
	if err = d.Decode(&raw); err != nil {
		return err
	}
	if len(raw) == 0 || raw[0] != '{' {
		return errors.New("a JSON object is required")
	}
	if d.Decode(&struct{}{}) != io.EOF {
		return errors.New("exactly one JSON object required")
	}
	fields := json.NewDecoder(strings.NewReader(string(raw)))
	fields.DisallowUnknownFields()
	return fields.Decode(v)
}
func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, StatusResponse{Status: "ok"}) })
	mux.HandleFunc("GET /api/state", a.handleState)
	mux.HandleFunc("GET /api/config", a.handleConfig)
	mux.HandleFunc("POST /api/import", a.handleImport)
	mux.HandleFunc("POST /api/demo", a.handleDemo)
	mux.HandleFunc("POST /api/cases/{id}/investigate", a.handleInvestigation)
	mux.HandleFunc("POST /api/cases/{id}/review", a.handleReview)
	mux.HandleFunc("GET /api/export", a.handleExport)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, ErrorResponse{Error: "API resource not found"})
	})
	webDir := a.webDir
	if webDir == "" {
		webDir = env("WEB_DIR", "../web/dist")
	}
	mux.Handle("/", http.FileServer(http.Dir(webDir)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
			// Without a token, a DNS-rebound page (evil.example resolving to
			// 127.0.0.1) would pass the Origin check below, so require a loopback Host.
			if a.token == "" && !loopbackHost(r.Host) {
				writeJSON(w, 403, ErrorResponse{Error: "Host not allowed. Set API_TOKEN to serve other host names."})
				return
			}
			auth := r.Header.Get("Authorization")
			if a.token != "" && (!strings.HasPrefix(auth, "Bearer ") || subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(auth, "Bearer ")), []byte(a.token)) != 1) {
				writeJSON(w, 401, ErrorResponse{Error: "Enter your workspace access token to connect."})
				return
			}
			// Same-origin POST requests only. No cookie credentials or permissive CORS.
			if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+r.Host && origin != "https://"+r.Host {
				writeJSON(w, 403, ErrorResponse{Error: "Origin not allowed"})
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}
func loopbackHost(host string) bool {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
func (a *App) handleState(w http.ResponseWriter, r *http.Request) {
	s, e := a.store.read(r.Context())
	if e != nil {
		fail(w, e)
		return
	}
	writeJSON(w, 200, s)
}

func (a *App) handleConfig(w http.ResponseWriter, r *http.Request) {
	mode := "rules"
	if a.agent.URL != "" {
		mode = "ollama:" + a.agent.Model
	}
	storage := "local-file"
	if a.store.db != nil {
		storage = "postgres"
	}
	writeJSON(w, 200, ConfigResponse{Investigator: mode, Storage: storage, RedisConfigured: a.redis != nil, KafkaConfigured: a.kafkaConfigured})
}

func (a *App) handleImport(w http.ResponseWriter, r *http.Request) {
	var input ImportRequest
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
	writeJSON(w, 200, StatusResponse{Status: "imported"})
}

func (a *App) handleDemo(w http.ResponseWriter, r *http.Request) {
	bodies := map[string]string{}
	for _, source := range []string{"processor", "bank"} {
		sampleDir := a.sampleDir
		if sampleDir == "" {
			sampleDir = env("SAMPLE_DIR", "../samples")
		}
		b, e := os.ReadFile(filepath.Join(sampleDir, source+".csv"))
		if e != nil {
			fail(w, e)
			return
		}
		bodies[source] = string(b)
	}
	e := a.store.update(r.Context(), func(s *State) error {
		if len(s.Records) > 0 {
			return fmt.Errorf("%w: sample data can only be loaded into an empty workspace", ErrConflict)
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
	writeJSON(w, 200, StatusResponse{Status: "loaded"})
}

func (a *App) handleReview(w http.ResponseWriter, r *http.Request) {
	var input ReviewRequest
	if e := decode(w, r, &input); e != nil {
		fail(w, e)
		return
	}
	e := a.store.update(r.Context(), func(s *State) error { return reviewCase(s, r.PathValue("id"), input.Fingerprint, input.Note) })
	if e != nil {
		fail(w, e)
		return
	}
	writeJSON(w, 200, StatusResponse{Status: "reviewed"})
}

func (a *App) handleExport(w http.ResponseWriter, r *http.Request) {
	s, e := a.store.read(r.Context())
	if e != nil {
		fail(w, e)
		return
	}
	w.Header().Set("Content-Disposition", "attachment; filename=clearledger-evidence.json")
	writeJSON(w, 200, s)
}
