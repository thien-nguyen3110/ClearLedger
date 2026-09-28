package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func workflowApp(t *testing.T) *App {
	t.Helper()
	s, err := newStore(context.Background(), "", filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	return &App{store: s, token: "workflow-test-token"}
}

func workflowRequest(a *App, ctx context.Context, method, path string, body any, key string) *httptest.ResponseRecorder {
	var encoded io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			panic(err)
		}
		encoded = strings.NewReader(string(b))
	}
	r := localRequest(method, path, encoded).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer "+a.token)
	r.Header.Set("Idempotency-Key", key)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	return w
}

func workflowCall(t *testing.T, a *App, method, path string, body any, key string, want int) *httptest.ResponseRecorder {
	t.Helper()
	w := workflowRequest(a, context.Background(), method, path, body, key)
	if w.Code != want {
		t.Fatalf("%s %s: status %d, want %d: %s", method, path, w.Code, want, w.Body.String())
	}
	if !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") {
		t.Fatal("missing JSON content type")
	}
	if want >= 400 {
		var e ErrorResponse
		if err := json.Unmarshal(w.Body.Bytes(), &e); err != nil || e.Error == "" {
			t.Fatal("missing error envelope")
		}
	}
	return w
}

func workflowState(t *testing.T, a *App) State {
	t.Helper()
	w := workflowCall(t, a, "GET", "/api/state", nil, "", 200)
	var s State
	if err := json.Unmarshal(w.Body.Bytes(), &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func workflowCase(t *testing.T, a *App, payout string) Case {
	t.Helper()
	c, err := caseByID(workflowState(t, a), digest(payout)[:16])
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func workflowDemo(t *testing.T, a *App) {
	t.Helper()
	workflowCall(t, a, "POST", "/api/demo", nil, "", 200)
}

func workflowActions(s State, action string) int {
	n := 0
	for _, event := range s.Audit {
		if event.Action == action {
			n++
		}
	}
	return n
}

func TestAPIWorkflowImportInvestigateReviewRestartExport(t *testing.T) {
	a := workflowApp(t)
	config := workflowCall(t, a, "GET", "/api/config", nil, "", 200)
	var cfg ConfigResponse
	if err := json.Unmarshal(config.Body.Bytes(), &cfg); err != nil || cfg.Investigator != "rules" || cfg.Storage != "local-file" {
		t.Fatalf("config: %s", config.Body.String())
	}
	empty := workflowState(t, a)
	if empty.Cases == nil || empty.Audit == nil || empty.Records == nil || len(empty.Cases) != 0 {
		t.Fatal("empty response violates state shape")
	}
	for _, source := range []string{"processor", "bank"} {
		input := ImportRequest{source, fixture(t, source)}
		workflowCall(t, a, "POST", "/api/import", input, "workflow-"+source, 200)
		before := workflowState(t, a)
		workflowCall(t, a, "POST", "/api/import", input, "workflow-"+source, 200)
		if !reflect.DeepEqual(before, workflowState(t, a)) {
			t.Fatal("identical retry changed state")
		}
	}
	s := workflowState(t, a)
	matched := 0
	for _, c := range s.Cases {
		if c.Status == "matched" {
			matched++
		}
	}
	if len(s.Records) != 15 || len(s.Cases) != 7 || matched != 3 {
		t.Fatal("incorrect sample totals")
	}
	c := workflowCase(t, a, "PO-1002")
	w := workflowCall(t, a, "POST", "/api/cases/"+c.ID+"/investigate", nil, "", 200)
	var p Proposal
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil || p.Mode != "rules" || p.Action != "review_fees" || len(p.Trace) == 0 {
		t.Fatalf("invalid proposal: %s", w.Body.String())
	}
	if err := validateProposal(c, p); err != nil {
		t.Fatal(err)
	}
	note := ReviewRequest{c.Fingerprint, "Compared processor fees and the bank statement; awaiting clarification."}
	workflowCall(t, a, "POST", "/api/cases/"+c.ID+"/review", note, "", 200)
	reviewed := workflowState(t, a)
	workflowCall(t, a, "POST", "/api/cases/"+c.ID+"/review", note, "", 200)
	if !reflect.DeepEqual(reviewed, workflowState(t, a)) {
		t.Fatal("review retry duplicated effects")
	}
	reopened, err := newStore(context.Background(), "", a.store.path)
	if err != nil {
		t.Fatal(err)
	}
	a = &App{store: reopened, token: a.token}
	if !reflect.DeepEqual(reviewed, workflowState(t, a)) {
		t.Fatal("restart lost state")
	}
	saved := workflowCase(t, a, "PO-1002")
	if saved.Status != "reviewed" || saved.Kind != "amount_mismatch" || saved.Delta != -500 || saved.ReviewNote != note.Note || !reflect.DeepEqual(saved.Proposal, &p) {
		t.Fatal("review lost draft or changed financial facts")
	}
	if workflowActions(reviewed, "import.completed") != 2 || workflowActions(reviewed, "investigation.drafted") != 1 || workflowActions(reviewed, "case.reviewed") != 1 {
		t.Fatal("incorrect Activity history")
	}
	exported := workflowCall(t, a, "GET", "/api/export", nil, "", 200)
	if exported.Header().Get("Content-Disposition") != "attachment; filename=clearledger-evidence.json" {
		t.Fatal("wrong download name")
	}
	var evidence State
	if err := json.Unmarshal(exported.Body.Bytes(), &evidence); err != nil || !reflect.DeepEqual(evidence, reviewed) {
		t.Fatal("export differs from persisted state")
	}
	newBank := "id,payout,currency,date,gross_cents,fee_cents,description\nnew-deposit,PO-1002,USD,2026-09-13,500,0,Additional bank evidence\n"
	workflowCall(t, a, "POST", "/api/import", ImportRequest{"bank", newBank}, "new-bank-evidence", 200)
	changed := workflowCase(t, a, "PO-1002")
	if changed.Fingerprint == c.Fingerprint || changed.Status != "open" || changed.Proposal != nil || changed.ReviewNote != "" || changed.Kind != "ambiguous_deposit" {
		t.Fatal("new evidence did not invalidate prior conclusions")
	}
	beforeStale := workflowState(t, a)
	workflowCall(t, a, "POST", "/api/cases/"+c.ID+"/review", note, "", 409)
	if !reflect.DeepEqual(beforeStale, workflowState(t, a)) {
		t.Fatal("stale review mutated state")
	}
	workflowCall(t, a, "POST", "/api/cases/"+c.ID+"/investigate", nil, "", 200)
	workflowCall(t, a, "POST", "/api/cases/"+c.ID+"/review", ReviewRequest{changed.Fingerprint, note.Note}, "", 200)
}

func TestAPIWorkflowInvalidRequestsAreAtomic(t *testing.T) {
	a := workflowApp(t)
	workflowDemo(t, a)
	c := workflowCase(t, a, "PO-1002")
	before := workflowState(t, a)
	cases := []struct {
		path string
		body any
		key  string
		code int
	}{
		{"/api/demo", nil, "", 409},
		{"/api/import", ImportRequest{"bank", "wrong,header"}, "bad-header", 400},
		{"/api/import", ImportRequest{"processor", fixture(t, "processor")}, "short", 400},
		{"/api/import", ImportRequest{"bank", fixture(t, "bank")}, "demo-processor-v1", 409},
		{"/api/cases/" + c.ID + "/review", ReviewRequest{c.Fingerprint, "short"}, "", 400},
		{"/api/cases/" + c.ID + "/review", ReviewRequest{"old-evidence", "A sufficiently long review note."}, "", 409},
		{"/api/cases/missing/investigate", nil, "", 404},
		{"/api/cases/" + digest("PO-1001")[:16] + "/investigate", nil, "", 409},
	}
	for _, tc := range cases {
		workflowCall(t, a, "POST", tc.path, tc.body, tc.key, tc.code)
		if !reflect.DeepEqual(before, workflowState(t, a)) {
			t.Fatalf("%s mutated state", tc.path)
		}
	}
}

// The first model turn waits on a test-controlled gate. Later turns select the
// server-provided case, so multiple investigations can share this mock safely.
func workflowModel(t *testing.T) (*httptest.Server, <-chan struct{}, chan struct{}) {
	t.Helper()
	started := make(chan struct{}, 8)
	release := make(chan struct{})
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Messages []chatMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			http.Error(w, "bad request", 400)
			return
		}
		var current Case
		for _, m := range input.Messages {
			if m.Role == "tool" && m.ToolName == "get_case" {
				_ = json.Unmarshal([]byte(m.Content), &current)
			}
		}
		if current.ID == "" {
			started <- struct{}{}
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			writeJSON(w, 200, map[string]any{"message": chatMessage{Role: "assistant", ToolCalls: []toolCall{modelCall("get_case", map[string]any{}), modelCall("list_evidence", map[string]any{})}}})
		} else {
			writeJSON(w, 200, map[string]any{"message": chatMessage{Role: "assistant", ToolCalls: []toolCall{modelCall("propose_resolution", proposalArgs(current))}}})
		}
	}))
	t.Cleanup(model.Close)
	// Unblock the model even if an assertion fails.
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	return model, started, release
}

