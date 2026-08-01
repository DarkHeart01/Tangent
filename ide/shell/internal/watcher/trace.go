package watcher

import (
	"bufio"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/fsnotify/fsnotify"
)

// TailTraceFile watches path — a directory, not a fixed file — for the
// trace JSONL file(s) the swarm engine writes and streams each complete
// line to onNewLine as it's appended, until ctx is cancelled.
//
// The engine names each file <trace_id>.jsonl, where trace_id is a UUID
// generated at runtime by the Python process (see observability/
// tracing.py) — there's no way to know it in advance, only the containing
// --trace-dir is controllable, and — confirmed empirically on a real
// 23-agent/12-phase lifecycle run — a single swarm run is not guaranteed
// to write only one such file; a second .jsonl can appear partway through
// (e.g. a fresh trace_id for a sub-invocation). This used to latch onto
// whichever file appeared first and tail only that one for the rest of the
// run, silently going stale the moment a second file took over — every
// trace-derived event (agent.started/finished, budget.update, critic.score,
// contract.emitted, and tool.call/tool.result for anything not routed
// through execapi directly) went dark for the remainder of the run with no
// error, because filesystem/shell_exec's daemon-routed events (which come
// directly from execapi, not this tailer) kept flowing and masked it. Now
// every *.jsonl file that exists or appears in the directory is tailed
// concurrently, each with its own read offset.
func TailTraceFile(ctx context.Context, path string, onNewLine func(line string)) error {
	if err := os.MkdirAll(path, 0o755); err != nil {
		return err
	}

	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	defer w.Close()

	if err := w.Add(path); err != nil {
		return err
	}

	m := &multiTailer{onNewLine: onNewLine, files: make(map[string]*traceTailer)}
	for _, p := range findExistingTraceFiles(path) {
		m.readNew(p)
	}

	for {
		select {
		case <-ctx.Done():
			return nil

		case event, ok := <-w.Events:
			if !ok {
				return nil
			}
			if !strings.HasSuffix(event.Name, ".jsonl") {
				continue
			}
			if event.Op&(fsnotify.Write|fsnotify.Create) != 0 {
				m.readNew(event.Name)
			}

		case _, ok := <-w.Errors:
			if !ok {
				return nil
			}
			// best-effort; keep watching through transient backend errors
		}
	}
}

// multiTailer tracks read progress independently per trace file — fsnotify
// only tells us "this file changed," not which one or what changed, so
// each Write event triggers a re-read of that specific file from its own
// last-known offset.
type multiTailer struct {
	onNewLine func(line string)
	files     map[string]*traceTailer
}

func (m *multiTailer) readNew(path string) {
	t, ok := m.files[path]
	if !ok {
		t = &traceTailer{onNewLine: m.onNewLine}
		m.files[path] = t
	}
	t.readNew(path)
}

type traceTailer struct {
	onNewLine func(line string)
	offset    int64
	partial   strings.Builder
}

func (t *traceTailer) readNew(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	if _, err := f.Seek(t.offset, io.SeekStart); err != nil {
		return
	}
	reader := bufio.NewReader(f)
	for {
		chunk, readErr := reader.ReadString('\n')
		t.offset += int64(len(chunk))
		if strings.HasSuffix(chunk, "\n") {
			line := t.partial.String() + strings.TrimSuffix(chunk, "\n")
			t.partial.Reset()
			if line != "" {
				t.onNewLine(line)
			}
		} else if chunk != "" {
			t.partial.WriteString(chunk) // partial line — wait for the rest
		}
		if readErr != nil {
			break
		}
	}
}

func findExistingTraceFiles(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".jsonl") {
			out = append(out, filepath.Join(dir, e.Name()))
		}
	}
	return out
}
