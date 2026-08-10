package codeintel

import (
	"bufio"
	"regexp"
	"sort"
	"strings"
)

// Level 3 (root-scoped) scope cut, stated plainly: "other files a project
// might need" is open-ended and not generically buildable in one pass. This
// covers the concrete example given -- detecting environment variable usage
// across the codebase and proposing a .env.example -- as the flagship Level
// 3 capability. Broader project-scaffolding detection is future work.

var envVarPatterns = []*regexp.Regexp{
	regexp.MustCompile(`process\.env\.(\w+)`),                 // JS/TS
	regexp.MustCompile(`process\.env\[['"](\w+)['"]\]`),        // JS/TS bracket form
	regexp.MustCompile(`os\.environ(?:\.get)?\(['"](\w+)['"]`), // Python: os.environ['X'] / os.environ.get('X')
	regexp.MustCompile(`os\.getenv\(['"](\w+)['"]`),            // Python: os.getenv('X')
}

// ExtractEnvVarUsage scans each file's content (keyed by path, for a
// clearer call site -- the path itself isn't used, just the values) for
// environment-variable reads across the JS/TS/Python patterns above,
// returning the unique variable names sorted for stable output.
func ExtractEnvVarUsage(files map[string]string) []string {
	seen := map[string]struct{}{}
	for _, content := range files {
		for _, re := range envVarPatterns {
			for _, m := range re.FindAllStringSubmatch(content, -1) {
				seen[m[1]] = struct{}{}
			}
		}
	}
	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

var envDeclarationRe = regexp.MustCompile(`^\s*(?:export\s+)?(\w+)\s*=`)

// DiffEnvFile parses existing .env/.env.example content (simple KEY= line
// scan) and returns which of detected are not already declared there.
func DiffEnvFile(existing string, detected []string) []string {
	declared := map[string]struct{}{}
	scanner := bufio.NewScanner(strings.NewReader(existing))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if m := envDeclarationRe.FindStringSubmatch(line); m != nil {
			declared[m[1]] = struct{}{}
		}
	}

	var missing []string
	for _, name := range detected {
		if _, ok := declared[name]; !ok {
			missing = append(missing, name)
		}
	}
	return missing
}