func workflowWait(t *testing.T, started <-chan struct{}) {
	t.Helper()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("model did not start")
	}
}

func workflowAsync(a *App, ctx context.Context, id string) <-chan *httptest.ResponseRecorder {
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- workflowRequest(a, ctx, "POST", "/api/cases/"+id+"/investigate", nil, "") }()
	return done
}

func workflowResult(t *testing.T, done <-chan *httptest.ResponseRecorder, want int) *httptest.ResponseRecorder {
	t.Helper()
	select {
	case w := <-done:
		if w.Code != want {
			t.Fatalf("investigation: %d, want %d: %s", w.Code, want, w.Body.String())
		}
		return w
	case <-time.After(5 * time.Second):
		t.Fatal("investigation did not finish")
	}
	return nil
}

func TestAPIInvestigationConcurrencyAndExplicitRerun(t *testing.T) {
	a := workflowApp(t)
	workflowDemo(t, a)
	model, started, release := workflowModel(t)
	a.agent = Investigator{model.URL, "workflow-test"}
	c := workflowCase(t, a, "PO-1002")
	first := workflowAsync(a, context.Background(), c.ID)
	workflowWait(t, started)
	duplicate := workflowCall(t, a, "POST", "/api/cases/"+c.ID+"/investigate", nil, "", 429)
	if duplicate.Header().Get("Retry-After") == "" {
		t.Fatal("busy response missing retry guidance")
	}
	second := workflowAsync(a, context.Background(), digest("PO-1003")[:16])
	workflowWait(t, started)
	workflowCall(t, a, "POST", "/api/cases/"+digest("PO-1004")[:16]+"/investigate", nil, "", 429)
	close(release)
	workflowResult(t, first, 200)
	workflowResult(t, second, 200)
	if workflowActions(workflowState(t, a), "investigation.drafted") != 2 {
		t.Fatal("duplicate request caused a draft effect")
	}
	workflowCall(t, a, "POST", "/api/cases/"+c.ID+"/investigate", nil, "", 200)
	if workflowActions(workflowState(t, a), "investigation.drafted") != 3 {
		t.Fatal("explicit rerun failed")
	}
}

