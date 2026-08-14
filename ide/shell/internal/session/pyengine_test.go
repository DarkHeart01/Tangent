package session

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestVersionAtLeast(t *testing.T) {
	cases := []struct {
		installed, min string
		want           bool
	}{
		{"0.1.0", "0.1.0", true},
		{"0.2.0", "0.1.0", true},
		{"0.0.9", "0.1.0", false},
		{"1.9.0", "1.10.0", false}, // a plain string compare would get this wrong
		{"1.10.0", "1.9.0", true},
		{"0.1.0+dev", "0.1.0", true},  // build tag stripped before comparing
		{"0.0.0+dev", "0.1.0", false}, // the _swarm_version() dev-checkout fallback
		{"garbage", "0.1.0", false},
		{"0.1.0", "garbage", false},
		{"1.2", "1.2.0", true}, // shorter version treated as zero-padded
		{"1.2.0", "1.2", true},
	}
	for _, c := range cases {
		if got := versionAtLeast(c.installed, c.min); got != c.want {
			t.Errorf("versionAtLeast(%q, %q) = %v, want %v", c.installed, c.min, got, c.want)
		}
	}
}

// minimalSystemPath is a PATH containing just enough of the real OS to let
// exec.Command/exec.LookPath's own machinery function (cmd.exe's location
// on Windows, sh on POSIX) without picking up anything actually installed
// on this dev machine (e.g. this system's own real `swarm` install at
// ~/.local/bin) — the "genuinely clean shell" tests need PATH to reliably
// NOT contain swarm unless the test explicitly adds a fake one.
func minimalSystemPath(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		sysRoot := os.Getenv("SystemRoot")
		if sysRoot == "" {
			sysRoot = `C:\Windows`
		}
		return sysRoot + `\System32`
	}
	return "/usr/bin:/bin"
}

// writeFakeSwarm writes a fake `swarm` executable into a fresh temp dir
// that prints --version output in click's actual format (see
// cli/main.py's @click.version_option / _swarm_version) and exits 0.
// Returns the containing directory, for prepending onto PATH.
func writeFakeSwarm(t *testing.T, version string) string {
	t.Helper()
	dir := t.TempDir()
	if runtime.GOOS == "windows" {
		script := "@echo off\r\necho swarm, version " + version + "\r\n"
		if err := os.WriteFile(filepath.Join(dir, "swarm.bat"), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	} else {
		script := "#!/bin/sh\necho \"swarm, version " + version + "\"\n"
		if err := os.WriteFile(filepath.Join(dir, "swarm"), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// fakeRepoRoot builds a temp dir that either does or doesn't look like a
// usable monorepo checkout (cli/main.py present or absent), matching what
// resolveSwarmCommand's fallback path actually checks for.
func fakeRepoRoot(t *testing.T, withCliMain bool) string {
	t.Helper()
	dir := t.TempDir()
	if withCliMain {
		cliDir := filepath.Join(dir, "cli")
		if err := os.MkdirAll(cliDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(cliDir, "main.py"), []byte("# stub\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func withPath(t *testing.T, dirs ...string) {
	t.Helper()
	t.Setenv("PATH", strings.Join(dirs, string(os.PathListSeparator)))
}

func TestResolveSwarmCommand_CompatibleStandaloneWinsOverCheckout(t *testing.T) {
	fakeDir := writeFakeSwarm(t, MinSwarmVersion)
	withPath(t, fakeDir, minimalSystemPath(t))
	repoRoot := fakeRepoRoot(t, true) // checkout also present -- standalone must still win

	bin, args, err := resolveSwarmCommand(repoRoot)
	if err != nil {
		t.Fatalf("resolveSwarmCommand: %v", err)
	}
	if filepath.Dir(bin) != fakeDir {
		t.Errorf("bin = %q, want it resolved from the fake swarm dir %q", bin, fakeDir)
	}
	if len(args) != 0 {
		t.Errorf("leadingArgs = %v, want none — the standalone binary takes `run ...` directly, no -m cli.main", args)
	}
}

func TestResolveSwarmCommand_NewerThanMinIsCompatible(t *testing.T) {
	fakeDir := writeFakeSwarm(t, "99.0.0")
	withPath(t, fakeDir, minimalSystemPath(t))
	repoRoot := fakeRepoRoot(t, true)

	bin, _, err := resolveSwarmCommand(repoRoot)
	if err != nil {
		t.Fatalf("resolveSwarmCommand: %v", err)
	}
	if filepath.Dir(bin) != fakeDir {
		t.Errorf("bin = %q, want the fake swarm dir %q", bin, fakeDir)
	}
}

func TestResolveSwarmCommand_IncompatibleFallsBackToCheckout(t *testing.T) {
	fakeDir := writeFakeSwarm(t, "0.0.1") // older than MinSwarmVersion
	withPath(t, fakeDir, minimalSystemPath(t))
	repoRoot := fakeRepoRoot(t, true)

	bin, args, err := resolveSwarmCommand(repoRoot)
	if err != nil {
		t.Fatalf("resolveSwarmCommand: %v", err)
	}
	if bin != "python" && bin != os.Getenv("TANGENT_PYTHON_BIN") {
		t.Errorf("bin = %q, want the python fallback (incompatible swarm on PATH must not be used)", bin)
	}
	if len(args) != 2 || args[0] != "-m" || args[1] != "cli.main" {
		t.Errorf("leadingArgs = %v, want [-m cli.main]", args)
	}
}

func TestResolveSwarmCommand_NotFoundFallsBackToCheckout(t *testing.T) {
	withPath(t, minimalSystemPath(t)) // no swarm anywhere on PATH
	repoRoot := fakeRepoRoot(t, true)

	bin, args, err := resolveSwarmCommand(repoRoot)
	if err != nil {
		t.Fatalf("resolveSwarmCommand: %v", err)
	}
	if bin != "python" {
		t.Errorf("bin = %q, want \"python\" (default TANGENT_PYTHON_BIN)", bin)
	}
	if len(args) != 2 || args[0] != "-m" || args[1] != "cli.main" {
		t.Errorf("leadingArgs = %v, want [-m cli.main]", args)
	}
}

func TestResolveSwarmCommand_NeitherViableErrorsClearly(t *testing.T) {
	withPath(t, minimalSystemPath(t)) // no swarm on PATH
	repoRoot := fakeRepoRoot(t, false) // and no checkout either

	_, _, err := resolveSwarmCommand(repoRoot)
	if err == nil {
		t.Fatal("resolveSwarmCommand: want an error when neither a standalone swarm nor a checkout is available, got nil")
	}
	msg := err.Error()
	if !strings.Contains(msg, "no usable swarm engine") {
		t.Errorf("error message %q doesn't name the actual problem", msg)
	}
	// repoRoot is embedded via %q, which doubles backslashes on Windows —
	// compare against filepath.Base (no separators, unaffected by that
	// escaping) rather than the raw path.
	if !strings.Contains(msg, filepath.Base(repoRoot)) {
		t.Errorf("error message %q doesn't mention the repoRoot that was checked (%q)", msg, repoRoot)
	}
}
