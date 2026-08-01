package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// ArtifactEntry mirrors the fields of memory/artifact_schemas/base.py's
// CDDContract (plus the base ArtifactBase fields every artifact type has) —
// the real shape, not the {intent, diff_refs, reasoning, risks, tests_run}
// one the pre-existing simulator-only ContractEntry/GetContracts path used.
// full_document is the primary content; openapi_yaml/asyncapi_yaml/
// ci_pipeline_yaml are the only structured sub-documents that actually
// exist — everything else (examples, error contract, compat rules,
// Specmatic config) lives only as prose inside full_document.
type ArtifactEntry struct {
	ID             string   `json:"id"`
	ArtifactType   string   `json:"artifact_type"`
	Version        int      `json:"version"`
	StageID        string   `json:"stage_id,omitempty"`
	AuthorAgentID  string   `json:"author_agent_id,omitempty"`
	ProjectID      string   `json:"project_id,omitempty"`
	CreatedAt      string   `json:"created_at"`
	Status         string   `json:"status"`
	Lineage        []string `json:"lineage,omitempty"`
	ProjectName    string   `json:"project_name,omitempty"`
	ContractVer    string   `json:"contract_version,omitempty"`
	ContractStatus string   `json:"contract_status,omitempty"`
	ConsumerSvc    string   `json:"consumer_service,omitempty"`
	ProviderSvc    string   `json:"provider_service,omitempty"`
	PrimaryProto   string   `json:"primary_protocol,omitempty"`
	AsyncBroker    string   `json:"async_broker,omitempty"`
	FullDocument   string   `json:"full_document,omitempty"`
	OpenAPIYAML    string   `json:"openapi_yaml,omitempty"`
	AsyncAPIYAML   string   `json:"asyncapi_yaml,omitempty"`
	CIPipelineYAML string   `json:"ci_pipeline_yaml,omitempty"`
}

type artifactShowOutput struct {
	Artifact ArtifactEntry   `json:"artifact"`
	Lineage  []ArtifactEntry `json:"lineage"`
}

const artifactQueryTimeout = 30 * time.Second

// GetArtifact shells out to `swarm artifact show <id> --json --memory-dir
// <path>` (cli/main.py's existing artifact_show command) rather than
// holding any concurrent connection into the same ChromaDB persist
// directory a live swarm process may still be writing to — a short-lived
// subprocess per query, called only after a contract.emitted event has
// already confirmed the write landed.
func (s *SessionAPI) GetArtifact(sessionID, artifactID string) (ArtifactEntry, error) {
	sess, ok := s.manager.Get(sessionID)
	if !ok {
		return ArtifactEntry{}, fmt.Errorf("session %q not found", sessionID)
	}
	worktreePath := sess.GetWorktreePath()
	if worktreePath == "" {
		return ArtifactEntry{}, fmt.Errorf("session %q has no worktree yet", sessionID)
	}
	memoryDir := filepath.Join(worktreePath, "memory_store")

	root, err := repoRoot()
	if err != nil {
		return ArtifactEntry{}, err
	}
	pythonBin := os.Getenv("TANGENT_PYTHON_BIN")
	if pythonBin == "" {
		pythonBin = "python"
	}

	ctx, cancel := context.WithTimeout(context.Background(), artifactQueryTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, pythonBin,
		"-m", "cli.main", "artifact", "show", artifactID,
		"--json", "--memory-dir", memoryDir,
	)
	cmd.Dir = root

	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return ArtifactEntry{}, fmt.Errorf("swarm artifact show failed: %s", string(exitErr.Stderr))
		}
		return ArtifactEntry{}, fmt.Errorf("swarm artifact show failed: %w", err)
	}

	var parsed artifactShowOutput
	if err := json.Unmarshal(out, &parsed); err != nil {
		return ArtifactEntry{}, fmt.Errorf("parse artifact show output: %w", err)
	}
	return parsed.Artifact, nil
}
