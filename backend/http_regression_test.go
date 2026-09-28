package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHTTPInternalErrorsAreServiceFailures(t *testing.T) {
	w := httptest.NewRecorder()
	fail(w, errors.New("private database address and credentials"))
	if w.Code != 500 {
		t.Fatalf("internal failure status = %d, want 500", w.Code)
	}
	if strings.Contains(w.Body.String(), "private") {
		t.Fatal("internal details leaked")
	}
	var body map[string]string
	if e := json.Unmarshal(w.Body.Bytes(), &body); e != nil || body["error"] == "" {
		t.Fatal("missing JSON error envelope")
	}
}

func TestHTTPPersistenceFailureIsAtomicAndRetryable(t *testing.T) {
	ctx := context.Background()
	s, e := newStore(ctx, "", "")
	if e != nil {
		t.Fatal(e)
	}
	s.path = t.TempDir() // Renaming a state file onto a directory must fail.
	a := &App{store: s, slots: make(chan struct{}, 2)}
	body, _ := json.Marshal(map[string]string{"source": "processor", "csv": fixture(t, "processor")})
	submit := func() int {
		r := localRequest("POST", "/api/import", strings.NewReader(string(body)))
		r.Header.Set("Idempotency-Key", "retry-after-write-failure")
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, r)
		return w.Code
	}
	if code := submit(); code != 500 {
		t.Fatalf("write failure = %d, want 500", code)
	}
	st, _ := s.read(ctx)
	if len(st.Records) != 0 || len(st.Imports) != 0 || st.Revision != 0 {
		t.Fatal("failed write mutated state")
	}
	s.path = filepath.Join(t.TempDir(), "state.json")
	if code := submit(); code != 200 {
		t.Fatalf("retry = %d", code)
	}
	reopened, e := newStore(ctx, "", s.path)
	if e != nil {
		t.Fatal(e)
	}
	st, _ = reopened.read(ctx)
	if len(st.Records) != 8 || st.Revision != 1 {
		t.Fatal("retry was not persisted exactly once")
	}
}

func TestHTTPJSONValidationAndUnknownRoute(t *testing.T) {
	s, _ := newStore(context.Background(), "", "")
	a := &App{store: s, slots: make(chan struct{}, 2)}
	for _, tc := range []struct {
		path, body string
		status     int
	}{
		{"/api/import", `{"source":"processor","csv":"","extra":true}`, 400},
		{"/api/import", `null`, 400},
		{"/api/import", `{"source":"processor","csv":""} {}`, 400},
		{"/api/import", `{"source":"processor","csv":""}`, 400},
		{"/api/unknown", `{}`, 404},
	} {
		r := localRequest("POST", tc.path, strings.NewReader(tc.body))
		r.Header.Set("Idempotency-Key", "invalid-request")
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Errorf("%s %s: got %d", tc.path, tc.body, w.Code)
		}
		var body map[string]string
		if e := json.Unmarshal(w.Body.Bytes(), &body); e != nil || body["error"] == "" {
			t.Errorf("%s: not a JSON error", tc.path)
		}
	}
}

func TestHTTPRequiresBearerScheme(t *testing.T) {
	s, _ := newStore(context.Background(), "", "")
	a := &App{store: s, token: "test-access-token"}
	for _, auth := range []string{"test-access-token", "Basic test-access-token", "Bearer wrong"} {
		r := localRequest("GET", "/api/state", nil)
		r.Header.Set("Authorization", auth)
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("accepted malformed credentials %q", auth)
		}
	}
}

// DNS rebinding: evil.example resolves to 127.0.0.1, so its page sends a matching
// Host and Origin. Without a token only loopback host names may use the API.
func TestHTTPTokenlessAPIRequiresLoopbackHost(t *testing.T) {
	s, _ := newStore(context.Background(), "", "")
	for _, tc := range []struct {
		host, token string
		want        int
	}{
		{"evil.example:18080", "", http.StatusForbidden},
		{"192.168.1.20:18080", "", http.StatusForbidden},
		{"127.0.0.1:18080", "", http.StatusOK},
		{"localhost:18080", "", http.StatusOK},
		{"[::1]:18080", "", http.StatusOK},
		{"clearledger.example", "test-access-token", http.StatusOK},
	} {
		a := &App{store: s, token: tc.token}
		r := localRequest("GET", "/api/state", nil)
		r.Host = tc.host
		r.Header.Set("Origin", "http://"+tc.host)
		if tc.token != "" {
			r.Header.Set("Authorization", "Bearer "+tc.token)
		}
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Errorf("host %s token=%t: status %d, want %d", tc.host, tc.token != "", w.Code, tc.want)
		}
	}
	// Static UI files stay reachable; only /api/ is guarded.
	a := &App{store: s, webDir: t.TempDir()}
	r := localRequest("GET", "/", nil)
	r.Host = "evil.example:18080"
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	if w.Code == http.StatusForbidden {
		t.Fatal("static files should not be host-guarded")
	}
}

func TestFileStoreRepeatedUpdatesAndRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state.json")
	s, e := newStore(ctx, "", path)
	if e != nil {
		t.Fatal(e)
	}
	for _, src := range []string{"processor", "bank"} {
		if e = s.update(ctx, func(st *State) error { return importRecords(st, src, fixture(t, src), "restart-"+src) }); e != nil {
			t.Fatal(e)
		}
	}
	st, _ := s.read(ctx)
	c, _ := caseByID(st, digest("PO-1002")[:16])
	if e = s.update(ctx, func(st *State) error {
		return reviewCase(st, c.ID, c.Fingerprint, "Compared the processor and bank evidence.")
	}); e != nil {
		t.Fatal(e)
	}
	reopened, e := newStore(ctx, "", path)
	if e != nil {
		t.Fatal(e)
	}
	st, e = reopened.read(ctx)
	if e != nil {
		t.Fatal(e)
	}
	reviewed, _ := caseByID(st, c.ID)
	if reviewed.Status != "reviewed" || reviewed.Kind != "amount_mismatch" || reviewed.Delta != -500 {
		t.Fatal("review changed financial facts or did not survive restart")
	}
	if len(st.Records) != 15 {
		t.Fatal("source evidence lost")
	}
	if _, e = os.Stat(path); e != nil {
		t.Fatal(e)
	}
}
