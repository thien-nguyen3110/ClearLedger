package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
)

const commandHelp = `ClearLedger local app
  clearledger                  Start the API and built UI
  clearledger check            Validate configuration/files without contacting services
  clearledger check --model    Also check Ollama's installed model list (no inference)
  clearledger worker           Run the Kafka worker (requires PostgreSQL and Kafka)
  clearledger check worker     Validate worker configuration offline

Settings are environment variables; the binary does not load .env.
See docs/backend/runbook.md and docs/backend/configuration.md.
`

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Getenv, os.Stdout); err != nil {
		// Errors returned by run are deliberately redacted; connection strings and
		// underlying service error bodies must not appear in terminal output.
		fmt.Fprintln(os.Stderr, "ClearLedger:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, get func(string) string, out io.Writer) error {
	if len(args) == 1 && (args[0] == "help" || args[0] == "--help" || args[0] == "-h") {
		_, err := io.WriteString(out, commandHelp)
		return err
	}
	cfg, err := loadRuntimeConfig(args, get)
	if err != nil {
		return err
	}
	if err := cfg.validateFiles(); err != nil {
		return err
	}
	if cfg.check {
		cfg.describe(out)
		if cfg.checkModel {
			return checkLocalModel(ctx, cfg.modelURL, cfg.model, out)
		}
		return nil
	}
	// Reserve the listener before opening a database or creating any state.
	var listener net.Listener
	if cfg.command == "serve" {
		listener, err = net.Listen("tcp", cfg.addr)
		if err != nil {
			return errors.New("could not listen on ADDR; check the host, port and whether another process is using it")
		}
		defer listener.Close()
	}
	startup, cancelStartup := context.WithTimeout(ctx, 10*time.Second)
	s, err := newStore(startup, cfg.databaseURL, cfg.statePath)
	cancelStartup()
	if err != nil {
		if cfg.databaseURL != "" {
			return errors.New("PostgreSQL startup failed; check DATABASE_URL, credentials and service availability")
		}
		return errors.New("local workspace could not be opened; check STATE_PATH, permissions and saved JSON; do not delete existing evidence")
	}
	if s.db != nil {
		defer s.db.Close()
	}
	a := &App{store: s, agent: Investigator{cfg.modelURL, cfg.model}, token: cfg.token, webDir: cfg.webDir, sampleDir: cfg.sampleDir, kafkaConfigured: cfg.brokers != "", slots: make(chan struct{}, 2)}
	if cfg.redisURL != "" {
		opt, err := redis.ParseURL(cfg.redisURL)
		if err != nil {
			return errors.New("REDIS_URL is invalid")
		}
		a.redis = redis.NewClient(opt)
		defer a.redis.Close()
	}
	if cfg.command == "worker" {
		if err := consume(ctx, a, cfg.brokers); err != nil && ctx.Err() == nil {
			// Kafka and pgx errors name the broker, topic offset or database user,
			// never the DATABASE_URL password; operators need them to recover.
			log.Printf("worker: %v", err)
			return errors.New("worker stopped; check PostgreSQL and Kafka availability and worker logs")
		}
		return nil
	}
	runtimeCtx, cancelRuntime := context.WithCancel(ctx)
	defer cancelRuntime()
	if s.db != nil && cfg.brokers != "" {
		go relay(runtimeCtx, s, cfg.brokers)
	}
	server := &http.Server{Handler: a.routes(), BaseContext: func(net.Listener) context.Context { return runtimeCtx }, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 110 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-runtimeCtx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if server.Shutdown(shutdown) != nil {
			_ = server.Close()
		}
	}()
	fmt.Fprintln(out, "ClearLedger listening at http://"+listener.Addr().String())
	err = server.Serve(listener)
	cancelRuntime()
	<-shutdownDone
	if err != nil && err != http.ErrServerClosed {
		return errors.New("API server stopped unexpectedly; check the listener and retry")
	}
	return nil
}
