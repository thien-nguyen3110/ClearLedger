package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/segmentio/kafka-go"
	"log"
	"strings"
	"time"
)

const topic = "clearledger.reconciliation.v1"

func relay(ctx context.Context, s *Store, brokers string) {
	writer := &kafka.Writer{Addr: kafka.TCP(strings.Split(brokers, ",")...), Topic: topic, RequiredAcks: kafka.RequireAll, Balancer: &kafka.Hash{}, WriteTimeout: 5 * time.Second, AllowAutoTopicCreation: false}
	defer writer.Close()
	timer := time.NewTicker(time.Second)
	defer timer.Stop()
	prune := time.NewTicker(time.Hour)
	defer prune.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			// Drain the backlog (for example after a broker outage), not one event per tick.
			for ctx.Err() == nil {
				e := publishOne(ctx, s, writer)
				if e != nil {
					if !errors.Is(e, pgx.ErrNoRows) {
						log.Printf("outbox retry: %v", e)
					}
					break
				}
			}
		case <-prune.C:
			// Published rows are kept as long as the topic retains them (168 hours).
			if _, e := s.db.Exec(ctx, "DELETE FROM outbox WHERE published_at < now() - interval '7 days'"); e != nil {
				log.Printf("outbox prune: %v", e)
			}
		}
	}
}
func publishOne(ctx context.Context, s *Store, writer *kafka.Writer) error {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var id string
	var data []byte
	if e = tx.QueryRow(ctx, "SELECT id,payload FROM outbox WHERE published_at IS NULL ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED").Scan(&id, &data); e != nil {
		return e
	}
	if e = writer.WriteMessages(ctx, kafka.Message{Key: []byte("workspace-1"), Value: data}); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "UPDATE outbox SET published_at=now() WHERE id=$1", id); e != nil {
		return e
	}
	return tx.Commit(ctx)
}

// errInvalidEvent marks an event that can never be processed. The consumer records
// it durably and acknowledges it instead of retrying it forever or stopping.
var errInvalidEvent = errors.New("invalid reconciliation event")

// Each save rewrites the whole workspace aggregate, so worker outcomes are saved
// in batches: one write per case made a 5,000-case import take about 30 minutes.
// The time bound keeps slow model runs persisting about one case at a time.
const (
	workerBatchSize     = 500
	workerFlushInterval = 2 * time.Second
)

type workerOutcome struct {
	c          Case
	failureKey string
	proposal   Proposal
	err        error
}

func processEvent(ctx context.Context, a *App, event Event) error {
	if event.ID == "" || len(event.ID) > 128 || strings.HasPrefix(event.ID, "failure:") || strings.HasPrefix(event.ID, "rejected:") || event.Type != "reconciliation.completed" || len(event.CaseIDs) > maxRecords {
		return fmt.Errorf("%w: unsupported type or ID", errInvalidEvent)
	}
	seen := map[string]bool{}
	for _, id := range event.CaseIDs {
		if id == "" || len(id) > 128 || seen[id] {
			return fmt.Errorf("%w: empty, oversized or repeated case ID", errInvalidEvent)
		}
		seen[id] = true
	}
	snapshot, e := a.store.read(ctx)
	if e != nil {
		return e
	}
	if snapshot.Processed[event.ID] {
		return nil
	}
	cases := casesByID(snapshot)
	pending := []workerOutcome{}
	batchStart := time.Now()
	for _, id := range event.CaseIDs {
		c, ok := cases[id]
		if !ok || c.Status != "open" || c.Proposal != nil {
			continue
		}
		failureKey := "failure:" + digest(event.ID+"\n"+id+"\n"+c.Fingerprint)
		if snapshot.Processed[failureKey] {
			continue
		}
		p, agentErr := a.agent.run(ctx, c, snapshot.Records)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		pending = append(pending, workerOutcome{c, failureKey, p, agentErr})
		if len(pending) < workerBatchSize && time.Since(batchStart) < workerFlushInterval {
			continue
		}
		if e = a.store.update(ctx, func(s *State) error { applyWorkerOutcomes(s, pending); return nil }); e != nil {
			return e
		}
		pending = pending[:0]
		if snapshot, e = a.store.read(ctx); e != nil {
			return e
		}
		cases = casesByID(snapshot)
		batchStart = time.Now()
	}
	// The last outcomes and the event receipt commit together.
	return a.store.update(ctx, func(s *State) error {
		applyWorkerOutcomes(s, pending)
		s.Processed[event.ID] = true
		return nil
	})
}

