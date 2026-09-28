package main

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
)

const csvHeader = "id,payout,currency,date,gross_cents,fee_cents,description\n"

func TestDuplicateRowsAndConflictingBatch(t *testing.T) {
	row := "x,p,USD,2026-09-01,100,0,one\n"
	s := fresh()
	if e := importRecords(&s, "processor", csvHeader+row+row, "same-rows"); e != nil {
		t.Fatal(e)
	}
	if len(s.Records) != 1 || s.Cases[0].Expected != 100 {
		t.Fatal("identical duplicate counted twice")
	}
	before := clone(s)
	if e := importRecords(&s, "processor", csvHeader+"new,q,USD,2026-09-01,200,0,new\n"+row+"x,p,USD,2026-09-01,101,0,changed\n", "bad-batch"); !errors.Is(e, ErrConflict) {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(before, clone(s)) {
		t.Fatal("partial conflicting batch applied")
	}
	if e := importRecords(&s, "processor", csvHeader+row, "other-key"); e != nil {
		t.Fatal(e)
	}
	if s.Revision != before.Revision || len(s.Audit) != len(before.Audit) {
		t.Fatal("reimport has duplicate business effects")
	}
}
func TestConcurrentDistinctKeysStillDeduplicate(t *testing.T) {
	ctx := context.Background()
	s, _ := newStore(ctx, "", "")
	csv := fixture(t, "processor")
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if e := s.update(ctx, func(st *State) error { return importRecords(st, "processor", csv, fmt.Sprintf("request-%03d", i)) }); e != nil {
				t.Error(e)
			}
		}(i)
	}
	wg.Wait()
	st, _ := s.read(ctx)
	if len(st.Records) != 8 || st.Revision != 1 || len(st.Imports) != 20 {
		t.Fatal("distinct request keys duplicated records")
	}
}
func TestQuotedCSVAndBounds(t *testing.T) {
	rows, e := parseCSV("processor", csvHeader+"refund,p,USD,2026-09-01,-100,5,\"refund, with\nnew line\"\n")
	if e != nil || len(rows) != 1 || rows[0].Description != "refund, with\nnew line" {
		t.Fatalf("quoted CSV broken: %v", e)
	}
	for _, body := range []string{
		"x,p,USD,2026-09-01,100,1,bank fee\n",
		"x,p,USD,2026-09-01,100000000001,0,too big\n",
		"x,p,USD,2026-09-01,-100000000001,0,too small\n",
	} {
		if _, e := parseCSV("bank", csvHeader+body); e == nil {
			t.Fatal("accepted invalid bank row")
		}
	}
	var b strings.Builder
	b.WriteString(csvHeader)
	for i := 0; i < maxRecords; i++ {
		fmt.Fprintf(&b, "%d,p,USD,2026-09-01,-100000000000,100000000000,max\n", i)
	}
	s := fresh()
	if e := importRecords(&s, "processor", b.String(), "maximum-rows"); e != nil {
		t.Fatal(e)
	}
	if s.Cases[0].Expected != -2000000000000000 || s.Cases[0].Delta != 2000000000000000 {
		t.Fatal("maximum sums not exact")
	}
	if e := importRecords(&s, "processor", csvHeader+"extra,p,USD,2026-09-01,1,0,extra\n", "capacity-limit"); !errors.Is(e, ErrInvalid) {
		t.Fatal("accepted over-capacity workspace", e)
	}
}
func TestNewEvidenceInvalidatesDraftAndStaleSave(t *testing.T) {
	s := sample(t)
	c, _ := caseByID(s, digest("PO-1002")[:16])
	p := rulesProposal(c)
	if e := saveProposal(&s, c.ID, c.Fingerprint, p); e != nil {
		t.Fatal(e)
	}
	if e := importRecords(&s, "processor", csvHeader+"newfee,PO-1002,USD,2026-09-02,0,500,Additional documented fee\n", "new-fee-evidence"); e != nil {
		t.Fatal(e)
	}
	current, _ := caseByID(s, c.ID)
	if current.Kind != "matched" || current.Status != "matched" || current.Proposal != nil || current.Fingerprint == c.Fingerprint {
		t.Fatal("new evidence did not invalidate old draft")
	}
	if e := saveProposal(&s, c.ID, c.Fingerprint, p); !errors.Is(e, ErrConflict) {
		t.Fatal("stale agent write accepted", e)
	}
}
