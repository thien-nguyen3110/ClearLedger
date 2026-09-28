package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// This optional check sends no case evidence, does not download/load a model,
// and does not claim tool-call quality or successful inference.
func checkLocalModel(ctx context.Context, base, model string, out io.Writer) error {
	if err := validateModelURL(base); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(base, "/")+"/api/tags", nil)
	if err != nil {
		return errors.New("could not create the Ollama model check")
	}
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return errors.New("Ollama model check unavailable or timed out; start the local server and check OLLAMA_URL")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Ollama model check returned HTTP %d; check the local server", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024+1))
	if err != nil || len(data) > 1024*1024 {
		return errors.New("Ollama model list could not be read within the 1 MiB limit")
	}
	var result struct {
		Models *[]struct {
			Name        string `json:"name"`
			Model       string `json:"model"`
			RemoteModel string `json:"remote_model"`
			RemoteHost  string `json:"remote_host"`
		} `json:"models"`
	}
	if err := json.Unmarshal(data, &result); err != nil || result.Models == nil {
		return errors.New("Ollama returned an invalid model list")
	}
	canonical := func(name string) string {
		last := name[strings.LastIndex(name, "/")+1:]
		if !strings.Contains(last, ":") {
			return name + ":latest"
		}
		return name
	}
	for _, item := range *result.Models {
		if canonical(item.Name) == canonical(model) || canonical(item.Model) == canonical(model) {
			if item.RemoteModel != "" || item.RemoteHost != "" {
				return errors.New("OLLAMA_MODEL refers to a remote model; select a downloaded local model and disable Ollama cloud features")
			}
			fmt.Fprintln(out, "Ollama reachable; configured model is listed as installed. No inference or tool calls were run.")
			return nil
		}
	}
	return errors.New("OLLAMA_MODEL is not installed on this server; download the configured local model with ollama pull, then retry")
}
