package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func modelCall(name string, args any) toolCall {
	var call toolCall
	call.Function.Name = name
	call.Function.Arguments, _ = json.Marshal(args)
	return call
}
func proposalArgs(c Case) map[string]any {
	p := rulesProposal(c)
	return map[string]any{"summary": p.Summary, "action": p.Action, "evidence": p.Evidence}
}
func TestAgentMustReceiveEvidenceBeforeProposing(t *testing.T) {
	s := sample(t)
	c := s.Cases[1]
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"message": chatMessage{Role: "assistant", ToolCalls: []toolCall{
			modelCall("get_case", map[string]any{}), modelCall("list_evidence", map[string]any{}), modelCall("propose_resolution", proposalArgs(c)),
		}}})
	}))
	defer server.Close()
	if _, e := (Investigator{server.URL, "test"}).run(context.Background(), c, s.Records); e == nil {
		t.Fatal("accepted proposal made before receiving tool results")
	}
}
func TestAgentRejectsInvalidArgumentsAndTrailingTools(t *testing.T) {
	for _, variant := range []string{"read_argument", "proposal_extra", "unknown_after_proposal", "duplicate_citation", "too_many_calls"} {
		t.Run(variant, func(t *testing.T) {
			s := sample(t)
			c := s.Cases[1]
			turn := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				turn++
				calls := []toolCall{}
				if turn == 1 {
					args := map[string]any{}
					if variant == "read_argument" {
						args["case_id"] = "some-other-case"
					}
					calls = []toolCall{modelCall("get_case", args), modelCall("list_evidence", map[string]any{})}
					if variant == "too_many_calls" {
						for i := 0; i < 30; i++ {
							calls = append(calls, modelCall("get_case", map[string]any{}))
						}
					}
				} else {
					args := proposalArgs(c)
					if variant == "proposal_extra" {
						args["execute_payment"] = true
					}
					if variant == "duplicate_citation" {
						args["evidence"] = []string{c.Evidence[0], c.Evidence[0]}
					}
					calls = []toolCall{modelCall("propose_resolution", args)}
					if variant == "unknown_after_proposal" {
						calls = append(calls, modelCall("send_payment", map[string]any{}))
					}
				}
				writeJSON(w, 200, map[string]any{"message": chatMessage{Role: "assistant", ToolCalls: calls}})
			}))
			defer server.Close()
			if _, e := (Investigator{server.URL, "test"}).run(context.Background(), c, s.Records); e == nil {
				t.Fatal("accepted invalid model output")
			}
		})
	}
}
func TestAgentRejectsMissingSourceEvidence(t *testing.T) {
	s := sample(t)
	c := s.Cases[1]
	delete(s.Records, c.Evidence[0])
	if _, e := (Investigator{}).run(context.Background(), c, s.Records); e == nil {
		t.Fatal("rules proposal cited missing source evidence")
	}
}
func TestAgentBoundsResponsesAndTurns(t *testing.T) {
	for _, variant := range []string{"oversized", "turns", "no_tools", "http_error"} {
		t.Run(variant, func(t *testing.T) {
			s := sample(t)
			c := s.Cases[1]
			turns := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				turns++
				switch variant {
				case "oversized":
					w.Write([]byte(strings.Repeat(" ", 1024*1024+1)))
				case "no_tools":
					writeJSON(w, 200, map[string]any{"message": chatMessage{Role: "assistant", Content: "trust me"}})
				case "http_error":
					w.WriteHeader(503)
				default:
					writeJSON(w, 200, map[string]any{"message": chatMessage{Role: "assistant", ToolCalls: []toolCall{modelCall("get_case", map[string]any{})}}})
				}
			}))
			defer server.Close()
			if _, e := (Investigator{server.URL, "test"}).run(context.Background(), c, s.Records); e == nil {
				t.Fatal("unbounded/invalid model accepted")
			}
			if turns > 6 {
				t.Fatalf("exceeded turn limit: %d", turns)
			}
		})
	}
}

// A model that answers the final turn in prose gets one reminder; the prose is
// discarded and only a validated propose_resolution call becomes a draft.
func TestAgentRemindsOnceAfterEvidenceThenRequiresTool(t *testing.T) {
	for _, tc := range []struct {
		name  string
		turns []string // "reads", "prose", "propose"
		ok    bool
	}{
		{"prose then proposal", []string{"reads", "prose", "propose"}, true},
		{"prose twice", []string{"reads", "prose", "prose"}, false},
		{"prose before evidence", []string{"prose"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := sample(t)
			c := s.Cases[1]
			turn := 0
			offered := [][]string{}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var req struct {
					Tools []struct {
						Function struct{ Name string } `json:"function"`
					} `json:"tools"`
				}
				json.NewDecoder(r.Body).Decode(&req)
				names := []string{}
				for _, tool := range req.Tools {
					names = append(names, tool.Function.Name)
				}
				offered = append(offered, names)
				step := tc.turns[min(turn, len(tc.turns)-1)]
				turn++
				msg := chatMessage{Role: "assistant"}
				switch step {
				case "reads":
					msg.ToolCalls = []toolCall{modelCall("get_case", map[string]any{}), modelCall("list_evidence", map[string]any{})}
				case "prose":
					msg.Content = "The payout looks fine; I have matched it."
				case "propose":
					msg.ToolCalls = []toolCall{modelCall("propose_resolution", proposalArgs(c))}
				}
				writeJSON(w, 200, map[string]any{"message": msg})
			}))
			defer server.Close()
			p, err := (Investigator{server.URL, "test"}).run(context.Background(), c, s.Records)
			if (err == nil) != tc.ok {
				t.Fatalf("err=%v, want ok=%t", err, tc.ok)
			}
			if tc.ok {
				if strings.Contains(p.Summary, "matched it") || !strings.Contains(strings.Join(p.Trace, "|"), "Reminded model") {
					t.Fatalf("prose leaked or reminder not traced: %+v", p)
				}
				if len(offered) < 2 || strings.Join(offered[1], ",") != "propose_resolution" {
					t.Fatalf("after evidence reads only propose_resolution should be offered, got %v", offered)
				}
			}
		})
	}
}
