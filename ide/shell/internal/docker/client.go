// Package docker spawns and manages hardened, throwaway containers for
// ContainerExecutor. Every container this package creates goes through
// buildHostConfig (hardening.go) — there is no code path that can request
// a privileged container or a docker.sock mount.
package docker

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
)

type DockerManager struct {
	cli *client.Client
}

func NewDockerManager() (*DockerManager, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("docker client: %w", err)
	}
	// FromEnv only reads DOCKER_HOST etc.; actually reach the daemon once
	// here so callers get a clear "docker unavailable" error immediately,
	// rather than have it surface later from inside a goroutine.
	if _, err := cli.Ping(context.Background(), client.PingOptions{}); err != nil {
		return nil, fmt.Errorf("docker daemon unreachable: %w", err)
	}
	return &DockerManager{cli: cli}, nil
}

// ContainerSpawnOpts is intentionally minimal: there is no field for extra
// mounts, extra capabilities, or a privileged flag, so hardening.go's
// buildHostConfig can't be bypassed by adding one.
type ContainerSpawnOpts struct {
	Image         string
	Cmd           []string
	WorktreePath  string // host path, bind-mounted read-write
	MountTarget   string // e.g. "/workspace"
	MemoryLimitMB int    // default 512
	NanoCPUs      int64  // default 1e9 (1 core)
	NetworkMode   string // default "none"
}

func (d *DockerManager) SpawnContainer(ctx context.Context, opts ContainerSpawnOpts) (containerID string, err error) {
	if opts.MountTarget == "" {
		opts.MountTarget = "/workspace"
	}
	if opts.WorktreePath == "" {
		return "", fmt.Errorf("WorktreePath is required")
	}

	if err := d.ensureImage(ctx, opts.Image); err != nil {
		return "", fmt.Errorf("ensure image %q: %w", opts.Image, err)
	}

	hostConfig := buildHostConfig(opts)

	cfg := &container.Config{
		Image:        opts.Image,
		Cmd:          opts.Cmd,
		WorkingDir:   opts.MountTarget,
		User:         nonRootUser,
		Tty:          false,
		AttachStdout: true,
		AttachStderr: true,
	}

	created, err := d.cli.ContainerCreate(ctx, client.ContainerCreateOptions{
		Config:     cfg,
		HostConfig: &hostConfig,
	})
	if err != nil {
		return "", fmt.Errorf("container create: %w", err)
	}

	if _, err := d.cli.ContainerStart(ctx, created.ID, client.ContainerStartOptions{}); err != nil {
		return "", fmt.Errorf("container start: %w", err)
	}

	return created.ID, nil
}

func (d *DockerManager) ensureImage(ctx context.Context, ref string) error {
	if _, err := d.cli.ImageInspect(ctx, ref); err == nil {
		return nil // already present locally
	}
	resp, err := d.cli.ImagePull(ctx, ref, client.ImagePullOptions{})
	if err != nil {
		return err
	}
	defer resp.Close()
	_, err = io.Copy(io.Discard, resp) // drain pull progress stream to completion
	return err
}

// StreamLogs follows containerID's combined stdout/stderr until the
// container exits (or ctx is cancelled) and calls onLine once per
// newline-terminated chunk, correctly split by stream. Logs come back from
// the daemon as a single multiplexed binary stream when Tty is false (as it
// always is for spawned containers here), so demuxing via stdcopy is not
// optional — reading it raw would interleave stdout/stderr bytes and
// corrupt both.
func (d *DockerManager) StreamLogs(ctx context.Context, containerID string, onLine func(stream, line string)) error {
	rc, err := d.cli.ContainerLogs(ctx, containerID, client.ContainerLogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     true,
	})
	if err != nil {
		return fmt.Errorf("container logs: %w", err)
	}
	defer rc.Close()

	stdoutW := &lineWriter{stream: "stdout", onLine: onLine}
	stderrW := &lineWriter{stream: "stderr", onLine: onLine}

	err = demuxLogs(stdoutW, stderrW, rc)
	stdoutW.flush()
	stderrW.flush()
	if err != nil && ctx.Err() == nil {
		return fmt.Errorf("demux logs: %w", err)
	}
	return nil
}

// demuxLogs replicates the Docker daemon's stdout/stderr log-multiplexing
// framing: each frame is an 8-byte header (1 byte stream type — 1=stdout,
// 2=stderr; 3 bytes padding; 4-byte big-endian payload length) followed by
// that many payload bytes. This is the same stable, documented wire format
// docker/docker's pkg/stdcopy implements — reimplemented here because that
// package is now only reachable through a monolith module whose /client
// and /api directories collide with the standalone github.com/moby/moby/client
// and github.com/moby/moby/api modules this file already depends on
// (moby's ongoing module-split migration), making it unimportable without
// an ambiguous-import error.
func demuxLogs(stdout, stderr io.Writer, src io.Reader) error {
	header := make([]byte, 8)
	for {
		if _, err := io.ReadFull(src, header); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return nil
			}
			return err
		}
		size := int64(binary.BigEndian.Uint32(header[4:8]))
		w := stdout
		if header[0] == 2 {
			w = stderr
		}
		if _, err := io.CopyN(w, src, size); err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

func (d *DockerManager) StopAndRemove(ctx context.Context, containerID string) error {
	timeoutSeconds := 5
	// Stop errors (e.g. already exited) are not fatal — Remove below is
	// what actually needs to succeed.
	_, _ = d.cli.ContainerStop(ctx, containerID, client.ContainerStopOptions{Timeout: &timeoutSeconds})
	if _, err := d.cli.ContainerRemove(ctx, containerID, client.ContainerRemoveOptions{Force: true}); err != nil {
		return fmt.Errorf("container remove: %w", err)
	}
	return nil
}

// lineWriter buffers arbitrary chunk writes and calls onLine once per
// complete line, flushing any trailing partial line on Close.
type lineWriter struct {
	stream string
	onLine func(stream, line string)
	buf    []byte
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.buf = append(w.buf, p...)
	for {
		idx := bytes.IndexByte(w.buf, '\n')
		if idx < 0 {
			break
		}
		line := string(w.buf[:idx])
		w.buf = w.buf[idx+1:]
		w.onLine(w.stream, line)
	}
	return len(p), nil
}

func (w *lineWriter) flush() {
	if len(w.buf) > 0 {
		w.onLine(w.stream, string(w.buf))
		w.buf = nil
	}
}
