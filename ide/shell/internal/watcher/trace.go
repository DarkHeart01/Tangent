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
// trace JSONL file the swarm engine writes and streams each complete line
// to onNewLine as it's appended, until ctx is cancelled.
//
// The signature takes a directory rather than a known file path because the
// engine names it <trace_id>.jsonl, where trace_id is a UUID generated at
// runtime by the Python process (see observability/tracing.py) — there's no
// way to know it in advance, only the containing --trace-dir is
// controllable. Once the first *.jsonl file appears (or is found already
// present, in case the process wrote before we started watching), that
// file, specifically, is tailed for the rest of the run.
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

	t := &traceTailer{onNewLine: onNewLine}
	t.targetPath, t.offset = findExistingTraceFile(path)
	t.readNew()

	for {
		select {
		case <-ctx.Done():
			return nil

		case event, ok := <-w.Events:
			if !ok {
				return nil
			}
			if t.targetPath == "" {
				if event.Op&fsnotify.Create != 0 && strings.HasSuffix(event.Name, ".jsonl") {
					t.targetPath = event.Name
					t.offset = 0
					t.readNew()
				}
				continue
			}
			if event.Name == t.targetPath && event.Op&(fsnotify.Write|fsnotify.Create) != 0 {
				t.readNew()
			}

		case _, ok := <-w.Errors:
			if !ok {
				return nil
			}
			// best-effort; keep watching through transient backend errors
		}
	}
}

// traceTailer tracks read progress through the target file across events —
// fsnotify only tells us "this file changed," not what changed, so each
// Write event triggers a re-read from the last known offset.
type traceTailer struct {
	onNewLine  func(line string)
	targetPath string
	offset     int64
	partial    strings.Builder
}

func (t *traceTailer) readNew() {
	if t.targetPath == "" {
		return
	}
	f, err := os.Open(t.targetPath)
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

func findExistingTraceFile(dir string) (path string, offset int64) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", 0
	}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".jsonl") {
			return filepath.Join(dir, e.Name()), 0
		}
	}
	return "", 0
}
