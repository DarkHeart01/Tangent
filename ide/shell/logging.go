package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Crash/error log written next to the running binary (falling back to the cwd).
// A WebView2 renderer fault used to leave nothing behind; the frontend now
// funnels every uncaught error here through LogFrontendError, and the Go side
// records startup/shutdown too, so a crash is diagnosable after the fact.
var (
	logMu   sync.Mutex
	logPath string
)

func logFilePath() string {
	if logPath != "" {
		return logPath
	}
	name := "tangent-ide.log"
	if exe, err := os.Executable(); err == nil {
		logPath = filepath.Join(filepath.Dir(exe), name)
		return logPath
	}
	logPath = name
	return logPath
}

func appendLog(line string) {
	logMu.Lock()
	defer logMu.Unlock()
	f, err := os.OpenFile(logFilePath(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = fmt.Fprintf(f, "%s %s\n", time.Now().Format(time.RFC3339), line)
}

// LogFrontendError is the Wails binding the renderer calls from its global
// error handler / React error boundary. Kept dead simple so it can never be
// the thing that fails during a crash.
func (s *SessionAPI) LogFrontendError(message string) error {
	appendLog("[frontend] " + message)
	return nil
}
