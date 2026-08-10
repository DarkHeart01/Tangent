package codeintel

import "testing"

func TestExtractEnvVarUsage(t *testing.T) {
	files := map[string]string{
		"src/db.ts": `const url = process.env.DATABASE_URL;\nconst key = process.env["STRIPE_SECRET_KEY"];`,
		"app.py":    "port = os.environ.get('PORT')\ndebug = os.getenv(\"DEBUG\")\nurl = os.environ['DATABASE_URL']",
		"README.md": "no env vars mentioned here, just process.env as a phrase without a dot-name",
	}

	got := ExtractEnvVarUsage(files)
	want := []string{"DATABASE_URL", "DEBUG", "PORT", "STRIPE_SECRET_KEY"}

	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestDiffEnvFile(t *testing.T) {
	existing := `# database
DATABASE_URL=postgres://localhost/db

PORT=3000
`
	detected := []string{"DATABASE_URL", "PORT", "STRIPE_SECRET_KEY", "DEBUG"}

	missing := DiffEnvFile(existing, detected)
	want := map[string]bool{"STRIPE_SECRET_KEY": true, "DEBUG": true}

	if len(missing) != len(want) {
		t.Fatalf("got %v, want keys of %v", missing, want)
	}
	for _, m := range missing {
		if !want[m] {
			t.Errorf("unexpected missing var %q", m)
		}
	}
}

func TestDiffEnvFileEmptyExisting(t *testing.T) {
	missing := DiffEnvFile("", []string{"A", "B"})
	if len(missing) != 2 {
		t.Fatalf("expected both vars missing from an empty file, got %v", missing)
	}
}

func TestDiffEnvFileNothingMissing(t *testing.T) {
	existing := "A=1\nB=2\n"
	missing := DiffEnvFile(existing, []string{"A", "B"})
	if len(missing) != 0 {
		t.Fatalf("expected nothing missing, got %v", missing)
	}
}
