// Package workspace implements file operations scoped to a single session's
// worktree directory, with path traversal guarded on every call.
package workspace

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"shell/internal/session"
)

// resolve joins relPath onto root and guarantees the result stays inside
// root, rejecting any ".." escape attempt.
func resolve(root, relPath string) (string, error) {
	cleanRel := filepath.Clean(filepath.FromSlash(relPath))
	if cleanRel == "." {
		return root, nil
	}
	full := filepath.Join(root, cleanRel)
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	fullAbs, err := filepath.Abs(full)
	if err != nil {
		return "", err
	}
	if fullAbs != rootAbs && !strings.HasPrefix(fullAbs, rootAbs+string(os.PathSeparator)) {
		return "", fmt.Errorf("path %q escapes worktree", relPath)
	}
	return fullAbs, nil
}

// Tree walks root and returns a nested FileNode tree with paths relative to
// root, forward-slash separated regardless of host OS.
func Tree(root string) ([]session.FileNode, error) {
	if _, err := os.Stat(root); err != nil {
		return nil, err
	}
	return readDir(root, root)
}

func readDir(root, dir string) ([]session.FileNode, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir() != entries[j].IsDir() {
			return entries[i].IsDir()
		}
		return entries[i].Name() < entries[j].Name()
	})

	nodes := make([]session.FileNode, 0, len(entries))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		full := filepath.Join(dir, e.Name())
		relPath, err := filepath.Rel(root, full)
		if err != nil {
			return nil, err
		}
		node := session.FileNode{
			Name:  e.Name(),
			Path:  filepath.ToSlash(relPath),
			IsDir: e.IsDir(),
		}
		if e.IsDir() {
			children, err := readDir(root, full)
			if err != nil {
				return nil, err
			}
			node.Children = children
		}
		nodes = append(nodes, node)
	}
	return nodes, nil
}

// ListDir lists only relPath's immediate children (relPath "" means root) -
// deliberately not recursive. Tree walks and returns everything at once,
// which for a large workspace (node_modules, build output, vendored deps)
// means one huge nested payload sent over the Wails IPC bridge before the
// explorer can render anything; ListDir backs on-demand expansion instead,
// the same way a real IDE explorer only reads a folder when you open it.
func ListDir(root, relPath string) ([]session.FileNode, error) {
	dir, err := resolve(root, relPath)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir() != entries[j].IsDir() {
			return entries[i].IsDir()
		}
		return entries[i].Name() < entries[j].Name()
	})
	nodes := make([]session.FileNode, 0, len(entries))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		path := e.Name()
		if relPath != "" {
			path = filepath.ToSlash(filepath.Join(relPath, e.Name()))
		}
		nodes = append(nodes, session.FileNode{Name: e.Name(), Path: path, IsDir: e.IsDir()})
	}
	return nodes, nil
}

func Read(root, relPath string) (session.FileContent, error) {
	full, err := resolve(root, relPath)
	if err != nil {
		return session.FileContent{}, err
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return session.FileContent{}, err
	}
	return session.FileContent{Path: relPath, Content: string(data)}, nil
}

func Write(root, relPath, content string) error {
	full, err := resolve(root, relPath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	return os.WriteFile(full, []byte(content), 0o644)
}
