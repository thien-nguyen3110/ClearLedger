package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/segmentio/kafka-go"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestFailedInvestigationReplayDoesNotDuplicateAudit(t *testing.T) {
	ctx := context.Background()
	store, _ := newStore(ctx, "", "")
	store.update(ctx, func(s *State) error { *s = sample(t); return nil })
	badModel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer badModel.Close()
	a := &App{store: store, agent: Investigator{badModel.URL, "test"}}
	event := Event{ID: "failed-event", Type: "reconciliation.completed", CaseIDs: []string{digest("PO-1002")[:16]}}
	if e := processEvent(ctx, a, event); e != nil {
		t.Fatal(e)
	}
	first, _ := store.read(ctx)
	// Simulate stopping after the durable case effect but before the event receipt.
	store.update(ctx, func(s *State) error { delete(s.Processed, event.ID); return nil })
	if e := processEvent(ctx, a, event); e != nil {
		t.Fatal(e)
	}
	second, _ := store.read(ctx)
	if len(second.Audit) != len(first.Audit) || second.Revision != first.Revision {
		t.Fatal("replay duplicated failed investigation effects")
	}
	if !second.Processed[event.ID] {
		t.Fatal("missing event receipt")
	}
}

type fakeEventReader struct {
	messages           []kafka.Message
	fetched, committed int
	commitErr          error
}

func (r *fakeEventReader) FetchMessage(ctx context.Context) (kafka.Message, error) {
	if r.fetched == len(r.messages) {
		return kafka.Message{}, context.Canceled
	}
	m := r.messages[r.fetched]
	r.fetched++
	return m, nil
}
func (r *fakeEventReader) CommitMessages(ctx context.Context, msgs ...kafka.Message) error {
	r.committed += len(msgs)
	return r.commitErr
}
func failOnReject(t *testing.T) func(context.Context, kafka.Message, error) error {
	return func(_ context.Context, _ kafka.Message, cause error) error {
		t.Errorf("unexpected rejection: %v", cause)
		return nil
	}
}
func TestConsumerDoesNotAdvanceOnPersistenceFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := &fakeEventReader{messages: []kafka.Message{{Value: []byte(`{"id":"first","type":"reconciliation.completed","case_ids":[]}`)}, {Value: []byte(`{"id":"second","type":"reconciliation.completed","case_ids":[]}`)}}}
	calls := 0
	e := consumeMessages(ctx, r, func(ctx context.Context, event Event) error {
		calls++
		cancel()
		return errors.New("database write failed")
	}, failOnReject(t))
	if e == nil || calls != 1 || r.fetched != 1 || r.committed != 0 {
		t.Fatalf("advanced after failed persistence: %v %+v calls=%d", e, r, calls)
	}
}
func TestConsumerStopsAfterCommitFailure(t *testing.T) {
	value := []byte(`{"id":"first","type":"reconciliation.completed","case_ids":[]}`)
	r := &fakeEventReader{messages: []kafka.Message{{Value: value}, {Value: value}}, commitErr: errors.New("ack failed")}
	calls := 0
	e := consumeMessages(context.Background(), r, func(context.Context, Event) error { calls++; return nil }, failOnReject(t))
	if e == nil || r.fetched != 1 || calls != 1 || r.committed != 1 {
		t.Fatal("advanced past a failed acknowledgement")
	}
}

// A malformed or unsupported event is recorded, then acknowledged, so it cannot
// block every later event on the partition.
func TestConsumerRecordsInvalidEventsThenAdvances(t *testing.T) {
	ctx := context.Background()
	store, _ := newStore(ctx, "", "")
	store.update(ctx, func(s *State) error { *s = sample(t); return nil })
	a := &App{store: store}
	r := &fakeEventReader{messages: []kafka.Message{
		{Topic: topic, Offset: 1, Value: []byte("{")},
		{Topic: topic, Offset: 2, Value: []byte(`{"id":"x","type":"reconciliation.completed.v9","case_ids":[]}`)},
		{Topic: topic, Offset: 3, Value: []byte(`{"id":"good","type":"reconciliation.completed","case_ids":["` + digest("PO-1002")[:16] + `"]}`)},
	}}
	rejected := []int64{}
	e := consumeMessages(ctx, r, func(ctx context.Context, event Event) error { return processEvent(ctx, a, event) },
		func(ctx context.Context, m kafka.Message, cause error) error {
			if !errors.Is(cause, errInvalidEvent) {
				t.Errorf("offset %d: unexpected cause %v", m.Offset, cause)
			}
			rejected = append(rejected, m.Offset)
			return rejectEvent(ctx, store, m, cause)
		})
	if !errors.Is(e, context.Canceled) || r.committed != 3 || len(rejected) != 2 || rejected[0] != 1 || rejected[1] != 2 {
		t.Fatalf("invalid events not recorded and acknowledged: %v committed=%d rejected=%v", e, r.committed, rejected)
	}
	st, _ := store.read(ctx)
	count := 0
	for _, entry := range st.Audit {
		if entry.Action == "event.rejected" {
			count++
		}
	}
	good, _ := caseByID(st, digest("PO-1002")[:16])
	if count != 2 || !st.Processed["good"] || good.Proposal == nil {
		t.Fatalf("want 2 rejection entries and the valid event processed: rejected=%d processed=%v", count, st.Processed["good"])
	}
	// Redelivery of a rejected message (crash before the offset commit) adds nothing.
	if e = rejectEvent(ctx, store, kafka.Message{Topic: topic, Offset: 1, Value: []byte("{")}, errInvalidEvent); e != nil {
		t.Fatal(e)
	}
	after, _ := store.read(ctx)
	if len(after.Audit) != len(st.Audit) || after.Revision != st.Revision {
		t.Fatal("redelivered rejection duplicated its record")
	}
}
func TestConsumerRetriesRejectionUntilRecorded(t *testing.T) {
	r := &fakeEventReader{messages: []kafka.Message{{Value: []byte("not json")}}}
	attempts := 0
	consumeMessages(context.Background(), r, func(context.Context, Event) error {
		t.Error("malformed message reached processing")
		return nil
	}, func(context.Context, kafka.Message, error) error {
		attempts++
		if attempts == 1 {
			return errors.New("database write failed")
		}
		return nil
	})
	if attempts != 2 || r.fetched != 1 || r.committed != 1 {
		t.Fatalf("acknowledged before the rejection was recorded: attempts=%d committed=%d", attempts, r.committed)
	}
}
func TestConsumerRetriesSameMessageThenCommits(t *testing.T) {
	r := &fakeEventReader{messages: []kafka.Message{{Value: []byte(`{"id":"first","type":"reconciliation.completed","case_ids":[]}`)}}}
	calls := 0
	consumeMessages(context.Background(), r, func(context.Context, Event) error {
		calls++
		if calls == 1 {
			return errors.New("transient persistence failure")
		}
		return nil
	}, failOnReject(t))
	if calls != 2 || r.fetched != 1 || r.committed != 1 {
		t.Fatal("did not retry same message before committing")
	}
}

