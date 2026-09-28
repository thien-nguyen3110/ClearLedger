package main

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"path/filepath"
	"sync"
)

// A bounded single-workspace aggregate is deliberate for v0. It serializes writes.
// PostgreSQL atomically stores the aggregate and outbox; normalize before scaling.
type Store struct {
	mu    sync.Mutex
	state State
	path  string
	db    *pgxpool.Pool
}

func newStore(ctx context.Context, url, path string) (*Store, error) {
	s := &Store{state: fresh(), path: path}
	if url != "" {
		db, e := pgxpool.New(ctx, url)
		if e != nil {
			return nil, e
		}
		s.db = db
		if e = initSchema(ctx, db); e != nil {
			db.Close()
			return nil, e
		}
		return s, nil
	}
	if path != "" {
		b, e := os.ReadFile(path)
		if e == nil {
			if e = json.Unmarshal(b, &s.state); e != nil {
				return nil, e
			}
		} else if !os.IsNotExist(e) {
			return nil, e
		}
	}
	return s, nil
}

// Arbitrary constant shared by every ClearLedger process using this database.
const schemaLockID = 7261001

// Concurrent CREATE ... IF NOT EXISTS statements can still collide in the system
// catalog (pg_type unique violation), so an API replica and the worker starting
// together on an empty database serialize schema setup on an advisory lock.
func initSchema(ctx context.Context, db *pgxpool.Pool) error {
	tx, e := db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", schemaLockID); e != nil {
		return e
	}
	_, e = tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS workspace_state(id integer PRIMARY KEY CHECK(id=1), body jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS outbox(id text PRIMARY KEY,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(created_at) WHERE published_at IS NULL;
CREATE TABLE IF NOT EXISTS event_rejections(receipt text PRIMARY KEY, topic text NOT NULL, kafka_partition integer NOT NULL, kafka_offset bigint NOT NULL, reason text NOT NULL, payload bytea NOT NULL, rejected_at timestamptz NOT NULL DEFAULT now());`)
	if e != nil {
		return e
	}
	body, _ := json.Marshal(fresh())
	if _, e = tx.Exec(ctx, "INSERT INTO workspace_state(id,body) VALUES(1,$1) ON CONFLICT DO NOTHING", body); e != nil {
		return e
	}
	return tx.Commit(ctx)
}

func clone(s State) State {
	b, _ := json.Marshal(s)
	var out State
	_ = json.Unmarshal(b, &out)
	return out
}
func (s *Store) read(ctx context.Context) (State, error) {
	if err := ctx.Err(); err != nil {
		return State{}, err
	}
	if s.db != nil {
		var b []byte
		e := s.db.QueryRow(ctx, "SELECT body FROM workspace_state WHERE id=1").Scan(&b)
		if e != nil {
			return State{}, e
		}
		var st State
		e = json.Unmarshal(b, &st)
		return st, e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return State{}, err
	}
	return clone(s.state), nil
}
func (s *Store) update(ctx context.Context, fn func(*State) error) error {
	return s.updateWith(ctx, fn, nil)
}

// updateWith also runs extra inside the same PostgreSQL transaction, after the
// aggregate and outbox writes. The local-file store has no tables, so it ignores extra.
func (s *Store) updateWith(ctx context.Context, fn func(*State) error, extra func(context.Context, pgx.Tx) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.db != nil {
		tx, e := s.db.Begin(ctx)
		if e != nil {
			return e
		}
		defer tx.Rollback(ctx)
		var b []byte
		if e = tx.QueryRow(ctx, "SELECT body FROM workspace_state WHERE id=1 FOR UPDATE").Scan(&b); e != nil {
			return e
		}
		var st State
		if e = json.Unmarshal(b, &st); e != nil {
			return e
		}
		if e = fn(&st); e != nil {
			return e
		}
		b, e = json.Marshal(st)
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "UPDATE workspace_state SET body=$1 WHERE id=1", b); e != nil {
			return e
		}
		for _, event := range st.Pending {
			body, _ := json.Marshal(event)
			if _, e = tx.Exec(ctx, "INSERT INTO outbox(id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING", event.ID, body); e != nil {
				return e
			}
		}
		if extra != nil {
			if e = extra(ctx, tx); e != nil {
				return e
			}
		}
		return tx.Commit(ctx)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	next := clone(s.state)
	if e := fn(&next); e != nil {
		return e
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.path != "" {
		if e := os.MkdirAll(filepath.Dir(s.path), 0700); e != nil {
			return e
		}
		b, e := json.Marshal(next)
		if e != nil {
			return e
		}
		f, e := os.CreateTemp(filepath.Dir(s.path), ".clearledger-*")
		if e != nil {
			return e
		}
		name := f.Name()
		defer os.Remove(name)
		if _, e = f.Write(b); e != nil {
			f.Close()
			return e
		}
		if e = f.Sync(); e != nil {
			f.Close()
			return e
		}
		if e = f.Close(); e != nil {
			return e
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if e = os.Rename(name, s.path); e != nil {
			return e
		}
	}
	next.Pending = nil
	s.state = next
	return nil
}
