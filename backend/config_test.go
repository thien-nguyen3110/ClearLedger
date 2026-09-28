package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func configEnv(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestRuntimeConfigRejectsInvalidSettingsWithoutLeakingSecrets(t *testing.T) {
	const secret = "PRIVATE_SENTINEL_CREDENTIAL"
	tests := []struct {
		name   string
		args   []string
		values map[string]string
		field  string
	}{
		{"unknown command", []string{"wroker"}, nil, "usage"},
		{"unknown flag", []string{"check", "--secret=" + secret}, nil, "usage"},
		{"invalid address before database", nil, map[string]string{"ADDR": "bad", "DATABASE_URL": "postgres://unused:5432/db?password=" + secret}, "ADDR"},
		{"public listener needs token", nil, map[string]string{"ADDR": "0.0.0.0:18080"}, "API_TOKEN"},
		{"invalid port", nil, map[string]string{"ADDR": "127.0.0.1:70000"}, "ADDR"},
		{"token whitespace", nil, map[string]string{"API_TOKEN": secret + "\n"}, "API_TOKEN"},
		{"database query secret", nil, map[string]string{"DATABASE_URL": "postgres://localhost:bad/db?password=" + secret}, "DATABASE_URL"},
		{"database malformed secret", nil, map[string]string{"DATABASE_URL": "postgres://user:" + secret + "%ZZ@localhost/db"}, "DATABASE_URL"},
		{"redis secret", nil, map[string]string{"REDIS_URL": "redis://user:" + secret + "%ZZ@localhost:6379"}, "REDIS_URL"},
		{"kafka requires postgres", nil, map[string]string{"KAFKA_BROKERS": "kafka:9092"}, "DATABASE_URL"},
		{"bad broker", nil, map[string]string{"DATABASE_URL": "postgres://localhost/db", "KAFKA_BROKERS": "kafka:9092,"}, "KAFKA_BROKERS"},
		{"worker incomplete", []string{"worker"}, nil, "worker requires"},
		{"model credentials", nil, map[string]string{"OLLAMA_URL": "http://user:" + secret + "@localhost:11434"}, "OLLAMA_URL"},
		{"model query", nil, map[string]string{"OLLAMA_URL": "http://localhost:11434?key=" + secret}, "OLLAMA_URL"},
		{"model endpoint instead of base", nil, map[string]string{"OLLAMA_URL": "http://localhost:11434/api/chat"}, "OLLAMA_URL"},
		{"model fragment", nil, map[string]string{"OLLAMA_URL": "http://localhost:11434/#" + secret}, "OLLAMA_URL"},
		{"empty model fragment", nil, map[string]string{"OLLAMA_URL": "http://localhost:11434#"}, "OLLAMA_URL"},
		{"empty model port", nil, map[string]string{"OLLAMA_URL": "http://localhost:"}, "OLLAMA_URL"},
		{"control token", nil, map[string]string{"API_TOKEN": secret + "\u0000"}, "API_TOKEN"},
		{"model bad port", nil, map[string]string{"OLLAMA_URL": "http://localhost:70000"}, "OLLAMA_URL"},
		{"cloud model", nil, map[string]string{"OLLAMA_URL": "http://localhost:11434", "OLLAMA_MODEL": "model:cloud"}, "OLLAMA_MODEL"},
		{"model check without URL", []string{"check", "--model"}, nil, "OLLAMA_URL"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := loadRuntimeConfig(tc.args, configEnv(tc.values))
			if err == nil || !strings.Contains(err.Error(), tc.field) {
				t.Fatalf("expected %s error, got %v", tc.field, err)
			}
			if strings.Contains(err.Error(), secret) {
				t.Fatal("credential leaked in diagnostic")
			}
		})
	}
}

