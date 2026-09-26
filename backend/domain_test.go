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
	"sync"
	"testing"
)

func fixture(t *testing.T, source string) string {
	t.Helper()
	b, e := os.ReadFile("../samples/" + source + ".csv")
	if e != nil {
		t.Fatal(e)
	}
	return string(b)
}
func sample(t *testing.T) State {
	t.Helper()
	s := fresh()
	for _, src := range []string{"processor", "bank"} {
		if e := importRecords(&s, src, fixture(t, src), "test-"+src); e != nil {
			t.Fatal(e)
		}
	}
	return s
}
func TestReconciliationCasesAndRefund(t *testing.T) {
	s := sample(t)
	want := map[string]string{"PO-1001": "matched", "PO-1002": "amount_mismatch", "PO-1003": "awaiting_deposit", "PO-1004": "ambiguous_deposit", "PO-1005": "matched", "PO-1006": "matched", "PO-1007": "unexpected_deposit"}
	if len(s.Cases) != 7 {
		t.Fatal(len(s.Cases))
	}
	for _, c := range s.Cases {
		if c.Kind != want[c.Payout] {
			t.Fatalf("%s: %s", c.Payout, c.Kind)
		}
		if c.Payout == "PO-1005" && c.Expected != 16340 {
			t.Fatal("refund was not subtracted")
		}
		if c.Payout == "PO-1002" && c.Delta != -500 {
			t.Fatal("incorrect mismatch")
		}
	}
}
func TestConcurrentImportIdempotency(t *testing.T) {
	store, _ := newStore(context.Background(), "", "")
	body := fixture(t, "processor")
	var wg sync.WaitGroup
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := store.update(context.Background(), func(s *State) error { return importRecords(s, "processor", body, "same-key-000") }); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	s, _ := store.read(context.Background())
	if len(s.Records) != 8 || s.Revision != 1 || len(s.Audit) != 1 {
		t.Fatalf("duplicate effects: %+v", s)
	}
	if e := store.update(context.Background(), func(s *State) error { return importRecords(s, "processor", body+"\n", "same-key-000") }); !errors.Is(e, ErrConflict) {
		t.Fatal("expected idempotency payload conflict", e)
	}
}
func TestImportRollbackAndPersistentRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state.json")
	store, _ := newStore(ctx, "", path)
	if e := store.update(ctx, func(s *State) error { return importRecords(s, "processor", fixture(t, "processor"), "initial-key") }); e != nil {
		t.Fatal(e)
	}
	conflicting := "id,payout,currency,date,gross_cents,fee_cents,description\nnew,NEW,USD,2026-09-01,100,0,valid\nch_101,PO-1001,USD,2026-09-01,999,0,conflict\n"
	if e := store.update(ctx, func(s *State) error { return importRecords(s, "processor", conflicting, "conflict-key") }); !errors.Is(e, ErrConflict) {
		t.Fatal(e)
	}
	reopened, e := newStore(ctx, "", path)
	if e != nil {
		t.Fatal(e)
	}
	s, _ := reopened.read(ctx)
	if len(s.Records) != 8 || s.Revision != 1 {
		t.Fatal("partial import persisted")
	}
}
func TestLateEvidenceInvalidatesReview(t *testing.T) {
	s := sample(t)
	c, _ := caseByID(s, digest("PO-1003")[:16])
	if e := reviewCase(&s, c.ID, c.Fingerprint, "Requested the next bank statement."); e != nil {
		t.Fatal(e)
	}
	body := "id,payout,currency,date,gross_cents,fee_cents,description\nlate,PO-1003,USD,2026-09-08,17000,0,Late imported deposit\n"
	if e := importRecords(&s, "bank", body, "late-evidence"); e != nil {
		t.Fatal(e)
	}
	current, _ := caseByID(s, c.ID)
	if current.Status != "open" || current.ReviewNote != "" {
		t.Fatal("stale review was preserved")
	}
	if e := reviewCase(&s, c.ID, c.Fingerprint, "Old snapshot reviewed."); !errors.Is(e, ErrConflict) {
		t.Fatal("stale write accepted")
	}
}
func TestCSVValidation(t *testing.T) {
	for _, row := range []string{"x,p,EUR,2026-09-01,100,0,x", "x,p,USD,2026-09-01,1.99,0,x", "x,p,USD,not-a-date,100,0,x", "x,p,USD,2026-09-01,9223372036854775807,0,x", "x,p,USD,2026-09-01,100,-1,x"} {
		if _, e := parseCSV("processor", "id,payout,currency,date,gross_cents,fee_cents,description\n"+row); e == nil {
			t.Fatal("invalid input accepted", row)
		}
	}
}
func TestAgentToolLoopAndEvidenceBoundary(t *testing.T) {
	s := sample(t)
	c, _ := caseByID(s, digest("PO-1002")[:16])
	turn := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		turn++
		name := "get_case"
		args := any(map[string]any{})
		if turn == 2 {
			name = "list_evidence"
		}
		if turn == 3 {
			name = "propose_resolution"
			args = rulesProposal(c)
		}
		writeJSON(w, 200, map[string]any{"message": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"function": map[string]any{"name": name, "arguments": args}}}}})
	}))
	defer server.Close()
	p, e := (Investigator{server.URL, "test-model"}).run(context.Background(), c, s.Records)
	if e != nil {
		t.Fatal(e)
	}
	if turn != 3 || p.Mode != "ollama:test-model" {
		t.Fatal(p)
	}
	p.Evidence = []string{"bank:not-in-case"}
	if validateProposal(c, p) == nil {
		t.Fatal("invented evidence accepted")
	}
	p = rulesProposal(c)
	p.Action = "refund"
	if validateProposal(c, p) == nil {
		t.Fatal("money-moving action accepted")
	}
}
func TestAgentBlocksUnknownTool(t *testing.T) {
	s := sample(t)
	c := s.Cases[1]
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"message": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"function": map[string]any{"name": "send_payment", "arguments": map[string]any{}}}}}})
	}))
	defer server.Close()
	if _, e := (Investigator{server.URL, "test-model"}).run(context.Background(), c, s.Records); e == nil || !strings.Contains(e.Error(), "blocked tool") {
		t.Fatal(e)
	}
}
func TestEventReplayDoesNotDuplicateProposal(t *testing.T) {
	ctx := context.Background()
	store, _ := newStore(ctx, "", "")
	_ = store.update(ctx, func(s *State) error { *s = sample(t); return nil })
	a := &App{store: store}
	state, _ := store.read(ctx)
	ids := []string{}
	for _, c := range state.Cases {
		if c.Status == "open" {
			ids = append(ids, c.ID)
		}
	}
	event := Event{"event-1", "reconciliation.completed", ids}
	if e := processEvent(ctx, a, event); e != nil {
		t.Fatal(e)
	}
	first, _ := store.read(ctx)
	if e := processEvent(ctx, a, event); e != nil {
		t.Fatal(e)
	}
	second, _ := store.read(ctx)
	if len(first.Audit) != len(second.Audit) || first.Revision != second.Revision {
		t.Fatal("replay duplicated effects")
	}
}
func TestHTTPAuthAndOrigin(t *testing.T) {
	s, _ := newStore(context.Background(), "", "")
	a := &App{store: s, token: "test-token", slots: make(chan struct{}, 2)}
	handler := a.routes()
	for _, tc := range []struct {
		token, origin string
		status        int
	}{{"", "", 401}, {"test-token", "https://attacker.example", 403}, {"test-token", "", 200}} {
		r := httptest.NewRequest("GET", "/api/state", nil)
		r.Header.Set("Authorization", "Bearer "+tc.token)
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatal(w.Code, tc)
		}
		var response any
		if e := json.Unmarshal(w.Body.Bytes(), &response); e != nil {
			t.Fatal(e)
		}
	}
}
