//go:build integration

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

func testSuffix() string {
	var b [8]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b[:])
}
func integrationStore(t *testing.T) (*Store, string) {
	t.Helper()
	raw := os.Getenv("INTEGRATION_DATABASE_URL")
	if raw == "" {
		t.Skip("INTEGRATION_DATABASE_URL not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	admin, e := pgx.Connect(ctx, raw)
	if e != nil {
		t.Fatal(e)
	}
	schema := "clearledger_test_" + testSuffix()
	if _, e = admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); e != nil {
		admin.Close(ctx)
		t.Fatal(e)
	}
	u, e := url.Parse(raw)
	if e != nil {
		t.Fatal(e)
	}
	query := u.Query()
	query.Set("search_path", schema)
	u.RawQuery = query.Encode()
	s, e := newStore(ctx, u.String(), "")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		s.db.Close()
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, e := admin.Exec(cleanup, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); e != nil {
			t.Error(e)
		}
		admin.Close(cleanup)
	})
	return s, u.String()
}
func TestPostgresAtomicOutboxConcurrentImportsAndRestart(t *testing.T) {
	s, raw := integrationStore(t)
	ctx := context.Background()
	// A failure AFTER updating workspace_state but DURING event insertion must
	// roll the entire transaction back.
	_, e := s.db.Exec(ctx, `CREATE FUNCTION reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test outbox failure'; END $$;
 CREATE TRIGGER reject_event BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION reject_event();`)
	if e != nil {
		t.Fatal(e)
	}
	body := fixture(t, "processor")
	if e = s.update(ctx, func(st *State) error { return importRecords(st, "processor", body, "atomic-import") }); e == nil {
		t.Fatal("injected transaction failure accepted")
	}
	st, e := s.read(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if len(st.Records) != 0 || st.Revision != 0 || len(st.Imports) != 0 {
		t.Fatal("state persisted without outbox")
	}
	if _, e = s.db.Exec(ctx, "DROP TRIGGER reject_event ON outbox"); e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := s.update(ctx, func(st *State) error { return importRecords(st, "processor", body, "atomic-import") }); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	st, e = s.read(ctx)
	if e != nil {
		t.Fatal(e)
	}
	var count int
	if e = s.db.QueryRow(ctx, "SELECT count(*) FROM outbox").Scan(&count); e != nil {
		t.Fatal(e)
	}
	if len(st.Records) != 8 || st.Revision != 1 || count != 1 {
		t.Fatalf("duplicate effects: records=%d revision=%d outbox=%d", len(st.Records), st.Revision, count)
	}
	if e = s.update(ctx, func(st *State) error { return importRecords(st, "processor", body, "different-import-key") }); e != nil {
		t.Fatal(e)
	}
	conflict := csvHeader + "new,new,USD,2026-09-01,5,0,new\nch_101,PO-1001,USD,2026-09-01,999,0,conflict\n"
	if e = s.update(ctx, func(st *State) error { return importRecords(st, "processor", conflict, "conflict-import") }); !errors.Is(e, ErrConflict) {
		t.Fatal(e)
	}
	before, _ := s.read(ctx)
	reopened, e := newStore(ctx, raw, "")
	if e != nil {
		t.Fatal(e)
	}
	defer reopened.db.Close()
	after, e := reopened.read(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("new connection did not recover committed state")
	}
}
func integrationTopic(t *testing.T) (string, string) {
	t.Helper()
	brokers := os.Getenv("INTEGRATION_KAFKA_BROKERS")
	if brokers == "" {
		t.Skip("INTEGRATION_KAFKA_BROKERS not configured")
	}
	broker := strings.Split(brokers, ",")[0]
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	// kafka.Client negotiates API versions; Kafka 4 rejects the legacy
	// Conn.CreateTopics v0 request. Check transport and per-topic errors.
	client := &kafka.Client{Addr: kafka.TCP(broker), Timeout: 15 * time.Second}
	name := "clearledger-test-" + testSuffix()
	created, e := client.CreateTopics(ctx, &kafka.CreateTopicsRequest{Topics: []kafka.TopicConfig{{Topic: name, NumPartitions: 1, ReplicationFactor: 1}}})
	if e == nil {
		e = created.Errors[name]
	}
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		deleted, e := client.DeleteTopics(ctx, &kafka.DeleteTopicsRequest{Topics: []string{name}})
		if e == nil {
			e = deleted.Errors[name]
		}
		if e != nil {
			t.Error(e)
		}
	})
	return broker, name
}
func testWriter(broker, name string) *kafka.Writer {
	return &kafka.Writer{Addr: kafka.TCP(broker), Topic: name, RequiredAcks: kafka.RequireAll, WriteTimeout: 5 * time.Second, BatchTimeout: 10 * time.Millisecond, MaxAttempts: 3}
}
func TestPostgresOutboxBrokerAcknowledgmentAndReplay(t *testing.T) {
	s, _ := integrationStore(t)
	broker, name := integrationTopic(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if e := s.update(ctx, func(st *State) error {
		return importRecords(st, "processor", fixture(t, "processor"), "broker-ack-import")
	}); e != nil {
		t.Fatal(e)
	}
	writer := testWriter(broker, name)
	defer writer.Close()
	// Real broker accepts a message; SQL publication marker then fails.
	_, e := s.db.Exec(ctx, `CREATE FUNCTION reject_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test publication marker failure'; END $$;
 CREATE TRIGGER reject_publication BEFORE UPDATE ON outbox FOR EACH ROW EXECUTE FUNCTION reject_publication();`)
	if e != nil {
		t.Fatal(e)
	}
	if e = publishOne(ctx, s, writer); e == nil {
		t.Fatal("expected publication marker failure")
	}
	var count int
	if e = s.db.QueryRow(ctx, "SELECT count(*) FROM outbox WHERE published_at IS NULL").Scan(&count); e != nil || count != 1 {
		t.Fatal("failed marker lost pending event", e)
	}
	if _, e = s.db.Exec(ctx, "DROP TRIGGER reject_publication ON outbox"); e != nil {
		t.Fatal(e)
	}
	if e = publishOne(ctx, s, writer); e != nil {
		t.Fatal(e)
	}
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{broker}, Topic: name, Partition: 0, MinBytes: 1, MaxBytes: 1024 * 1024})
	defer reader.Close()
	a := &App{store: s}
	var first State
	var firstEvent string
	for i := 0; i < 2; i++ {
		msg, e := reader.ReadMessage(ctx)
		if e != nil {
			t.Fatal(e)
		}
		var event Event
		if e = json.Unmarshal(msg.Value, &event); e != nil {
			t.Fatal(e)
		}
		if i == 0 {
			firstEvent = event.ID
		} else if event.ID != firstEvent {
			t.Fatal("not a redelivery")
		}
		if e = processEvent(ctx, a, event); e != nil {
			t.Fatal(e)
		}
		st, e := s.read(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if i == 0 {
			first = st
		} else if !reflect.DeepEqual(first, st) {
			t.Fatal("broker redelivery duplicated effects")
		}
	}
}

