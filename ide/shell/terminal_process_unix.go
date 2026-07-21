//go:build !windows

package main

import (
	"syscall"

	pty "github.com/aymanbagabas/go-pty"
)

func terminatePTYProcess(process *pty.Cmd) error {
	if process == nil || process.Process == nil {
		return nil
	}
	// go-pty starts Unix shells in their own session/process group. Killing the
	// group prevents an interactive child (python, vim, less, etc.) from being
	// orphaned when its terminal tab closes.
	_ = syscall.Kill(-process.Process.Pid, syscall.SIGKILL)
	return process.Process.Kill()
}
