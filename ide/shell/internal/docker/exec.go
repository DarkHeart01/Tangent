package docker

import (
	"bytes"
	"context"
	"fmt"
	"time"

	"github.com/moby/moby/client"
)

// ExecInContainer runs cmd inside an already-running container (created via
// SpawnContainer) and waits for it to finish, demuxing stdout/stderr with
// the same framing StreamLogs uses. Used by execapi to route a real agent's
// shell_exec tool calls into the sandboxed container instead of the host.
func (d *DockerManager) ExecInContainer(ctx context.Context, containerID string, cmd []string, cwd string, timeout time.Duration) (exitCode int, stdout, stderr string, err error) {
	execCtx := ctx
	if timeout > 0 {
		var cancel context.CancelFunc
		execCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}

	created, err := d.cli.ExecCreate(execCtx, containerID, client.ExecCreateOptions{
		Cmd:          cmd,
		WorkingDir:   cwd,
		AttachStdout: true,
		AttachStderr: true,
	})
	if err != nil {
		return -1, "", "", fmt.Errorf("exec create: %w", err)
	}

	resp, err := d.cli.ExecAttach(execCtx, created.ID, client.ExecAttachOptions{})
	if err != nil {
		return -1, "", "", fmt.Errorf("exec attach: %w", err)
	}
	defer resp.Close()

	// Context cancellation alone isn't guaranteed to interrupt an in-flight
	// read on a hijacked connection — set an explicit deadline on the raw
	// conn so a hung command can't block this call past timeout.
	if timeout > 0 {
		_ = resp.Conn.SetDeadline(time.Now().Add(timeout))
	}

	var stdoutBuf, stderrBuf bytes.Buffer
	demuxErr := demuxLogs(&stdoutBuf, &stderrBuf, resp.Reader)
	if demuxErr != nil && execCtx.Err() != nil {
		return -1, stdoutBuf.String(), stderrBuf.String(), fmt.Errorf("exec timed out after %s", timeout)
	}

	inspect, err := d.cli.ExecInspect(context.Background(), created.ID, client.ExecInspectOptions{})
	if err != nil {
		return -1, stdoutBuf.String(), stderrBuf.String(), fmt.Errorf("exec inspect: %w", err)
	}

	return inspect.ExitCode, stdoutBuf.String(), stderrBuf.String(), nil
}
