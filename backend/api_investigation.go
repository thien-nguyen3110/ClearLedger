package main

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"time"

	"github.com/redis/go-redis/v9"
)

// Leave time for persistence and an error response before the frontend's 45s
// deadline. Background worker investigations retain their separate 90s limit.
const interactiveInvestigationTimeout = 40 * time.Second

// Interactive duplicate requests are rejected before consuming model capacity
// or Redis quota. A later explicit rerun is allowed by the synchronous contract.
func (a *App) beginInvestigation(id string) string {
	a.investigationsMu.Lock()
	defer a.investigationsMu.Unlock()
	if a.investigations[id] {
		return "An investigation is already running for this payout. Try again shortly."
	}
	if a.slots == nil {
		a.slots = make(chan struct{}, 2)
	}
	select {
	case a.slots <- struct{}{}:
		if a.investigations == nil {
			a.investigations = make(map[string]bool)
		}
		a.investigations[id] = true
		return ""
	default:
		return "Two investigations are already running. Try again shortly."
	}
}

func (a *App) endInvestigation(id string) {
	a.investigationsMu.Lock()
	defer a.investigationsMu.Unlock()
	delete(a.investigations, id)
	<-a.slots
}

// A worker or another API process can finish while this request is running.
// Compare both evidence and the previous draft inside the store transaction so
// a late result cannot overwrite that newer draft or a human review.
func unchangedInvestigation(s State, started Case) error {
	current, err := caseByID(s, started.ID)
	if err != nil {
		return err
	}
	if current.Status != "open" || current.Fingerprint != started.Fingerprint || !reflect.DeepEqual(current.Proposal, started.Proposal) {
		return ErrConflict
	}
	return nil
}

func (a *App) handleInvestigation(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), interactiveInvestigationTimeout)
	defer cancel()
	s, err := a.store.read(ctx)
	if err != nil {
		fail(w, err)
		return
	}
	c, err := caseByID(s, r.PathValue("id"))
	if err != nil {
		fail(w, err)
		return
	}
	if c.Status != "open" {
		fail(w, ErrConflict)
		return
	}
	if message := a.beginInvestigation(c.ID); message != "" {
		w.Header().Set("Retry-After", "1")
		writeJSON(w, http.StatusTooManyRequests, ErrorResponse{Error: message})
		return
	}
	defer a.endInvestigation(c.ID)
	if a.redis != nil {
		script := redis.NewScript(`local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60) end;return n`)
		n, err := script.Run(ctx, a.redis, []string{"clearledger:investigations:minute"}).Int()
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, ErrorResponse{Error: "Investigation rate limiter unavailable"})
			return
		}
		if n > 10 {
			w.Header().Set("Retry-After", "60")
			writeJSON(w, http.StatusTooManyRequests, ErrorResponse{Error: "Investigation limit reached. Try again in one minute."})
			return
		}
	}
	p, err := a.agent.run(ctx, c, s.Records)
	if ctx.Err() != nil {
		err = ctx.Err()
	}
	if err != nil {
		a.recordInvestigationFailure(w, r, c, err)
		return
	}
	err = a.store.update(ctx, func(s *State) error {
		if err := unchangedInvestigation(*s, c); err != nil {
			return err
		}
		return saveProposal(s, c.ID, c.Fingerprint, p)
	})
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			a.recordInvestigationFailure(w, r, c, err)
		} else {
			fail(w, err)
		}
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (a *App) recordInvestigationFailure(w http.ResponseWriter, r *http.Request, c Case, cause error) {
	message := "Investigation failed. Check the local model and try again."
	if errors.Is(cause, context.Canceled) {
		message = "Investigation canceled. Refresh the case before trying again."
	} else if errors.Is(cause, context.DeadlineExceeded) {
		message = "Investigation timed out. Refresh the case before trying again."
	}
	// A disconnected browser cancels inference, but the failure must still appear
	// in Activity. Bound this separate audit write and never store raw model errors.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 2*time.Second)
	defer cancel()
	err := a.store.update(ctx, func(s *State) error {
		if err := unchangedInvestigation(*s, c); err != nil {
			return err
		}
		s.audit("investigation.failed", c.Payout+": "+message)
		s.Revision++
		return nil
	})
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusBadGateway, ErrorResponse{Error: message})
}
