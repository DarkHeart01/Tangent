package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	stdRuntime "runtime"
	"strings"
	"sync"

	pty "github.com/aymanbagabas/go-pty"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type LocalTerminalInfo struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Cwd   string `json:"cwd"`
	Shell string `json:"shell"`
}

type localTerminalEvent struct {
	ID       string `json:"id"`
	Data     string `json:"data,omitempty"`
	Exited   bool   `json:"exited,omitempty"`
	ExitCode int    `json:"exit_code,omitempty"`
}

type terminalProcess struct {
	info      LocalTerminalInfo
	pty       pty.Pty
	command   *pty.Cmd
	closeOnce sync.Once
	ptyOnce   sync.Once
}

// closePTY closes the pseudo-terminal exactly once. go-pty's ConPTY Close is
// NOT idempotent on Windows — calling it twice frees the pseudoconsole twice
// and takes the whole process down (verified: the second Close is fatal). Both
// the manual-close path and the natural-exit path (waitForExit) can reach the
// teardown, so every pty.Close must funnel through here.
func (p *terminalProcess) closePTY() {
	p.ptyOnce.Do(func() {
		defer func() { _ = recover() }()
		_ = p.pty.Close()
	})
}

type TerminalManager struct {
	ctx       context.Context
	mu        sync.RWMutex
	next      uint64
	terminals map[string]*terminalProcess
}

func NewTerminalManager(ctx context.Context) *TerminalManager {
	if ctx == nil {
		ctx = context.Background()
	}
	return &TerminalManager{ctx: ctx, terminals: make(map[string]*terminalProcess)}
}

func terminalShell() (string, []string, error) {
	if stdRuntime.GOOS == "windows" {
		for _, candidate := range []string{"pwsh.exe", "pwsh", "powershell.exe", "powershell", "cmd.exe", "cmd"} {
			if path, err := exec.LookPath(candidate); err == nil {
				name := strings.ToLower(filepath.Base(path))
				if strings.HasPrefix(name, "pwsh") || strings.HasPrefix(name, "powershell") {
					return path, []string{"-NoLogo", "-NoProfile", "-NoExit"}, nil
				}
				if strings.HasPrefix(name, "cmd") {
					return path, []string{"/Q"}, nil
				}
				return path, nil, fmt.Errorf("unsupported Windows shell %q", path)
			}
		}
		return "", nil, fmt.Errorf("no PowerShell or cmd.exe shell found")
	}
	shell := strings.TrimSpace(os.Getenv("SHELL"))
	if shell == "" {
		shell = "bash"
	}
	path, err := exec.LookPath(shell)
	if err != nil {
		return "", nil, fmt.Errorf("shell %q is not available: %w", shell, err)
	}
	return path, []string{"-l"}, nil
}

func (m *TerminalManager) start(root string, cols, rows int) (LocalTerminalInfo, error) {
	cwd := strings.TrimSpace(root)
	if cwd == "" {
		var err error
		cwd, err = os.UserHomeDir()
		if err != nil {
			return LocalTerminalInfo{}, err
		}
	} else {
		var err error
		cwd, err = workspaceRoot(cwd)
		if err != nil {
			return LocalTerminalInfo{}, err
		}
	}
	shell, args, err := terminalShell()
	if err != nil {
		return LocalTerminalInfo{}, err
	}
	terminal, err := pty.New()
	if err != nil {
		return LocalTerminalInfo{}, err
	}
	command := terminal.Command(shell, args...)
	command.Dir = cwd
	command.Env = append(os.Environ(), "TERM=xterm-256color")
	if err := command.Start(); err != nil {
		_ = terminal.Close()
		return LocalTerminalInfo{}, err
	}
	if cols < 20 {
		cols = 80
	}
	if rows < 5 {
		rows = 24
	}
	_ = terminal.Resize(cols, rows)

	m.mu.Lock()
	m.next++
	id := fmt.Sprintf("local-%d", m.next)
	process := &terminalProcess{info: LocalTerminalInfo{ID: id, Name: filepath.Base(shell), Cwd: cwd, Shell: shell}, pty: terminal, command: command}
	m.terminals[id] = process
	m.mu.Unlock()

	go m.readOutput(process)
	go m.waitForExit(process)
	return process.info, nil
}

