package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Provider-key management for the swarm. This is IDE control-plane wiring only:
// the real swarm (cli/main.py) does load_dotenv(override=False) from its cwd,
// which LaunchSwarmProcess sets to the repo root — so the single source of
// truth for provider credentials is the repo-root .env. These bindings let the
// Agent Swarm tab read the *status* of that file (never the secret values) and
// upsert a key into it, without the swarm core being touched.

// envVarForProvider maps a provider id to the env var the Python side reads
// (cli/main.py: --openrouter-api-key envvar="OPENROUTER_API_KEY", etc.).
var envVarForProvider = map[string]string{
	"openrouter": "OPENROUTER_API_KEY",
	"groq":       "GROQ_API_KEY",
	"gemini":     "GEMINI_API_KEY",
	"openai":     "OPENAI_API_KEY",
}

type ProviderKeyStatus struct {
	EnvPath        string          `json:"env_path"`
	ActiveProvider string          `json:"active_provider"`
	Configured     map[string]bool `json:"configured"`      // provider id -> key present (in .env or process env)
	DefaultModel   string          `json:"default_model"`   // SWARM_DEFAULT_MODEL, if set
	KnownProviders []string        `json:"known_providers"` // stable, sorted list for the UI
}

func repoEnvPath() (string, error) {
	repo, err := repoRoot()
	if err != nil {
		return "", err
	}
	abs, err := filepath.Abs(repo)
	if err != nil {
		return "", err
	}
	return filepath.Join(abs, ".env"), nil
}

// parseEnvFile reads KEY=VALUE lines from an .env file. Missing file is not an
// error (returns an empty map). Values are returned raw (quotes stripped) but
// this is only used to test presence, never to hand a secret back to the UI.
func parseEnvFile(path string) (map[string]string, error) {
	out := map[string]string{}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return out, nil
		}
		return nil, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		val = strings.Trim(val, `"'`)
		out[key] = val
	}
	return out, scanner.Err()
}

func knownProviderIDs() []string {
	ids := make([]string, 0, len(envVarForProvider))
	for id := range envVarForProvider {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// GetProviderKeyStatus reports which providers have a key configured, without
// ever returning the key itself. A key counts as configured if it is present
// in the repo-root .env OR already in the running process environment.
func (s *SessionAPI) GetProviderKeyStatus() (ProviderKeyStatus, error) {
	envPath, err := repoEnvPath()
	if err != nil {
		return ProviderKeyStatus{}, err
	}
	fileEnv, err := parseEnvFile(envPath)
	if err != nil {
		return ProviderKeyStatus{}, err
	}
	configured := map[string]bool{}
	for id, varName := range envVarForProvider {
		configured[id] = strings.TrimSpace(fileEnv[varName]) != "" || strings.TrimSpace(os.Getenv(varName)) != ""
	}
	active := fileEnv["SWARM_PROVIDER"]
	if active == "" {
		active = os.Getenv("SWARM_PROVIDER")
	}
	if active == "" {
		active = "openrouter" // cli/main.py default
	}
	model := fileEnv["SWARM_DEFAULT_MODEL"]
	if model == "" {
		model = os.Getenv("SWARM_DEFAULT_MODEL")
	}
	return ProviderKeyStatus{
		EnvPath:        envPath,
		ActiveProvider: active,
		Configured:     configured,
		DefaultModel:   model,
		KnownProviders: knownProviderIDs(),
	}, nil
}

// SetProviderKey upserts a provider's API key into the repo-root .env and sets
// SWARM_PROVIDER to that provider (and SWARM_DEFAULT_MODEL when given). It
// preserves every other line in the file and never logs the key. Passing an
// empty key removes that provider's line.
func (s *SessionAPI) SetProviderKey(provider, key, model string) error {
	varName, ok := envVarForProvider[provider]
	if !ok {
		return fmt.Errorf("unknown provider %q", provider)
	}
	envPath, err := repoEnvPath()
	if err != nil {
		return err
	}

	updates := map[string]string{
		"SWARM_PROVIDER": provider,
	}
	if strings.TrimSpace(key) != "" {
		updates[varName] = strings.TrimSpace(key)
	}
	if strings.TrimSpace(model) != "" {
		updates["SWARM_DEFAULT_MODEL"] = strings.TrimSpace(model)
	}

	if err := upsertEnvFile(envPath, updates); err != nil {
		return err
	}
	// Also set it in this process's env so a session started in the same run
	// picks it up even though load_dotenv reads the file too.
	for k, v := range updates {
		_ = os.Setenv(k, v)
	}
	appendLog("[provider] updated .env for provider " + provider)
	return nil
}

// upsertEnvFile rewrites path with the given keys set to the given values,
// replacing any existing (including commented `# KEY=`) definition in place and
// appending the rest. Other content is preserved verbatim.
func upsertEnvFile(path string, updates map[string]string) error {
	var lines []string
	if data, err := os.ReadFile(path); err == nil {
		lines = strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	} else if !os.IsNotExist(err) {
		return err
	}

	applied := map[string]bool{}
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		bare := strings.TrimSpace(strings.TrimPrefix(trimmed, "#"))
		for key, val := range updates {
			if strings.HasPrefix(bare, key+"=") {
				lines[i] = key + "=" + val
				applied[key] = true
				break
			}
		}
	}
	for key, val := range updates {
		if !applied[key] {
			lines = append(lines, key+"="+val)
		}
	}

	out := strings.Join(lines, "\n")
	if !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(out), 0o600)
}
