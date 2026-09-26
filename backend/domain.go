package main

import (
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"
)

const maxRecords = 10000

var ErrConflict = errors.New("conflict: record or case changed")
var ErrMissing = errors.New("case not found")

type Record struct {
	ID          string `json:"id"`
	Source      string `json:"source"`
	Payout      string `json:"payout"`
	Currency    string `json:"currency"`
	Date        string `json:"date"`
	Gross       int64  `json:"gross_cents"`
	Fee         int64  `json:"fee_cents"`
	Description string `json:"description"`
}
type Proposal struct {
	Mode     string   `json:"mode"`
	Summary  string   `json:"summary"`
	Action   string   `json:"action"`
	Evidence []string `json:"evidence"`
	Trace    []string `json:"trace"`
}
type Case struct {
	ID          string    `json:"id"`
	Payout      string    `json:"payout"`
	Currency    string    `json:"currency"`
	Expected    int64     `json:"expected_cents"`
	Actual      int64     `json:"actual_cents"`
	Delta       int64     `json:"delta_cents"`
	Kind        string    `json:"kind"`
	Status      string    `json:"status"`
	Fingerprint string    `json:"fingerprint"`
	Evidence    []string  `json:"evidence"`
	Proposal    *Proposal `json:"proposal,omitempty"`
	ReviewNote  string    `json:"review_note,omitempty"`
}
type Audit struct {
	At     string `json:"at"`
	Action string `json:"action"`
	Detail string `json:"detail"`
}
type Event struct {
	ID      string   `json:"id"`
	Type    string   `json:"type"`
	CaseIDs []string `json:"case_ids"`
}
type State struct {
	Revision  int               `json:"revision"`
	Records   map[string]Record `json:"records"`
	Cases     []Case            `json:"cases"`
	Audit     []Audit           `json:"audit"`
	Imports   map[string]string `json:"imports"`
	Processed map[string]bool   `json:"processed"`
	Pending   []Event           `json:"-"`
}

