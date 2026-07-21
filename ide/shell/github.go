package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

type GitHubStatus struct {
	Available     bool   `json:"available"`
	Authenticated bool   `json:"authenticated"`
	Login         string `json:"login"`
	Reason        string `json:"reason"`
	GitHubRemote  bool   `json:"is_github_remote"`
}

type GitHubPR struct {
	Exists      bool   `json:"exists"`
	Number      int    `json:"number"`
	Title       string `json:"title"`
	Author      string `json:"author"`
	URL         string `json:"url"`
	CheckStatus string `json:"check_status"`
}

type GitHubPRListItem struct {
	Number     int    `json:"number"`
	Title      string `json:"title"`
	Author     string `json:"author"`
	HeadBranch string `json:"head_branch"`
	URL        string `json:"url"`
}

type GitHubCommit struct {
	Message string `json:"message"`
}

type ghAuthor struct {
	Login string `json:"login"`
}

type ghCheck struct {
	Conclusion string `json:"conclusion"`
	Status     string `json:"status"`
	State      string `json:"state"`
}

type ghPRRaw struct {
	Number            int       `json:"number"`
	Title             string    `json:"title"`
	Author            ghAuthor  `json:"author"`
	URL               string    `json:"url"`
	StatusCheckRollup []ghCheck `json:"statusCheckRollup"`
}

func runGH(root string, args ...string) (string, error) {
	if _, err := exec.LookPath("gh"); err != nil {
		return "", fmt.Errorf("gh CLI is not installed")
	}
	absRoot, err := workspaceRoot(root)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", args...)
	cmd.Dir = absRoot
	output, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return "", fmt.Errorf("gh %s timed out", strings.Join(args, " "))
	}
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return "", fmt.Errorf("gh %s: %s", strings.Join(args, " "), message)
	}
	return string(output), nil
}

func githubRemote(root string) bool {
	remote, err := runGit(root, "remote", "get-url", "origin")
	if err != nil {
		return false
	}
	value := strings.ToLower(strings.TrimSpace(remote))
	return strings.Contains(value, "github.com")
}

func (s *SessionAPI) GitHubStatus(root string) (GitHubStatus, error) {
	status := GitHubStatus{Reason: "workspace is not a GitHub repository"}
	if !githubRemote(root) {
		return status, nil
	}
	status.GitHubRemote = true
	if _, err := exec.LookPath("gh"); err != nil {
		status.Reason = "gh CLI is not installed"
		return status, nil
	}
	status.Available = true
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", "auth", "status")
	cmd.Dir, _ = workspaceRoot(root)
	output, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		status.Reason = "gh auth status timed out"
		return status, nil
	}
	text := string(output)
	loginPattern := regexp.MustCompile(`(?i)account\s+([A-Za-z0-9-]+)`)
	if match := loginPattern.FindStringSubmatch(text); len(match) == 2 {
		status.Login = match[1]
	}
	if err != nil {
		status.Reason = "gh CLI is not authenticated"
		return status, nil
	}
	status.Authenticated = true
	status.Reason = ""
	return status, nil
}

func githubCheckStatus(checks []ghCheck) string {
	if len(checks) == 0 {
		return "none"
	}
	for _, check := range checks {
		state := strings.ToUpper(check.State)
		conclusion := strings.ToUpper(check.Conclusion)
		if conclusion == "FAILURE" || conclusion == "CANCELLED" || conclusion == "TIMED_OUT" || state == "FAILURE" || state == "ERROR" {
			return "failure"
		}
	}
	for _, check := range checks {
		if strings.ToUpper(check.Status) == "IN_PROGRESS" || strings.ToUpper(check.Status) == "QUEUED" || strings.ToUpper(check.Status) == "PENDING" || strings.ToUpper(check.State) == "PENDING" {
			return "pending"
		}
	}
	return "success"
}

func decodePR(raw []byte) (GitHubPR, error) {
	var value ghPRRaw
	if err := json.Unmarshal(raw, &value); err != nil {
		return GitHubPR{}, err
	}
	return GitHubPR{Exists: value.Number > 0, Number: value.Number, Title: value.Title, Author: value.Author.Login, URL: value.URL, CheckStatus: githubCheckStatus(value.StatusCheckRollup)}, nil
}

func (s *SessionAPI) GitHubCurrentPR(root string) (GitHubPR, error) {
	output, err := runGH(root, "pr", "view", "--json", "number,title,author,statusCheckRollup,url")
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no pull requests found") || strings.Contains(strings.ToLower(err.Error()), "no pull request") {
			return GitHubPR{}, nil
		}
		return GitHubPR{}, err
	}
	return decodePR([]byte(output))
}

func (s *SessionAPI) GitHubDefaultBranch(root string) (string, error) {
	output, err := runGH(root, "repo", "view", "--json", "defaultBranchRef")
	if err != nil {
		return "", err
	}
	var value struct {
		DefaultBranchRef struct {
			Name string `json:"name"`
		} `json:"defaultBranchRef"`
	}
	if err := json.Unmarshal([]byte(output), &value); err != nil {
		return "", err
	}
	return value.DefaultBranchRef.Name, nil
}

func (s *SessionAPI) GitLog(root string, limit int) ([]GitHubCommit, error) {
	if limit < 1 || limit > 100 {
		limit = 20
	}
	output, err := runGit(root, "log", fmt.Sprintf("-%d", limit), "--pretty=format:%s")
	if err != nil {
		return nil, err
	}
	commits := []GitHubCommit{}
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		if strings.TrimSpace(line) != "" {
			commits = append(commits, GitHubCommit{Message: strings.TrimSpace(line)})
		}
	}
	return commits, nil
}

func (s *SessionAPI) GitHubCreatePR(root, title, body, base string) (GitHubPR, error) {
	if strings.TrimSpace(title) == "" {
		return GitHubPR{}, fmt.Errorf("pull request title is required")
	}
	if strings.TrimSpace(base) == "" {
		return GitHubPR{}, fmt.Errorf("pull request base branch is required")
	}
	if strings.ContainsAny(title+body+base, "\x00") {
		return GitHubPR{}, fmt.Errorf("invalid pull request input")
	}
	if _, err := runGH(root, "pr", "create", "--title", title, "--body", body, "--base", base); err != nil {
		return GitHubPR{}, err
	}
	return s.GitHubCurrentPR(root)
}

func (s *SessionAPI) GitHubListPRs(root string) ([]GitHubPRListItem, error) {
	output, err := runGH(root, "pr", "list", "--limit", "30", "--json", "number,title,author,headRefName,url")
	if err != nil {
		return nil, err
	}
	var raw []struct {
		Number      int      `json:"number"`
		Title       string   `json:"title"`
		Author      ghAuthor `json:"author"`
		HeadRefName string   `json:"headRefName"`
		URL         string   `json:"url"`
	}
	if err := json.Unmarshal([]byte(output), &raw); err != nil {
		return nil, err
	}
	result := make([]GitHubPRListItem, 0, len(raw))
	for _, item := range raw {
		result = append(result, GitHubPRListItem{Number: item.Number, Title: item.Title, Author: item.Author.Login, HeadBranch: item.HeadRefName, URL: item.URL})
	}
	return result, nil
}
