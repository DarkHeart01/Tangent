package main

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Vendored ripgrep (MIT-licensed, from the @vscode/ripgrep npm package) - see
// bin/rg.exe and search.go. Embedding it keeps code search working out of the
// box on any machine, with no separate install and no dependence on PATH.
//
//go:embed bin/rg.exe
var ripgrepBinary []byte

var (
	ripgrepPathOnce sync.Once
	ripgrepPathVal  string
	ripgrepPathErr  error
)

// ripgrepPath extracts the embedded rg.exe to a stable on-disk location once
// per process and returns that path. A Windows exe can't be exec'd straight
// out of an embed.FS, so this is required, not just a cache optimization.
// Re-extracts if the on-disk copy's size doesn't match the embedded binary
// (e.g. after an app upgrade changed the vendored version).
func ripgrepPath() (string, error) {
	ripgrepPathOnce.Do(func() {
		dir, err := os.UserCacheDir()
		if err != nil {
			dir = os.TempDir()
		}
		dir = filepath.Join(dir, "tangent-ide")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			ripgrepPathErr = fmt.Errorf("could not create cache dir for ripgrep: %w", err)
			return
		}
		path := filepath.Join(dir, "rg.exe")
		if info, statErr := os.Stat(path); statErr != nil || info.Size() != int64(len(ripgrepBinary)) {
			if err := os.WriteFile(path, ripgrepBinary, 0o755); err != nil {
				ripgrepPathErr = fmt.Errorf("could not extract ripgrep binary: %w", err)
				return
			}
		}
		ripgrepPathVal = path
	})
	return ripgrepPathVal, ripgrepPathErr
}