func TestAPILateInvestigationCannotOverwriteChangedState(t *testing.T) {
	for _, change := range []string{"evidence", "review", "worker-draft"} {
		t.Run(change, func(t *testing.T) {
			a := workflowApp(t)
			workflowDemo(t, a)
			model, started, release := workflowModel(t)
			a.agent = Investigator{model.URL, "workflow-test"}
			c := workflowCase(t, a, "PO-1002")
			done := workflowAsync(a, context.Background(), c.ID)
			workflowWait(t, started)
			switch change {
			case "evidence":
				csv := "id,payout,currency,date,gross_cents,fee_cents,description\nextra,PO-1002,USD,2026-09-13,100,0,New evidence\n"
				workflowCall(t, a, "POST", "/api/import", ImportRequest{"bank", csv}, "during-investigation", 200)
			case "review":
				workflowCall(t, a, "POST", "/api/cases/"+c.ID+"/review", ReviewRequest{c.Fingerprint, "Reviewed while the investigation was still running."}, "", 200)
			case "worker-draft":
				worker := &App{store: a.store}
				if err := processEvent(context.Background(), worker, Event{"competing-worker", "reconciliation.completed", []string{c.ID}}); err != nil {
					t.Fatal(err)
				}
			}
			before := workflowState(t, a)
			close(release)
			workflowResult(t, done, 409)
			if !reflect.DeepEqual(before, workflowState(t, a)) {
				t.Fatal("late result overwrote newer state")
			}
		})
	}
}

