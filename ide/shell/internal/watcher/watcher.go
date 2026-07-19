// Package watcher wraps fsnotify to turn host filesystem changes into the
// file.changed event contract. Since the worktree is bind-mounted into the
// container, host-side and container-side see the same files — watching
// the host path is sufficient, no explicit container-to-host sync needed.
package watcher

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/fsnotify/fsnotify"
)

// WatchDirectory watches path (recursively) until ctx is cancelled, calling
// onChange once per detected create/write/remove, with changeType one of
// "created" | "modified" | "deleted" — matching FileChanged.change_type.
func WatchDirectory(ctx context.Context, path string, onChange func(path, changeType string)) error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	defer w.Close()

	if err := addRecursive(w, path); err != nil {
		return err
	}

	for {
		select {
		case <-ctx.Done():
			return nil

		case event, ok := <-w.Events:
			if !ok {
				return nil
			}
			changeType := classify(event.Op)
			if changeType == "" {
				continue
			}
			onChange(event.Name, changeType)

			// A newly created directory needs its own watch registered, or
			// files written inside it later would go unseen (fsnotify
			// watches are not recursive by default).
			if event.Op&fsnotify.Create != 0 {
				if info, statErr := os.Stat(event.Name); statErr == nil && info.IsDir() {
					_ = w.Add(event.Name)
				}
			}

		case _, ok := <-w.Errors:
			if !ok {
				return nil
			}
			// Best-effort: keep watching through transient backend errors.
		}
	}
}

func addRecursive(w *fsnotify.Watcher, root string) error {
	return filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return w.Add(p)
		}
		return nil
	})
}

func classify(op fsnotify.Op) string {
	switch {
	case op&fsnotify.Create != 0:
		return "created"
	case op&fsnotify.Write != 0:
		return "modified"
	case op&fsnotify.Remove != 0:
		return "deleted"
	case op&fsnotify.Rename != 0:
		// fsnotify reports a rename as a remove of the old name; the new
		// name (if any) arrives as its own Create event.
		return "deleted"
	default:
		return ""
	}
}
