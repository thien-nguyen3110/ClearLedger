package main

import (
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Curated ReconRiver fixtures (CC BY 4.0, see testdata/reconriver/ATTRIBUTION.txt): every
// kept payout must reconcile to its source ground-truth kind and delta to the cent.
// Regenerate with `node scripts/reconriver.mjs curate`; never edit the files by hand.
func TestReconRiverCuratedFixturesMatchGroundTruth(t *testing.T) {
	for _, scenario := range []string{"clean-settlement", "mixed-exceptions"} {
		t.Run(scenario, func(t *testing.T) {
			dir := filepath.Join("testdata", "reconriver", scenario)
			var manifest struct {
				CuratedSHA256 map[string]string `json:"curated_sha256"`
			}
			raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
			if err != nil {
				t.Fatal(err)
			}
			if err = json.Unmarshal(raw, &manifest); err != nil {
				t.Fatal(err)
			}
			read := func(name string) string {
				b, err := os.ReadFile(filepath.Join(dir, name))
				if err != nil {
					t.Fatal(err)
				}
				sum := sha256.Sum256(b)
				if hex.EncodeToString(sum[:]) != manifest.CuratedSHA256[name] {
					t.Fatalf("%s differs from its manifest checksum; regenerate instead of editing", name)
				}
				return string(b)
			}
			s := fresh()
			for _, source := range []string{"processor", "bank"} {
				if err := importRecords(&s, source, read(source+".csv"), "reconriver-"+scenario+"-"+source); err != nil {
					t.Fatalf("%s import: %v", source, err)
				}
			}
			rows, err := csv.NewReader(strings.NewReader(read("labels.csv"))).ReadAll()
			if err != nil {
				t.Fatal(err)
			}
			cases := map[string]Case{}
			for _, c := range s.Cases {
				cases[c.Payout] = c
			}
			labels := rows[1:]
			if len(labels) == 0 || len(cases) != len(labels) {
				t.Fatalf("%d cases for %d labeled payouts", len(cases), len(labels))
			}
			for _, l := range labels {
				c, ok := cases[l[0]]
				want, _ := strconv.ParseInt(l[2], 10, 64)
				if !ok || c.Kind != l[1] || c.Delta != want {
					t.Errorf("%s: want %s delta %d (source %s), got %+v", l[0], l[1], want, l[3], c)
				}
			}
		})
	}
}