func (m *TerminalManager) readOutput(process *terminalProcess) {
	// A panic in this goroutine (e.g. reading a torn-down pty) would otherwise
	// crash the entire app — Go aborts the process on an unrecovered goroutine
	// panic. Contain it here.
	defer func() { _ = recover() }()
	buffer := make([]byte, 32*1024)
	for {
		n, err := process.pty.Read(buffer)
		if n > 0 {
			wailsRuntime.EventsEmit(m.ctx, "terminal.local.output", localTerminalEvent{ID: process.info.ID, Data: string(buffer[:n])})
		}
		if err != nil {
			return
		}
	}
}

func (m *TerminalManager) waitForExit(process *terminalProcess) {
	defer func() { _ = recover() }()
	err := process.command.Wait()
	exitCode := 0
	if process.command.ProcessState != nil {
		exitCode = process.command.ProcessState.ExitCode()
	}
	m.mu.Lock()
	delete(m.terminals, process.info.ID)
	m.mu.Unlock()
	process.closePTY() // idempotent — manual close may have closed it already
	wailsRuntime.EventsEmit(m.ctx, "terminal.local.output", localTerminalEvent{ID: process.info.ID, Exited: true, ExitCode: exitCode})
	_ = err
}

func (m *TerminalManager) close(id string) error {
	m.mu.RLock()
	process := m.terminals[id]
	m.mu.RUnlock()
	if process == nil {
		return nil
	}
	process.closeOnce.Do(func() {
		_ = terminatePTYProcess(process.command)
		process.closePTY()
	})
	return nil
}

func (m *TerminalManager) CloseAll() {
	m.mu.RLock()
	ids := make([]string, 0, len(m.terminals))
	for id := range m.terminals {
		ids = append(ids, id)
	}
	m.mu.RUnlock()
	for _, id := range ids {
		_ = m.close(id)
	}
}

func (s *SessionAPI) terminalManager() *TerminalManager {
	if s.terminals == nil {
		s.terminals = NewTerminalManager(s.ctx)
	}
	return s.terminals
}

// CreateTerminal spawns a native PTY (go-pty / ConPTY on Windows). That's a
// platform-backed syscall like the workspace dialog in git.go's
// SelectWorkspace - keep an unexpected panic from taking down the whole
// Wails process; surface it as a normal rejected binding call instead so the
// frontend (and the rest of the open workspace) stays alive.
func (s *SessionAPI) CreateTerminal(root string, cols, rows int) (info LocalTerminalInfo, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			info = LocalTerminalInfo{}
			err = fmt.Errorf("terminal failed to start: %v", recovered)
		}
	}()
	return s.terminalManager().start(root, cols, rows)
}

func (s *SessionAPI) WriteTerminal(id, data string) error {
	m := s.terminalManager()
	m.mu.RLock()
	process := m.terminals[id]
	m.mu.RUnlock()
	if process == nil {
		return fmt.Errorf("terminal %q is not running", id)
	}
	_, err := process.pty.Write([]byte(data))
	return err
}

func (s *SessionAPI) ResizeTerminal(id string, cols, rows int) error {
	m := s.terminalManager()
	m.mu.RLock()
	process := m.terminals[id]
	m.mu.RUnlock()
	if process == nil {
		return fmt.Errorf("terminal %q is not running", id)
	}
	if cols < 20 || rows < 5 {
		return nil
	}
	return process.pty.Resize(cols, rows)
}

func (s *SessionAPI) CloseTerminal(id string) error {
	return s.terminalManager().close(id)
}