func crashReader(broker, name, group string) *kafka.Reader {
	return kafka.NewReader(kafka.ReaderConfig{Brokers: []string{broker}, Topic: name, GroupID: group, StartOffset: kafka.FirstOffset, MinBytes: 1, MaxBytes: 1024 * 1024, CommitInterval: 0, SessionTimeout: 6 * time.Second, HeartbeatInterval: time.Second})
}

// Invoked only as an isolated child test process. Exit precisely after the
// PostgreSQL effect, before the parent consumer can acknowledge the Kafka offset.
func TestKafkaCrashHelper(t *testing.T) {
	if os.Getenv("CLEARLEDGER_CRASH_HELPER") != "1" {
		t.Skip("subprocess helper")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	s, e := newStore(ctx, os.Getenv("CLEARLEDGER_TEST_DATABASE"), "")
	if e != nil {
		t.Fatal(e)
	}
	reader := crashReader(os.Getenv("CLEARLEDGER_TEST_BROKER"), os.Getenv("CLEARLEDGER_TEST_TOPIC"), os.Getenv("CLEARLEDGER_TEST_GROUP"))
	if e := consumeMessages(ctx, reader, func(ctx context.Context, event Event) error {
		if e := processEvent(ctx, &App{store: s}, event); e != nil {
			return e
		}
		os.Exit(23)
		return nil
	}, func(ctx context.Context, m kafka.Message, cause error) error {
		return rejectEvent(ctx, s, m, cause)
	}); e != nil {
		t.Fatal(e)
	}
}
func TestKafkaWorkerProcessCrashBeforeOffsetCommit(t *testing.T) {
	s, raw := integrationStore(t)
	broker, name := integrationTopic(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if e := s.update(ctx, func(st *State) error {
		return importRecords(st, "processor", fixture(t, "processor"), "crash-test-import")
	}); e != nil {
		t.Fatal(e)
	}
	writer := testWriter(broker, name)
	defer writer.Close()
	if e := publishOne(ctx, s, writer); e != nil {
		t.Fatal(e)
	}
	group := "clearledger-test-" + testSuffix()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestKafkaCrashHelper$", "-test.v")
	cmd.Env = append(os.Environ(), "CLEARLEDGER_CRASH_HELPER=1", "CLEARLEDGER_TEST_DATABASE="+raw, "CLEARLEDGER_TEST_BROKER="+broker, "CLEARLEDGER_TEST_TOPIC="+name, "CLEARLEDGER_TEST_GROUP="+group)
	output, e := cmd.CombinedOutput()
	var exitErr *exec.ExitError
	if !errors.As(e, &exitErr) || exitErr.ExitCode() != 23 {
		t.Fatalf("worker did not reach crash point: %v %s", e, output)
	}
	before, e := s.read(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if len(before.Processed) != 1 {
		t.Fatal("child did not persist event receipt")
	}
	reader := crashReader(broker, name, group)
	defer reader.Close()
	msg, e := reader.FetchMessage(ctx)
	if e != nil {
		t.Fatal(e)
	}
	var event Event
	if e = json.Unmarshal(msg.Value, &event); e != nil {
		t.Fatal(e)
	}
	if !before.Processed[event.ID] {
		t.Fatal("did not replay crashed worker event")
	}
	if e = processEvent(ctx, &App{store: s}, event); e != nil {
		t.Fatal(e)
	}
	if e = reader.CommitMessages(ctx, msg); e != nil {
		t.Fatal(e)
	}
	after, e := s.read(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("process crash replay duplicated effects")
	}
}

// An API replica and the worker starting together on an empty database used to
// fail with a pg_type unique violation from concurrent CREATE TABLE IF NOT EXISTS.
func TestPostgresConcurrentSchemaInitialization(t *testing.T) {
	s, raw := integrationStore(t)
	ctx := context.Background()
	if _, e := s.db.Exec(ctx, "DROP TABLE workspace_state, outbox, event_rejections"); e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			x, e := newStore(ctx, raw, "")
			if e != nil {
				errs <- e
				return
			}
			x.db.Close()
		}()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Errorf("concurrent startup failed: %v", e)
	}
}

func TestPostgresEventRejectionIsDurableAndIdempotent(t *testing.T) {
	s, _ := integrationStore(t)
	ctx := context.Background()
	m := kafka.Message{Topic: topic, Partition: 0, Offset: 41, Value: []byte(`{"id":"x","type":"unknown"}`)}
	for i := 0; i < 2; i++ {
		if e := rejectEvent(ctx, s, m, fmt.Errorf("%w: unsupported type or ID", errInvalidEvent)); e != nil {
			t.Fatal(e)
		}
	}
	var rows int
	var payload []byte
	if e := s.db.QueryRow(ctx, "SELECT count(*) OVER (), payload FROM event_rejections WHERE kafka_offset=41").Scan(&rows, &payload); e != nil {
		t.Fatal(e)
	}
	st, e := s.read(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if rows != 1 || string(payload) != string(m.Value) || len(st.Audit) != 1 || st.Audit[0].Action != "event.rejected" || st.Revision != 1 {
		t.Fatalf("rejection not recorded exactly once: rows=%d audit=%+v revision=%d", rows, st.Audit, st.Revision)
	}
}

// At the 10,000-record capacity one import event lists 5,000 open cases. Before
// batching, the worker took about 377 ms per case (roughly 31 minutes).
func TestPostgresWorkerAtCapacity(t *testing.T) {
	s, _ := integrationStore(t)
	ctx := context.Background()
	var b strings.Builder
	b.WriteString(csvHeader)
	for i := 0; i < maxRecords; i++ {
		fmt.Fprintf(&b, "ch_%05d,PO-%05d,USD,2026-01-02,10000,290,Card charge for order %d\n", i, i/2, i)
	}
	if e := s.update(ctx, func(st *State) error { return importRecords(st, "processor", b.String(), "capacity-import") }); e != nil {
		t.Fatal(e)
	}
	var data []byte
	if e := s.db.QueryRow(ctx, "SELECT payload FROM outbox").Scan(&data); e != nil {
		t.Fatal(e)
	}
	var event Event
	if e := json.Unmarshal(data, &event); e != nil {
		t.Fatal(e)
	}
	start := time.Now()
	if e := processEvent(ctx, &App{store: s}, event); e != nil {
		t.Fatal(e)
	}
	t.Logf("worker drafted %d cases in %v (rules mode)", len(event.CaseIDs), time.Since(start))
	st, e := s.read(ctx)
	if e != nil {
		t.Fatal(e)
	}
	for _, c := range st.Cases {
		if c.Proposal == nil {
			t.Fatalf("%s has no draft", c.Payout)
		}
	}
	if len(st.Cases) != 5000 || !st.Processed[event.ID] {
		t.Fatalf("cases=%d receipt=%v", len(st.Cases), st.Processed[event.ID])
	}
}

func TestRedisRateLimitsAndFailureBoundary(t *testing.T) {
	raw := os.Getenv("INTEGRATION_REDIS_URL")
	if raw == "" {
		t.Skip("INTEGRATION_REDIS_URL not configured")
	}
	opt, e := redis.ParseURL(raw)
	if e != nil {
		t.Fatal(e)
	}
	if opt.DB != 15 {
		t.Fatal("integration limiter test requires reserved Redis database 15")
	}
	client := redis.NewClient(opt)
	defer client.Close()
	ctx := context.Background()
	key := "clearledger:investigations:minute"
	if e = client.Del(ctx, key).Err(); e != nil {
		t.Fatal(e)
	}
	defer client.Del(ctx, key)
	store, _ := newStore(ctx, "", "")
	store.update(ctx, func(st *State) error { *st = sample(t); return nil })
	a := &App{store: store, redis: client, slots: make(chan struct{}, 2)}
	path := "/api/cases/" + digest("PO-1002")[:16] + "/investigate"
	for i := 0; i < 11; i++ {
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, localRequest("POST", path, nil))
		want := 200
		if i == 10 {
			want = 429
		}
		if w.Code != want {
			t.Fatalf("request %d status %d, want %d", i, w.Code, want)
		}
	}
	ttl, e := client.TTL(ctx, key).Result()
	if e != nil || ttl <= 0 || ttl > time.Minute {
		t.Fatal("limiter expiration missing", ttl, e)
	}
	unavailable := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1", MaxRetries: -1, DialTimeout: 100 * time.Millisecond})
	defer unavailable.Close()
	a.redis = unavailable
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, localRequest("POST", path, nil))
	if w.Code != 503 {
		t.Fatal("unavailable limiter did not fail closed")
	}
	w = httptest.NewRecorder()
	a.routes().ServeHTTP(w, localRequest("GET", "/api/state", nil))
	if w.Code != 200 {
		t.Fatal("Redis failure blocked authoritative reads")
	}
}
