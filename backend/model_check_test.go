package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestModelAvailabilityCheck(t *testing.T) {
	for _, tc := range []struct {
		name, body, model string
		status            int
		wantOK            bool
	}{
		{"installed", `{"models":[{"name":"qwen3:4b","digest":"opaque"}]}`, "qwen3:4b", 200, true},
		{"latest alias", `{"models":[{"model":"qwen3:latest"}]}`, "qwen3", 200, true},
		{"remote alias", `{"models":[{"name":"qwen3:4b","remote_model":"remote-alias"}]}`, "qwen3:4b", 200, false},
		{"remote host", `{"models":[{"name":"qwen3:4b","remote_host":"https://example.invalid"}]}`, "qwen3:4b", 200, false},
		{"wrong size", `{"models":[{"name":"qwen3:8b"}]}`, "qwen3:4b", 200, false},
		{"none installed", `{"models":[]}`, "qwen3:4b", 200, false},
		{"not Ollama", `<html>PRIVATE_SENTINEL</html>`, "qwen3:4b", 200, false},
		{"missing shape", `{}`, "qwen3:4b", 200, false},
		{"null shape", `{"models":null}`, "qwen3:4b", 200, false},
		{"HTTP failure", "PRIVATE_SENTINEL", "qwen3:4b", 503, false},
		{"too large", strings.Repeat("x", 1024*1024+1), "qwen3:4b", 200, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "GET" || r.URL.Path != "/api/tags" || r.ContentLength > 0 || r.Header.Get("Authorization") != "" {
					t.Error("model check sent more than an anonymous tags GET")
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			var output bytes.Buffer
			err := checkLocalModel(context.Background(), server.URL, tc.model, &output)
			if (err == nil) != tc.wantOK {
				t.Fatalf("wantOK=%v: %v", tc.wantOK, err)
			}
			if err != nil && strings.Contains(err.Error(), "PRIVATE_SENTINEL") {
				t.Fatal("server data leaked")
			}
			if calls.Load() != 1 {
				t.Fatal("unexpected model requests", calls.Load())
			}
			if tc.wantOK && !strings.Contains(output.String(), "No inference") {
				t.Fatal("availability overstated")
			}
		})
	}
}

func TestModelCheckRefusesRedirectAndHonorsCancellation(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer server.Close()
	var output bytes.Buffer
	if err := checkLocalModel(context.Background(), server.URL, "qwen3:4b", &output); err == nil {
		t.Fatal("redirect accepted")
	}
	if redirected.Load() != 0 {
		t.Fatal("followed redirect")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := checkLocalModel(ctx, server.URL, "qwen3:4b", &output); err == nil {
		t.Fatal("canceled check succeeded")
	}
}
