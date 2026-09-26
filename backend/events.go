package main

import (
	"context"
	"encoding/json"
	"errors"
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
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			e := publishOne(ctx, s, writer)
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				log.Printf("outbox retry: %v", e)
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
func processEvent(ctx context.Context, a *App, event Event) error {
	snapshot, e := a.store.read(ctx)
	if e != nil {
		return e
	}
	if snapshot.Processed[event.ID] {
		return nil
	}
	if event.ID == "" || event.Type != "reconciliation.completed" {
		return errors.New("invalid reconciliation event")
	}
	for _, id := range event.CaseIDs {
		snapshot, e = a.store.read(ctx)
		if e != nil {
			return e
		}
		c, e := caseByID(snapshot, id)
		if e != nil || c.Status != "open" || c.Proposal != nil {
			continue
		}
		p, agentErr := a.agent.run(ctx, c, snapshot.Records)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		e = a.store.update(ctx, func(s *State) error {
			if agentErr != nil {
				s.audit("investigation.failed", c.Payout+": "+agentErr.Error())
				s.Revision++
				return nil
			}
			current, e := caseByID(*s, id)
			if e != nil || current.Status != "open" || current.Proposal != nil || current.Fingerprint != c.Fingerprint {
				return nil
			}
			return saveProposal(s, id, c.Fingerprint, p)
		})
		if e != nil {
			return e
		}
	}
	return a.store.update(ctx, func(s *State) error { s.Processed[event.ID] = true; return nil })
}
func consume(ctx context.Context, a *App, brokers string) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: strings.Split(brokers, ","), Topic: topic, GroupID: "clearledger-investigations-v1", MinBytes: 1, MaxBytes: 1024 * 1024, CommitInterval: 0})
	defer reader.Close()
	for {
		message, e := reader.FetchMessage(ctx)
		if e != nil {
			return e
		}
		var event Event
		if e = json.Unmarshal(message.Value, &event); e != nil {
			return e
		}
		// Retry the SAME fetched message on persistence failure; never advance past it.
		for {
			e = processEvent(ctx, a, event)
			if e == nil {
				break
			}
			log.Printf("event retry: %v", e)
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
