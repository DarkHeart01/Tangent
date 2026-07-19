// Package wsserver hosts the raw WebSocket event stream. It binds to
// 127.0.0.1 only and runs inside the same process as the Wails control
// plane — there is no separate daemon binary.
//
// Per connection there is exactly one writer goroutine (gorilla's
// websocket.Conn forbids concurrent writers). Per session there is exactly
// one reader goroutine — Session.fanoutLoop in the session package — that
// reads newly emitted envelopes and feeds every subscribed connection.
package wsserver

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"

	"shell/internal/session"
)

type Server struct {
	manager  *session.Manager
	token    string
	port     int
	listener net.Listener
	httpSrv  *http.Server
	upgrader websocket.Upgrader
}

func New(manager *session.Manager) (*Server, error) {
	token, err := generateToken()
	if err != nil {
		return nil, err
	}
	return &Server{
		manager: manager,
		token:   token,
		upgrader: websocket.Upgrader{
			// Bound to 127.0.0.1 and gated by a per-launch token; the only
			// client is this app's own frontend, so origin is not checked.
			CheckOrigin:     func(r *http.Request) bool { return true },
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
		},
	}, nil
}

func generateToken() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// Start binds an OS-assigned free port on 127.0.0.1 and begins serving.
func (s *Server) Start() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	s.listener = ln
	s.port = ln.Addr().(*net.TCPAddr).Port

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	s.httpSrv = &http.Server{Handler: mux}

	go func() {
		if err := s.httpSrv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("wsserver: serve error: %v", err)
		}
	}()

	return s.port, nil
}

func (s *Server) Stop() error {
	if s.httpSrv == nil {
		return nil
	}
	return s.httpSrv.Close()
}

// SessionURL builds the browser-facing WS URL for a given session, carrying
// the per-launch auth token as a query parameter.
func (s *Server) SessionURL(sessionID string) string {
	return fmt.Sprintf("ws://127.0.0.1:%d/ws?session_id=%s&token=%s", s.port, sessionID, s.token)
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("token") != s.token {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	sessionID := r.URL.Query().Get("session_id")
	sess, ok := s.manager.Get(sessionID)
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("wsserver: upgrade error: %v", err)
		return
	}
	defer conn.Close()

	// Subscribe atomically returns full history-so-far plus a live channel
	// for everything emitted after this point — reconnecting mid-session
	// replays from seq 0 with no gap and no duplicate (the client dedupes
	// by seq, see frontend/src/lib/wsClient.ts).
	subID, history, live := sess.Subscribe()

	writeCh := make(chan session.Envelope, 256)
	stop := make(chan struct{})
	var stopOnce sync.Once
	closeStop := func() { stopOnce.Do(func() { close(stop) }) }

	var wg sync.WaitGroup
	wg.Add(2)

	// The single writer goroutine for this connection.
	go func() {
		defer wg.Done()
		for {
			select {
			case env, ok := <-writeCh:
				if !ok {
					return
				}
				if err := conn.WriteJSON(env); err != nil {
					closeStop()
					return
				}
			case <-stop:
				return
			}
		}
	}()

	// Feeds this connection: replay history in order, then forward the
	// session's live fanout.
	go func() {
		defer wg.Done()
		defer sess.Unsubscribe(subID)
		for _, env := range history {
			select {
			case writeCh <- env:
			case <-stop:
				return
			}
		}
		for {
			select {
			case env, ok := <-live:
				if !ok {
					return
				}
				select {
				case writeCh <- env:
				case <-stop:
					return
				}
			case <-stop:
				return
			}
		}
	}()

	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			break
		}
	}
	closeStop()
	wg.Wait()
}
