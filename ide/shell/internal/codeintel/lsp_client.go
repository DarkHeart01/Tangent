package codeintel

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// lspMessage covers all three JSON-RPC shapes the LSP wire protocol uses:
// a request/response has ID set, a notification has Method but no ID, and a
// response has either Result or Error but never Method.
type lspMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int            `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *lspError       `json:"error,omitempty"`
}

type lspError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// LSPClient is a minimal hand-rolled client for the subset of the Language
// Server Protocol this engine needs: initialize, didOpen/didChange (full
// document sync -- simpler and safer than computing incremental LSP ranges,
// and tree-sitter already does incremental parsing on the frontend side
// where per-keystroke performance actually matters), publishDiagnostics
// notifications, and hover. Framing is Content-Length-prefixed JSON-RPC over
// stdio, same as every real LSP server speaks. Hand-rolled rather than an
// external Go LSP library: the repo's go.mod has zero LSP/tree-sitter deps
// today and the needed surface here is narrow. A second Tier-A adapter
// (gopls, rust-analyzer) reuses this same client against a different spawn
// command.
type LSPClient struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader

	mu      sync.Mutex
	nextID  int
	pending map[int]chan lspMessage

	notify func(method string, params json.RawMessage)

	closeOnce sync.Once
	done      chan struct{}
}

// StartLSPClient spawns command (e.g. "typescript-language-server", ["--stdio"])
// with dir as its working directory and begins its read loop. notify is
// called for every server->client notification -- the adapter cares about
// "textDocument/publishDiagnostics", but keeping this generic costs nothing.
func StartLSPClient(dir, command string, args []string, notify func(method string, params json.RawMessage)) (*LSPClient, error) {
	cmd := exec.Command(command, args...)
	cmd.Dir = dir

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("lsp stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("lsp stdout pipe: %w", err)
	}
	// Without this, a crashing or misbehaving language server fails silently
	// -- Go discards a nil Stderr rather than inheriting the parent's.
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("lsp start %s: %w", command, err)
	}

	c := &LSPClient{
		cmd:     cmd,
		stdin:   stdin,
		stdout:  bufio.NewReader(stdout),
		pending: make(map[int]chan lspMessage),
		notify:  notify,
		done:    make(chan struct{}),
	}
	go c.readLoop()
	return c, nil
}

func (c *LSPClient) send(msg lspMessage) error {
	body, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := fmt.Fprintf(c.stdin, "Content-Length: %d\r\n\r\n", len(body)); err != nil {
		return err
	}
	_, err = c.stdin.Write(body)
	return err
}

func (c *LSPClient) sendNotification(method string, params any) error {
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return c.send(lspMessage{JSONRPC: "2.0", Method: method, Params: raw})
}

func (c *LSPClient) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	c.nextID++
	id := c.nextID
	respCh := make(chan lspMessage, 1)
	c.pending[id] = respCh
	c.mu.Unlock()

	if err := c.send(lspMessage{JSONRPC: "2.0", ID: &id, Method: method, Params: raw}); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, err
	}

	select {
	case resp := <-respCh:
		if resp.Error != nil {
			return nil, fmt.Errorf("lsp %s: %s", method, resp.Error.Message)
		}
		return resp.Result, nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, ctx.Err()
	case <-c.done:
		return nil, fmt.Errorf("lsp client closed while waiting for %s", method)
	}
}

// readLoop mirrors TerminalManager.readOutput's shape (ide/shell/terminal.go):
// a tight blocking read loop wrapped in recover() so a torn-down process pipe
// can't crash the whole Wails app.
func (c *LSPClient) readLoop() {
	defer func() { _ = recover() }()
	defer close(c.done)
	for {
		msg, err := c.readMessage()
		if err != nil {
			return
		}

		switch {
		case msg.Method != "" && msg.ID == nil:
			// Server->client notification (e.g. publishDiagnostics).
			if c.notify != nil {
				c.notify(msg.Method, msg.Params)
			}
		case msg.Method != "" && msg.ID != nil:
			// Server->client request (e.g. workspace/configuration,
			// client/registerCapability). We don't implement any of these;
			// ack with a null result so the server doesn't hang waiting.
			_ = c.send(lspMessage{JSONRPC: "2.0", ID: msg.ID, Result: json.RawMessage("null")})
		case msg.ID != nil:
			c.mu.Lock()
			ch := c.pending[*msg.ID]
			delete(c.pending, *msg.ID)
			c.mu.Unlock()
			if ch != nil {
				ch <- msg
			}
		}
	}
}

func (c *LSPClient) readMessage() (lspMessage, error) {
	contentLength := -1
	for {
		line, err := c.stdout.ReadString('\n')
		if err != nil {
			return lspMessage{}, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		if name, value, ok := strings.Cut(line, ":"); ok && strings.EqualFold(strings.TrimSpace(name), "content-length") {
			n, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil {
				return lspMessage{}, fmt.Errorf("lsp: bad Content-Length %q: %w", value, err)
			}
			contentLength = n
		}
	}
	if contentLength < 0 {
		return lspMessage{}, fmt.Errorf("lsp: message with no Content-Length header")
	}
	buf := make([]byte, contentLength)
	if _, err := io.ReadFull(c.stdout, buf); err != nil {
		return lspMessage{}, err
	}
	var msg lspMessage
	if err := json.Unmarshal(buf, &msg); err != nil {
		return lspMessage{}, fmt.Errorf("lsp: decode message: %w", err)
	}
	return msg, nil
}

func (c *LSPClient) Initialize(ctx context.Context, rootURI string) error {
	params := map[string]any{
		"processId": nil,
		"rootUri":   rootURI,
		"capabilities": map[string]any{
			"textDocument": map[string]any{
				"publishDiagnostics": map[string]any{},
				"hover":              map[string]any{"contentFormat": []string{"plaintext", "markdown"}},
				"synchronization":    map[string]any{"didSave": true},
			},
		},
	}
	if _, err := c.request(ctx, "initialize", params); err != nil {
		return err
	}
	return c.sendNotification("initialized", map[string]any{})
}

func (c *LSPClient) DidOpen(uri, languageID, text string) error {
	return c.sendNotification("textDocument/didOpen", map[string]any{
		"textDocument": map[string]any{
			"uri": uri, "languageId": languageID, "version": 1, "text": text,
		},
	})
}

// DidChange uses full-document sync (send the whole current text on every
// call) rather than incremental LSP ranges -- simpler, and cheap enough at
// the file sizes a single editor buffer holds.
func (c *LSPClient) DidChange(uri string, version int, text string) error {
	return c.sendNotification("textDocument/didChange", map[string]any{
		"textDocument":   map[string]any{"uri": uri, "version": version},
		"contentChanges": []map[string]any{{"text": text}},
	})
}

// DidClose lets the server release whatever project-wide analysis state it
// was holding for uri -- call when a tab closes so a long session doesn't
// accumulate unbounded server-side state for files no longer open.
func (c *LSPClient) DidClose(uri string) error {
	return c.sendNotification("textDocument/didClose", map[string]any{
		"textDocument": map[string]any{"uri": uri},
	})
}

// Hover backs Tier-A signature resolution: wrap the language server's own
// hover text rather than reimplementing type inference (spec ??4).
func (c *LSPClient) Hover(ctx context.Context, uri string, line, char int) (string, error) {
	result, err := c.request(ctx, "textDocument/hover", map[string]any{
		"textDocument": map[string]any{"uri": uri},
		"position":     map[string]any{"line": line, "character": char},
	})
	if err != nil || result == nil {
		return "", err
	}

	var hover struct {
		Contents json.RawMessage `json:"contents"`
	}
	if err := json.Unmarshal(result, &hover); err != nil || hover.Contents == nil {
		return "", nil
	}

	var asString string
	if json.Unmarshal(hover.Contents, &asString) == nil && asString != "" {
		return asString, nil
	}
	var asMarkup struct {
		Value string `json:"value"`
	}
	if json.Unmarshal(hover.Contents, &asMarkup) == nil && asMarkup.Value != "" {
		return asMarkup.Value, nil
	}
	return "", nil
}

func (c *LSPClient) Close() {
	c.closeOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, _ = c.request(ctx, "shutdown", nil)
		_ = c.sendNotification("exit", nil)
		_ = c.stdin.Close()
		if c.cmd.Process != nil {
			_ = c.cmd.Process.Kill()
		}
	})
}
