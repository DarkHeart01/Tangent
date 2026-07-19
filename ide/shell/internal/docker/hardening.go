package docker

import (
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/strslice"
)

const (
	defaultMemoryLimitMB = 512
	defaultNanoCPUs      = int64(1_000_000_000) // 1 core
	defaultNetworkMode   = "none"
	defaultTmpfsSize     = 64 * 1024 * 1024 // 64MB scratch space at /tmp

	// nonRootUser is applied to every spawned container's Config.User.
	// Numeric, not a name: no base image can be trusted to already have a
	// matching /etc/passwd entry, and this never resolves to root by
	// accident the way an unset User field would.
	nonRootUser = "1000:1000"
)

// buildHostConfig is the ONLY place a container.HostConfig gets assembled
// for spawned containers. It applies mandatory hardening with no
// exceptions and no escape hatch:
//   - CapDrop ALL, no-new-privileges, never privileged.
//   - Read-only rootfs, with the worktree bind mount as the sole writable
//     path plus a small tmpfs at /tmp (a read-only rootfs otherwise breaks
//     basic shell/tooling that wants scratch space).
//   - Resource caps (memory, CPU) always applied, defaulted if unset.
//
// ContainerSpawnOpts has no field for extra mounts or capabilities, so
// there is no way to reach this function with a config that mounts
// /var/run/docker.sock or sets Privileged: true — those aren't rejected at
// runtime, they're simply not expressible.
func buildHostConfig(opts ContainerSpawnOpts) container.HostConfig {
	memMB := opts.MemoryLimitMB
	if memMB <= 0 {
		memMB = defaultMemoryLimitMB
	}
	nanoCPUs := opts.NanoCPUs
	if nanoCPUs <= 0 {
		nanoCPUs = defaultNanoCPUs
	}
	networkMode := opts.NetworkMode
	if networkMode == "" {
		networkMode = defaultNetworkMode
	}

	return container.HostConfig{
		Resources: container.Resources{
			Memory:   int64(memMB) * 1024 * 1024,
			NanoCPUs: nanoCPUs,
		},
		CapDrop:        strslice.StrSlice{"ALL"},
		SecurityOpt:    []string{"no-new-privileges:true"},
		Privileged:     false,
		ReadonlyRootfs: true,
		NetworkMode:    container.NetworkMode(networkMode),
		Mounts: []mount.Mount{
			{
				Type:   mount.TypeBind,
				Source: opts.WorktreePath,
				Target: opts.MountTarget,
			},
			{
				Type:   mount.TypeTmpfs,
				Target: "/tmp",
				TmpfsOptions: &mount.TmpfsOptions{
					SizeBytes: defaultTmpfsSize,
				},
			},
		},
	}
}
