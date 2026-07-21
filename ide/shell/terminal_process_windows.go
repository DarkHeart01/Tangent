//go:build windows

package main

import (
	"os/exec"
	"strconv"

	pty "github.com/aymanbagabas/go-pty"
)

func terminatePTYProcess(process *pty.Cmd) error {
	if process == nil || process.Process == nil {
		return nil
	}
	// ConPTY owns a console process tree. taskkill /T closes the shell and all
	// descendants instead of leaving a child process behind after tab close.
	return exec.Command("taskkill", "/PID", strconv.Itoa(process.Process.Pid), "/T", "/F").Run()
}