func TestRuntimeConfigModes(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:18080", "localhost:18080", "[::1]:18080", "127.0.0.2:18080"} {
		c, err := loadRuntimeConfig(nil, configEnv(map[string]string{"ADDR": addr}))
		if err != nil || c.databaseURL != "" || c.modelURL != "" {
			t.Fatalf("%s: %v", addr, err)
		}
	}
	c, err := loadRuntimeConfig([]string{"check", "worker"}, configEnv(map[string]string{
		"DATABASE_URL": "postgres://localhost/db", "KAFKA_BROKERS": "kafka:9092, other:9093",
		"ADDR": "not-an-api-listener", "WEB_DIR": "does-not-exist", "SAMPLE_DIR": "does-not-exist",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.command != "worker" || !c.check || c.brokers != "kafka:9092,other:9093" {
		t.Fatal("incorrect worker configuration")
	}
	if err := c.validateFiles(); err != nil {
		t.Fatal("worker depends on frontend assets", err)
	}
}

func testRuntimeFiles(t *testing.T) map[string]string {
	t.Helper()
	root := t.TempDir()
	web := filepath.Join(root, "web")
	samples := filepath.Join(root, "samples")
	for _, dir := range []string{web, samples} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, file := range []string{"index.html", "app.js", "style.css"} {
		if err := os.WriteFile(filepath.Join(web, file), []byte("synthetic asset"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"processor", "bank"} {
		if err := os.WriteFile(filepath.Join(samples, name+".csv"), []byte(fixture(t, name)), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return map[string]string{"WEB_DIR": web, "SAMPLE_DIR": samples, "STATE_PATH": filepath.Join(root, "private", "state.json")}
}

func TestOfflineCheckHasNoWorkspaceOrNetworkEffects(t *testing.T) {
	values := testRuntimeFiles(t)
	values["DATABASE_URL"] = "postgres://user:PRIVATE_SENTINEL@127.0.0.1:1/db"
	values["REDIS_URL"] = "redis://:PRIVATE_SENTINEL@127.0.0.1:1/0"
	values["KAFKA_BROKERS"] = "127.0.0.1:1"
	values["API_TOKEN"] = "PRIVATE_SENTINEL"
	var output bytes.Buffer
	if err := run(context.Background(), []string{"check"}, configEnv(values), &output); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "PRIVATE_SENTINEL") {
		t.Fatal("secret printed")
	}
	if !strings.Contains(output.String(), "no services contacted") {
		t.Fatal(output.String())
	}
	if _, err := os.Stat(filepath.Dir(values["STATE_PATH"])); !os.IsNotExist(err) {
		t.Fatal("offline check created state directory", err)
	}
	// Repeat in file mode: the saved state must still not be created.
	delete(values, "DATABASE_URL")
	delete(values, "KAFKA_BROKERS")
	if err := run(context.Background(), []string{"check"}, configEnv(values), &output); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(values["STATE_PATH"])); !os.IsNotExist(err) {
		t.Fatal("file-mode check created state directory", err)
	}
}

func TestRuntimeFilesFailBeforeOpeningState(t *testing.T) {
	for _, variant := range []string{"missing-web", "missing-samples", "state-directory", "public-state"} {
		t.Run(variant, func(t *testing.T) {
			values := testRuntimeFiles(t)
			switch variant {
			case "missing-web":
				values["WEB_DIR"] = filepath.Join(t.TempDir(), "missing")
			case "missing-samples":
				values["SAMPLE_DIR"] = filepath.Join(t.TempDir(), "missing")
			case "state-directory":
				values["STATE_PATH"] = t.TempDir()
			case "public-state":
				values["STATE_PATH"] = filepath.Join(values["WEB_DIR"], "state.json")
			}
			var output bytes.Buffer
			if err := run(context.Background(), []string{"check"}, configEnv(values), &output); err == nil {
				t.Fatal("invalid filesystem configuration accepted")
			}
		})
	}
}

func TestHelpDoesNotInitializeConfiguration(t *testing.T) {
	var output bytes.Buffer
	err := run(context.Background(), []string{"--help"}, func(string) string { t.Fatal("help read configuration"); return "" }, &output)
	if err != nil || !strings.Contains(output.String(), "check --model") {
		t.Fatal(err, output.String())
	}
}

func TestAPIRuntimePathsAndFlagsAreSnapshotValues(t *testing.T) {
	values := testRuntimeFiles(t)
	store, err := newStore(context.Background(), "", "")
	if err != nil {
		t.Fatal(err)
	}
	a := &App{store: store, webDir: values["WEB_DIR"], sampleDir: values["SAMPLE_DIR"], kafkaConfigured: true}
	t.Setenv("WEB_DIR", "unavailable")
	t.Setenv("SAMPLE_DIR", "unavailable")
	t.Setenv("KAFKA_BROKERS", "")
	routes := a.routes()
	w := httptest.NewRecorder()
	routes.ServeHTTP(w, localRequest(http.MethodGet, "/", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "synthetic asset") {
		t.Fatal("static path did not use snapshot")
	}
	w = httptest.NewRecorder()
	routes.ServeHTTP(w, localRequest(http.MethodPost, "/api/demo", nil))
	if w.Code != 200 {
		t.Fatal("sample path did not use snapshot", w.Code)
	}
	w = httptest.NewRecorder()
	routes.ServeHTTP(w, localRequest(http.MethodGet, "/api/config", nil))
	var config ConfigResponse
	if err := json.Unmarshal(w.Body.Bytes(), &config); err != nil || !config.KafkaConfigured {
		t.Fatal("Kafka flag did not use snapshot", err)
	}
}

func TestRuntimeRejectsStateExposedThroughDirectoryLink(t *testing.T) {
	for _, variant := range []string{"web-link", "state-parent-link"} {
		t.Run(variant, func(t *testing.T) {
			values := testRuntimeFiles(t)
			link := filepath.Join(t.TempDir(), "link")
			if err := os.Symlink(values["WEB_DIR"], link); err != nil {
				t.Skip("symlink creation unavailable:", err)
			}
			if variant == "web-link" {
				values["STATE_PATH"] = filepath.Join(values["WEB_DIR"], "private", "state.json")
				values["WEB_DIR"] = link
			} else {
				values["STATE_PATH"] = filepath.Join(link, "private", "state.json")
			}
			cfg, err := loadRuntimeConfig([]string{"check"}, configEnv(values))
			if err != nil {
				t.Fatal(err)
			}
			if err := cfg.validateFiles(); err == nil {
				t.Fatal("public state accepted through directory link")
			}
		})
	}
}

type startupNotice chan struct{}

func (n startupNotice) Write(p []byte) (int, error) {
	select {
	case n <- struct{}{}:
	default:
	}
	return len(p), nil
}

func TestShutdownCancelsInvestigationAndDrainsFailureAudit(t *testing.T) {
	values := testRuntimeFiles(t)
	st, err := newStore(context.Background(), "", values["STATE_PATH"])
	if err != nil {
		t.Fatal(err)
	}
	if err = st.update(context.Background(), func(s *State) error { *s = sample(t); return nil }); err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		entered <- struct{}{}
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer model.Close()
	defer close(release)
	values["OLLAMA_URL"] = model.URL
	// Reserve an available local port; run owns the listener once it starts.
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	values["ADDR"] = probe.Addr().String()
	probe.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(startupNotice, 1)
	stopped := make(chan error, 1)
	go func() { stopped <- run(ctx, nil, configEnv(values), ready) }()
	select {
	case <-ready:
	case err := <-stopped:
		t.Fatal("API did not start", err)
	case <-time.After(3 * time.Second):
		t.Fatal("API startup timeout")
	}
	requestDone := make(chan error, 1)
	go func() {
		client := &http.Client{Timeout: 8 * time.Second}
		response, err := client.Post("http://"+values["ADDR"]+"/api/cases/"+digest("PO-1002")[:16]+"/investigate", "application/json", nil)
		if response != nil {
			_, _ = io.Copy(io.Discard, response.Body)
			response.Body.Close()
		}
		requestDone <- err
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("model did not receive investigation")
	}
	cancel()
	select {
	case err := <-stopped:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown did not promptly cancel and drain investigation")
	}
	<-requestDone
	reopened, err := newStore(context.Background(), "", values["STATE_PATH"])
	if err != nil {
		t.Fatal(err)
	}
	saved, err := reopened.read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if workflowActions(saved, "investigation.failed") != 1 {
		t.Fatal("shutdown lost failure audit")
	}
	c, err := caseByID(saved, digest("PO-1002")[:16])
	if err != nil || c.Proposal != nil || c.Status != "open" {
		t.Fatal("shutdown saved a false success", err)
	}
}
