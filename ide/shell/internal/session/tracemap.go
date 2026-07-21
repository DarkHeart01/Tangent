package session

import (
	"encoding/json"
	"fmt"
)

// traceSpan mirrors observability/tracing.py's SpanEvent JSON shape — one
// complete record per FINISHED span (start_time and end_time both already
// populated by the time the line exists; there is no separate real-time
// "span started" notification in this format).
type traceSpan struct {
	TraceID      string                 `json:"trace_id"`
	SpanID       string                 `json:"span_id"`
	ParentSpanID *string                `json:"parent_span_id"`
	Name         string                 `json:"name"`
	Kind         string                 `json:"kind"` // agent | task | tool | llm | bus | custom
	AgentID      *string                `json:"agent_id"`
	TaskID       *string                `json:"task_id"`
	StartTime    string                 `json:"start_time"`
	EndTime      *string                `json:"end_time"`
	Status       string                 `json:"status"` // ok | error
	Attributes   map[string]interface{} `json:"attributes"`
	Error        *string                `json:"error"`
}

// mapTraceLine parses one JSONL line from the swarm engine's trace file and
// emits the closest matching Envelope(s) through emit.
//
// Because a line only appears once its span has fully finished, "started"
// and "finished"-shaped contract events are emitted together, upon seeing
// each line — there's no way to know about a span before it's already
// over, so any apparent real-time "started" moment in the Dashboard is
// reconstructed after the fact, not observed live. This is a structural
// limitation of the trace format, not a bug in the mapping.
//
// Coverage, evidenced vs. guessed:
//   - kind == "tool": well evidenced — tools/base.py's ToolHandler.run wraps
//     every call in Span(f"tool.{spec.name}", "tool", agent_id=...), setting
//     attributes.inputs and attributes.output_keys. Mapped to a paired
//     tool.call + tool.result.
//   - kind == "agent": SpanEvent's own kind enum documents this case and
//     carries agent_id, but I did not find the exact orchestrator call site
//     that creates one (out of scope to chase further for this step) — the
//     AgentStarted/AgentFinished mapping is a best-effort match on the
//     fields that exist, not confirmed against real orchestrator span names.
//   - kind == "task" | "llm" | "bus" | "custom": no confident 1:1 contract
//     event exists (no "phase" concept surfaces here for a flat/non-lifecycle
//     topology, and llm spans' cost/token attributes aren't reliably named
//     without reading the LLM-call site). Rather than force these into
//     budget.update or phase.transition with fabricated/empty fields,
//     they're rendered as informational terminal.output lines — honest
//     about being a fallback, not a guessed structured event.
func mapTraceLine(emit func(eventType string, payload interface{}), line string) {
	var span traceSpan
	if err := json.Unmarshal([]byte(line), &span); err != nil {
		return // not a parseable SpanEvent line — skip rather than crash the tailer
	}

	agentID := ""
	if span.AgentID != nil {
		agentID = *span.AgentID
	}
	taskID := ""
	if span.TaskID != nil {
		taskID = *span.TaskID
	}
	status := "success"
	if span.Status == "error" {
		status = "failed"
	}

	switch span.Kind {
	case "tool":
		toolName := span.Name
		if len(toolName) > 5 && toolName[:5] == "tool." {
			toolName = toolName[5:]
		}
		callID := span.SpanID
		emit("tool.call", ToolCall{
			AgentInstanceID: agentID,
			ToolName:        toolName,
			SideEffectTier:  "mutates-local", // not derivable from the trace line — spec.side_effect_level lives in configs/schema.py, not attributes
			ArgsSummary:     summarizeAttr(span.Attributes["inputs"]),
			CallID:          callID,
		})
		resultStatus := "ok"
		summary := "completed"
		if span.Status == "error" {
			resultStatus = "error"
			if span.Error != nil {
				summary = *span.Error
			} else {
				summary = "tool call failed"
			}
		}
		emit("tool.result", ToolResult{CallID: callID, Status: resultStatus, Summary: summary})

	case "agent":
		instanceID := agentID
		if instanceID == "" {
			instanceID = span.SpanID
		}
		emit("agent.started", AgentStarted{AgentRole: span.Name, AgentInstanceID: instanceID, TaskID: taskID})
		emit("agent.finished", AgentFinished{AgentInstanceID: instanceID, TaskID: taskID, Status: status})

	default: // task | llm | bus | custom, or anything future/unrecognized
		data := ""
		if span.Error != nil && *span.Error != "" {
			data = fmt.Sprintf("[%s] %s (agent=%s, status=%s, error=%s)\n", span.Kind, span.Name, agentID, span.Status, *span.Error)
		} else {
			data = fmt.Sprintf("[%s] %s (agent=%s, status=%s)\n", span.Kind, span.Name, agentID, span.Status)
		}
		emit("terminal.output", TerminalOutput{ContainerID: "swarm-engine", Stream: "stdout", Data: data})
	}
}

func summarizeAttr(v interface{}) string {
	if v == nil {
		return ""
	}
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	s := string(b)
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}
