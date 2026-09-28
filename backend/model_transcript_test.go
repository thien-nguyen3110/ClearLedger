//go:build modeleval

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// Records one agent conversation through a logging proxy in front of Ollama, so a
// failure can be read turn by turn without changing the agent:
//
//	MODEL_EVAL_URL=http://127.0.0.1:11434 MODEL_EVAL_PAYOUT=MX:SYNTH-BATCH-AMOUNT-BREAK-000266 \
//	  go test -tags=modeleval -run TestModelTranscript -v .
func TestModelTranscript(t *testing.T) {
	upstream, payout := os.Getenv("MODEL_EVAL_URL"), os.Getenv("MODEL_EVAL_PAYOUT")
	if upstream == "" || payout == "" {
		t.Skip("MODEL_EVAL_URL and MODEL_EVAL_PAYOUT not set")
	}
	turn := 0
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		resp, err := http.Post(strings.TrimRight(upstream, "/")+r.URL.Path, "application/json", bytes.NewReader(body))
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		defer resp.Body.Close()
		out, _ := io.ReadAll(resp.Body)
		turn++
		var reply struct {
			Message struct {
				Content   string            `json:"content"`
				ToolCalls []json.RawMessage `json:"tool_calls"`
			} `json:"message"`
			DoneReason string `json:"done_reason"`
		}
		_ = json.Unmarshal(out, &reply)
		t.Logf("turn %d: done_reason=%s tool_calls=%d", turn, reply.DoneReason, len(reply.Message.ToolCalls))
		for _, c := range reply.Message.ToolCalls {
			t.Logf("  call %s", c)
		}
		if reply.Message.Content != "" {
			t.Logf("  content: %.1500s", reply.Message.Content)
		}
		w.WriteHeader(resp.StatusCode)
		w.Write(out)
	}))
	defer proxy.Close()
	s := evalState(t, map[string]string{"processor": "testdata/reconriver/mixed-exceptions/processor.csv", "bank": "testdata/reconriver/mixed-exceptions/bank.csv"})
	for _, c := range s.Cases {
		if c.Payout == payout {
			p, err := Investigator{URL: proxy.URL, Model: evalModel()}.run(context.Background(), c, s.Records)
			t.Logf("result: err=%v proposal=%+v", err, p)
			return
		}
	}
	t.Fatalf("payout %s not found", payout)
}

func evalModel() string {
	if m := os.Getenv("MODEL_EVAL_MODEL"); m != "" {
		return m
	}
	return "qwen3:4b-instruct-2507-q4_K_M"
}