func fresh() State {
	return State{Records: map[string]Record{}, Cases: []Case{}, Audit: []Audit{}, Imports: map[string]string{}, Processed: map[string]bool{}}
}
func digest(v string) string { d := sha256.Sum256([]byte(v)); return hex.EncodeToString(d[:]) }
func (s *State) audit(action, detail string) {
	s.Audit = append(s.Audit, Audit{time.Now().UTC().Format(time.RFC3339), action, detail})
}
func parseCSV(source, body string) ([]Record, error) {
	if source != "processor" && source != "bank" {
		return nil, errors.New("source must be processor or bank")
	}
	reader := csv.NewReader(strings.NewReader(strings.TrimPrefix(body, "\ufeff")))
	head, err := reader.Read()
	if err != nil {
		return nil, errors.New("CSV header missing")
	}
	required := []string{"id", "payout", "currency", "date", "gross_cents", "fee_cents", "description"}
	if strings.Join(head, ",") != strings.Join(required, ",") {
		return nil, fmt.Errorf("CSV header must be %s", strings.Join(required, ","))
	}
	result := []Record{}
	for line := 2; ; line++ {
		row, e := reader.Read()
		if e == io.EOF {
			break
		}
		if e != nil {
			return nil, fmt.Errorf("row %d: %w", line, e)
		}
		if len(result) >= maxRecords {
			return nil, errors.New("maximum 10000 rows per import")
		}
		for i := range row {
			row[i] = strings.TrimSpace(row[i])
		}
		if row[0] == "" || row[1] == "" || len(row[0]) > 100 || len(row[1]) > 100 {
			return nil, fmt.Errorf("row %d: id and payout required, max 100 characters", line)
		}
		if row[2] != "USD" {
			return nil, fmt.Errorf("row %d: this release supports USD only", line)
		}
		if _, e = time.Parse("2006-01-02", row[3]); e != nil {
			return nil, fmt.Errorf("row %d: date must be YYYY-MM-DD", line)
		}
		gross, e := strconv.ParseInt(row[4], 10, 64)
		if e != nil || gross > 100000000000 || gross < -100000000000 {
			return nil, fmt.Errorf("row %d: invalid gross integer cents", line)
		}
		fee, e := strconv.ParseInt(row[5], 10, 64)
		if e != nil || fee > 100000000000 || fee < 0 {
			return nil, fmt.Errorf("row %d: invalid fee integer cents", line)
		}
		if source == "bank" && fee != 0 {
			return nil, fmt.Errorf("row %d: bank fee_cents must be 0", line)
		}
		if len(row[6]) > 1000 {
			return nil, fmt.Errorf("row %d: description too long", line)
		}
		result = append(result, Record{source + ":" + row[0], source, row[1], row[2], row[3], gross, fee, row[6]})
	}
	if len(result) == 0 {
		return nil, errors.New("CSV has no data rows")
	}
	return result, nil
}
func importRecords(s *State, source, body, key string) error {
	if len(key) < 8 || len(key) > 128 {
		return errors.New("Idempotency-Key must contain 8 to 128 characters")
	}
	hash := digest(source + "\n" + body)
	if previous, ok := s.Imports[key]; ok {
		if previous == hash {
			return nil
		}
		return ErrConflict
	}
	records, err := parseCSV(source, body)
	if err != nil {
		return err
	}
	// Validate the full batch before applying anything, including conflicts inside it.
	incoming := map[string]Record{}
	for _, r := range records {
		if old, ok := s.Records[r.ID]; ok && old != r {
			return fmt.Errorf("%w: %s", ErrConflict, r.ID)
		}
		if old, ok := incoming[r.ID]; ok && old != r {
			return fmt.Errorf("%w: %s", ErrConflict, r.ID)
		}
		incoming[r.ID] = r
	}
	added := 0
	for id := range incoming {
		if _, ok := s.Records[id]; !ok {
			added++
		}
	}
	if len(s.Records)+added > maxRecords {
		return errors.New("workspace capacity is 10000 records in this release")
	}
	for id, r := range incoming {
		s.Records[id] = r
	}
	s.Imports[key] = hash
	if added == 0 {
		return nil
	}
	reconcile(s)
	s.Revision++
	s.audit("import.completed", fmt.Sprintf("%s: %d new records", source, added))
	ids := []string{}
	for _, c := range s.Cases {
		if c.Status == "open" && c.Proposal == nil {
			ids = append(ids, c.ID)
		}
	}
	s.Pending = append(s.Pending, Event{digest(fmt.Sprintf("%d:%s", s.Revision, hash)), "reconciliation.completed", ids})
	return nil
}
func reconcile(s *State) {
	groups := map[string][]Record{}
	for _, r := range s.Records {
		groups[r.Payout] = append(groups[r.Payout], r)
	}
	old := map[string]Case{}
	for _, c := range s.Cases {
		old[c.ID] = c
	}
	out := []Case{}
	for payout, rs := range groups {
		sort.Slice(rs, func(i, j int) bool { return rs[i].ID < rs[j].ID })
		c := Case{ID: digest(payout)[:16], Payout: payout, Currency: "USD", Status: "open", Evidence: []string{}}
		banks, processor := 0, 0
		for _, r := range rs {
			c.Evidence = append(c.Evidence, r.ID)
			if r.Source == "bank" {
				banks++
				c.Actual += r.Gross
			} else {
				processor++
				c.Expected += r.Gross - r.Fee
			}
		}
		c.Delta = c.Actual - c.Expected
		switch {
		case banks > 1:
			c.Kind = "ambiguous_deposit"
		case processor == 0:
			c.Kind = "unexpected_deposit"
		case banks == 0:
			c.Kind = "awaiting_deposit"
		case c.Delta != 0:
			c.Kind = "amount_mismatch"
		default:
			c.Kind = "matched"
			c.Status = "matched"
		}
		encoded, _ := json.Marshal(rs)
		c.Fingerprint = digest(string(encoded))
		if previous, ok := old[c.ID]; ok && previous.Fingerprint == c.Fingerprint {
			c.Proposal = previous.Proposal
			c.ReviewNote = previous.ReviewNote
			if previous.Status == "reviewed" {
				c.Status = "reviewed"
			}
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Payout < out[j].Payout })
	s.Cases = out
}
func caseByID(s State, id string) (Case, error) {
	for _, c := range s.Cases {
		if c.ID == id {
			return c, nil
		}
	}
	return Case{}, ErrMissing
}
func validateProposal(c Case, p Proposal) error {
	if len(p.Summary) < 10 || len(p.Summary) > 2000 {
		return errors.New("proposal summary must contain 10 to 2000 characters")
	}
	switch p.Action {
	case "request_statement", "review_fees", "check_duplicate", "request_processor_detail":
	default:
		return errors.New("action is not allowed")
	}
	if len(p.Evidence) == 0 {
		return errors.New("proposal must cite evidence")
	}
	allowed := map[string]bool{}
	for _, id := range c.Evidence {
		allowed[id] = true
	}
	for _, id := range p.Evidence {
		if !allowed[id] {
			return errors.New("proposal cites evidence outside this case")
		}
	}
	return nil
}
func saveProposal(s *State, id, fp string, p Proposal) error {
	for i, c := range s.Cases {
		if c.ID == id {
			if c.Fingerprint != fp || c.Status != "open" {
				return ErrConflict
			}
			if err := validateProposal(c, p); err != nil {
				return err
			}
			s.Cases[i].Proposal = &p
			s.Revision++
			s.audit("investigation.drafted", c.Payout+": "+p.Mode)
			return nil
		}
	}
	return ErrMissing
}
func reviewCase(s *State, id, fp, note string) error {
	if len(strings.TrimSpace(note)) < 10 || len(note) > 1000 {
		return errors.New("review note must contain 10 to 1000 characters")
	}
	for i, c := range s.Cases {
		if c.ID == id {
			if c.Fingerprint != fp {
				return ErrConflict
			}
			if c.Status == "reviewed" && c.ReviewNote == note {
				return nil
			}
			if c.Status != "open" {
				return ErrConflict
			}
			s.Cases[i].Status = "reviewed"
			s.Cases[i].ReviewNote = note
			s.Revision++
			s.audit("case.reviewed", c.Payout+": "+note)
			return nil
		}
	}
	return ErrMissing
}
