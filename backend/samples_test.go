package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The tests assert on the seven hand-written payouts in testdata/samples, not on the
// dataset that /api/demo serves from the repository samples directory.
func TestMain(m *testing.M) {
	os.Setenv("SAMPLE_DIR", filepath.Join("testdata", "samples"))
	os.Exit(m.Run())
}