func TestAPIModelFailureIsAuditedAndRetryable(t *testing.T) {
	a := workflowApp(t)
	workflowDemo(t, a)
	c := workflowCase(t, a, "PO-1002")
	// An existing checklist must survive a failed explicit model rerun.
	workflowCall(t, a, "POST", "/api/cases/"+c.ID+"/investigate", nil, "", 200)
	before := workflowCase(t, a, "PO-1002")
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "private model diagnostics", 503) }))
	defer model.Close()
	a.agent = Investigator{model.URL, "workflow-test"}
	response := workflowCall(t, a, "POST", "/api/cases/"+c.ID+"/investigate", nil, "", 502)
	if strings.Contains(response.Body.String(), "private") {
		t.Fatal("raw model details leaked")
	}
	after := workflowState(t, a)
	if !reflect.DeepEqual(before, workflowCase(t, a, "PO-1002")) || workflowActions(after, "investigation.failed") != 1 {
		t.Fatal("failure changed draft or omitted activity")
	}
	reopened, err := newStore(context.Background(), "", a.store.path)
	if err != nil {
		t.Fatal(err)
	}
	a = &App{store: reopened}
	if !reflect.DeepEqual(after, workflowState(t, a)) {
		t.Fatal("failure not persisted")
	}
	workflowCall(t, a, "POST", "/api/cases/"+c.ID+"/investigate", nil, "", 200)
}

func TestAPICanceledAndTimedOutInvestigationsLeaveNoDraft(t *testing.T) {
	for _, timeout := range []bool{false, true} {
		name := "canceled"
		if timeout {
			name = "timed out"
		}
		t.Run(name, func(t *testing.T) {
			a := workflowApp(t)
			workflowDemo(t, a)
			model, started, _ := workflowModel(t)
			a.agent = Investigator{model.URL, "workflow-test"}
			ctx, cancel := context.WithCancel(context.Background())
			if timeout {
				cancel()
				ctx, cancel = context.WithTimeout(context.Background(), time.Second)
			}
			defer cancel()
			id := digest("PO-1002")[:16]
			done := workflowAsync(a, ctx, id)
			workflowWait(t, started)
			if !timeout {
				cancel()
			}
			response := workflowResult(t, done, 502)
			if !strings.Contains(response.Body.String(), name) {
				t.Fatalf("wrong cancellation outcome: %s", response.Body.String())
			}
			s := workflowState(t, a)
			if workflowCase(t, a, "PO-1002").Proposal != nil || workflowActions(s, "investigation.failed") != 1 {
				t.Fatal("canceled request saved draft or lost failure")
			}
			a.agent = Investigator{}
			workflowCall(t, a, "POST", "/api/cases/"+id+"/investigate", nil, "", 200)
		})
	}
}

func TestAPIFailureAuditPersistenceErrorIsAtomic(t *testing.T) {
	a := workflowApp(t)
	workflowDemo(t, a)
	before := workflowState(t, a)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer model.Close()
	a.agent = Investigator{model.URL, "workflow-test"}
	savedPath := a.store.path
	a.store.path = t.TempDir()
	path := "/api/cases/" + digest("PO-1002")[:16] + "/investigate"
	workflowCall(t, a, "POST", path, nil, "", 500)
	if !reflect.DeepEqual(before, workflowState(t, a)) {
		t.Fatal("failed audit write changed state")
	}
	a.store.path = savedPath
	workflowCall(t, a, "POST", path, nil, "", 502)
	if workflowActions(workflowState(t, a), "investigation.failed") != 1 {
		t.Fatal("failed audit retry did not persist exactly one effect")
	}
}

func TestFileStoreCancellationRollsBackMutation(t *testing.T) {
	a := workflowApp(t)
	workflowDemo(t, a)
	before := workflowState(t, a)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err := a.store.update(ctx, func(s *State) error {
		s.Revision++
		cancel()
		return nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled write: %v", err)
	}
	if !reflect.DeepEqual(before, workflowState(t, a)) {
		t.Fatal("canceled mutation became visible")
	}
	reopened, err := newStore(context.Background(), "", a.store.path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, workflowState(t, &App{store: reopened})) {
		t.Fatal("canceled mutation persisted")
	}
	if _, err := a.store.read(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal("read ignored canceled context")
	}
}