func casesByID(s State) map[string]Case {
	out := make(map[string]Case, len(s.Cases))
	for _, c := range s.Cases {
		out[c.ID] = c
	}
	return out
}

// Outcomes computed from an older snapshot apply only if the case is unchanged:
// still open, same evidence, no newer draft, and no failure already recorded.
func applyWorkerOutcomes(s *State, outcomes []workerOutcome) {
	for _, o := range outcomes {
		current, err := caseByID(*s, o.c.ID)
		if err != nil || current.Status != "open" || current.Proposal != nil || current.Fingerprint != o.c.Fingerprint || s.Processed[o.failureKey] {
			continue
		}
		cause := o.err
		if cause == nil {
			if cause = saveProposal(s, o.c.ID, o.c.Fingerprint, o.proposal); cause == nil {
				continue
			}
		}
		// The failure receipt commits with its audit entry, so redelivery after a
		// crash cannot duplicate it. Raw model errors go to the worker log only.
		log.Printf("background investigation failed for %s: %v", o.c.Payout, cause)
		s.Processed[o.failureKey] = true
		s.audit("investigation.failed", o.c.Payout+": Background investigation failed. The case stays open; run it again from the case.")
		s.Revision++
	}
}

func consume(ctx context.Context, a *App, brokers string) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: strings.Split(brokers, ","), Topic: topic, GroupID: "clearledger-investigations-v1", MinBytes: 1, MaxBytes: 1024 * 1024, CommitInterval: 0})
	defer reader.Close()
	return consumeMessages(ctx, reader,
		func(ctx context.Context, event Event) error { return processEvent(ctx, a, event) },
		func(ctx context.Context, m kafka.Message, cause error) error {
			return rejectEvent(ctx, a.store, m, cause)
		})
}

type eventReader interface {
	FetchMessage(context.Context) (kafka.Message, error)
	CommitMessages(context.Context, ...kafka.Message) error
}

// Fetch another event only after the current event's durable effects and broker
// offset acknowledgment succeed. The interface makes crash boundaries testable.
// A permanently invalid event is recorded by reject, then acknowledged; if that
// record cannot be saved, the same message is retried like any persistence failure.
func consumeMessages(ctx context.Context, reader eventReader, process func(context.Context, Event) error, reject func(context.Context, kafka.Message, error) error) error {
	for {
		message, e := reader.FetchMessage(ctx)
		if e != nil {
			return e
		}
		// Retry the SAME fetched message on persistence failure; never advance past it.
		for {
			e = handleMessage(ctx, message, process, reject)
			if e == nil {
				break
			}
			log.Printf("event retry at %s/%d/%d: %v", message.Topic, message.Partition, message.Offset, e)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Second):
			}
		}
		if e = reader.CommitMessages(ctx, message); e != nil {
			return e
		}
	}
}

func handleMessage(ctx context.Context, message kafka.Message, process func(context.Context, Event) error, reject func(context.Context, kafka.Message, error) error) error {
	var event Event
	e := json.Unmarshal(message.Value, &event)
	if e != nil {
		e = fmt.Errorf("%w: malformed JSON", errInvalidEvent)
	} else {
		e = process(ctx, event)
	}
	if errors.Is(e, errInvalidEvent) {
		return reject(ctx, message, e)
	}
	return e
}

// rejectEvent keeps the payload in event_rejections and adds an Activity entry in
// one transaction. The receipt makes a redelivered rejection a no-op.
func rejectEvent(ctx context.Context, s *Store, m kafka.Message, cause error) error {
	receipt := fmt.Sprintf("rejected:%s/%d/%d", m.Topic, m.Partition, m.Offset)
	where := fmt.Sprintf("Kafka %s partition %d offset %d", m.Topic, m.Partition, m.Offset)
	log.Printf("event rejected: %s: %v", where, cause)
	return s.updateWith(ctx, func(st *State) error {
		if st.Processed[receipt] {
			return nil
		}
		st.Processed[receipt] = true
		st.audit("event.rejected", where+": "+cause.Error()+". No case was changed; the payload is kept for an operator.")
		st.Revision++
		return nil
	}, func(ctx context.Context, tx pgx.Tx) error {
		_, e := tx.Exec(ctx, "INSERT INTO event_rejections(receipt,topic,kafka_partition,kafka_offset,reason,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", receipt, m.Topic, m.Partition, m.Offset, cause.Error(), m.Value)
		return e
	})
}