// 250 open cases in one event: every case gets a draft and replay is a no-op.
func TestWorkerBatchesLargeEvent(t *testing.T) {
	ctx := context.Background()
	store, _ := newStore(ctx, "", "")
	var csv strings.Builder
	csv.WriteString(csvHeader)
	for i := 0; i < 250; i++ {
		fmt.Fprintf(&csv, "ch_%d,PO-B%03d,USD,2026-01-02,1000,30,charge\n", i, i)
	}
	if e := store.update(ctx, func(s *State) error { return importRecords(s, "processor", csv.String(), "batch-import") }); e != nil {
		t.Fatal(e)
	}
	st, _ := store.read(ctx)
	ids := []string{}
	for _, c := range st.Cases {
		ids = append(ids, c.ID)
	}
	before := st.Revision
	event := Event{ID: "batch-event", Type: "reconciliation.completed", CaseIDs: ids}
	if e := processEvent(ctx, &App{store: store}, event); e != nil {
		t.Fatal(e)
	}
	st, _ = store.read(ctx)
	for _, c := range st.Cases {
		if c.Proposal == nil {
			t.Fatalf("%s has no draft", c.Payout)
		}
	}
	if st.Revision != before+250 || !st.Processed[event.ID] {
		t.Fatalf("revision %d -> %d, receipt=%v", before, st.Revision, st.Processed[event.ID])
	}
	if e := processEvent(ctx, &App{store: store}, event); e != nil {
		t.Fatal(e)
	}
	again, _ := store.read(ctx)
	if again.Revision != st.Revision {
		t.Fatal("replay changed state")
	}
}

// An outcome computed from an older snapshot is dropped if the case changed, and
// a proposal the server rejects becomes one recorded failure instead of an error
// that would make the consumer retry the event forever.
func TestWorkerOutcomesApplyOnlyToUnchangedCases(t *testing.T) {
	s := sample(t)
	c, _ := caseByID(s, digest("PO-1002")[:16])
	stale := c
	stale.Fingerprint = "older-evidence"
	bad := rulesProposal(c)
	bad.Action = "issue_refund"
	applyWorkerOutcomes(&s, []workerOutcome{
		{c: stale, failureKey: "failure:stale", proposal: rulesProposal(c)},
		{c: c, failureKey: "failure:bad", proposal: bad},
	})
	current, _ := caseByID(s, c.ID)
	if current.Proposal != nil || !s.Processed["failure:bad"] || s.Processed["failure:stale"] {
		t.Fatalf("unexpected outcome: proposal=%v processed=%v", current.Proposal, s.Processed)
	}
	last := s.Audit[len(s.Audit)-1]
	if last.Action != "investigation.failed" || strings.Contains(last.Detail, "issue_refund") {
		t.Fatalf("failure not recorded safely: %+v", last)
	}
	audits := len(s.Audit)
	applyWorkerOutcomes(&s, []workerOutcome{{c: c, failureKey: "failure:bad", proposal: bad}})
	if len(s.Audit) != audits {
		t.Fatal("repeated failure recorded twice")
	}
}
func TestEventPersistenceFailureLeavesNoReceipt(t *testing.T) {
	s, _ := newStore(context.Background(), "", "")
	s.update(context.Background(), func(st *State) error { *st = sample(t); return nil })
	s.path = t.TempDir()
	event := Event{"write-failure", "reconciliation.completed", []string{digest("PO-1002")[:16]}}
	if e := processEvent(context.Background(), &App{store: s}, event); e == nil {
		t.Fatal("expected failed persistence")
	}
	st, _ := s.read(context.Background())
	if st.Processed[event.ID] || st.Cases[1].Proposal != nil {
		t.Fatal("failed write has visible effects")
	}
	s.path = filepath.Join(t.TempDir(), "state.json")
	if e := processEvent(context.Background(), &App{store: s}, event); e != nil {
		t.Fatal(e)
	}
}
