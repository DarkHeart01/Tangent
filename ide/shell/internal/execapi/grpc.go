package execapi

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "shell/internal/execapigrpc/pb"
)

// grpcHandler implements all three generated service interfaces by
// delegating to *Server's already-extracted shared logic (runExec,
// readFile, writeFile, requestGate in server.go/gate.go) — the exact same
// functions the HTTP handlers call, not a reimplementation.
type grpcHandler struct {
	pb.UnimplementedExecServer
	pb.UnimplementedFilesystemServer
	pb.UnimplementedGateServer
	srv *Server
}

type sessionCtxKey struct{}

type grpcSession struct {
	SessionInfo
	sessionID string
}

// authInterceptor mirrors Server.authenticate for gRPC: session_id and the
// bearer token travel as metadata ("x-session-id", "authorization")
// instead of a URL path segment + header — a gRPC message has no URL —
// same authentication semantics as the HTTP path, different transport.
func (s *Server) authInterceptor(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return nil, status.Error(codes.Unauthenticated, "missing metadata")
	}
	sessionID := firstMeta(md, "x-session-id")
	if sessionID == "" {
		return nil, status.Error(codes.Unauthenticated, "missing x-session-id metadata")
	}
	sessInfo, ok := s.lookup(sessionID)
	if !ok {
		return nil, status.Error(codes.NotFound, "unknown session")
	}
	token, found := strings.CutPrefix(firstMeta(md, "authorization"), "Bearer ")
	if !found || token != sessInfo.Token {
		return nil, status.Error(codes.Unauthenticated, "unauthorized")
	}

	ctx = context.WithValue(ctx, sessionCtxKey{}, grpcSession{SessionInfo: sessInfo, sessionID: sessionID})
	return handler(ctx, req)
}

func firstMeta(md metadata.MD, key string) string {
	vals := md.Get(key)
	if len(vals) == 0 {
		return ""
	}
	return vals[0]
}

func sessionFromContext(ctx context.Context) (grpcSession, error) {
	sess, ok := ctx.Value(sessionCtxKey{}).(grpcSession)
	if !ok {
		return grpcSession{}, status.Error(codes.Internal, "no session in context (auth interceptor not wired?)")
	}
	return sess, nil
}

// ── Exec ─────────────────────────────────────────────────────────────────

func (h *grpcHandler) Run(ctx context.Context, req *pb.ExecRequest) (*pb.ExecResponse, error) {
	sess, err := sessionFromContext(ctx)
	if err != nil {
		return nil, err
	}
	// explicitTimeout=0: no timeout_seconds field on pb.ExecRequest by
	// design (see execapi.proto) — runExec derives it from ctx's own
	// deadline instead.
	result, err := h.srv.runExec(ctx, sess.sessionID, sess.SessionInfo, req.GetCommand(), req.GetWorkingDir(), 0)
	if err != nil {
		var ve *validationError
		if errors.As(err, &ve) {
			return nil, status.Error(codes.InvalidArgument, err.Error())
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &pb.ExecResponse{
		Stdout: result.Stdout, Stderr: result.Stderr, Returncode: int32(result.ReturnCode),
	}, nil
}

// ── Filesystem ───────────────────────────────────────────────────────────

func (h *grpcHandler) Read(ctx context.Context, req *pb.FileReadRequest) (*pb.FileReadResponse, error) {
	sess, err := sessionFromContext(ctx)
	if err != nil {
		return nil, err
	}
	data, err := h.srv.readFile(sess.sessionID, sess.SessionInfo, req.GetPath())
	if err != nil {
		var ve *validationError
		var nf *notFoundError
		switch {
		case errors.As(err, &ve):
			return nil, status.Error(codes.InvalidArgument, err.Error())
		case errors.As(err, &nf):
			return nil, status.Error(codes.NotFound, err.Error())
		default:
			return nil, status.Error(codes.Internal, err.Error())
		}
	}
	return &pb.FileReadResponse{Content: data}, nil
}

func (h *grpcHandler) Write(ctx context.Context, req *pb.FileWriteRequest) (*pb.FileWriteResponse, error) {
	sess, err := sessionFromContext(ctx)
	if err != nil {
		return nil, err
	}
	written, err := h.srv.writeFile(sess.sessionID, sess.SessionInfo, req.GetPath(), req.GetContent())
	if err != nil {
		var ve *validationError
		if errors.As(err, &ve) {
			return nil, status.Error(codes.InvalidArgument, err.Error())
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &pb.FileWriteResponse{BytesWritten: int64(written)}, nil
}

// ── Gate ─────────────────────────────────────────────────────────────────

var pbKindToString = map[pb.GateKind]string{
	pb.GateKind_GATE_KIND_PHASE:     "phase",
	pb.GateKind_GATE_KIND_TOOL_CALL: "tool_call",
	pb.GateKind_GATE_KIND_QUESTION:  "question",
}

func (h *grpcHandler) Request(ctx context.Context, req *pb.GateRequest) (*pb.GateResponse, error) {
	sess, err := sessionFromContext(ctx)
	if err != nil {
		return nil, err
	}
	kind, ok := pbKindToString[req.GetKind()]
	if !ok {
		return nil, status.Errorf(codes.InvalidArgument, "unknown gate kind %v", req.GetKind())
	}

	// explicitTimeout=0: no timeout_seconds field on pb.GateRequest by
	// design — requestGate derives the wait timeout from ctx's own
	// deadline instead (see gateWaitTimeout in gate.go), the real
	// context/deadline-propagation wiring this migration exists to add,
	// not just a mechanical port of the HTTP behavior.
	result, err := h.srv.requestGate(ctx, sess.sessionID, gateRequest{
		Kind:           kind,
		PhaseID:        req.GetPhaseId(),
		PhaseName:      req.GetPhaseName(),
		ToolName:       req.GetToolName(),
		SideEffectTier: req.GetSideEffectTier(),
		ArgsSummary:    req.GetArgsSummary(),
		Prompt:         req.GetPrompt(),
		Options:        req.GetOptions(),
	}, 0)
	if err != nil {
		if ctx.Err() != nil {
			return nil, status.FromContextError(ctx.Err()).Err()
		}
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}

	if kind == "question" {
		return &pb.GateResponse{Result: &pb.GateResponse_Decision{Decision: result.Decision}}, nil
	}
	return &pb.GateResponse{Result: &pb.GateResponse_Approved{Approved: result.Decision == "approve"}}, nil
}

// ── lifecycle ────────────────────────────────────────────────────────────

// StartGRPC binds a second, separate OS-assigned port and begins serving
// the Exec/Filesystem/Gate services — alongside, not instead of, the
// existing HTTP server on s.port (removed only once real verification
// passes and every Python call site has been swapped over).
func (s *Server) StartGRPC() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	s.grpcListener = ln
	s.grpcPort = ln.Addr().(*net.TCPAddr).Port

	grpcSrv := grpc.NewServer(grpc.UnaryInterceptor(s.authInterceptor))
	handler := &grpcHandler{srv: s}
	pb.RegisterExecServer(grpcSrv, handler)
	pb.RegisterFilesystemServer(grpcSrv, handler)
	pb.RegisterGateServer(grpcSrv, handler)
	s.grpcSrv = grpcSrv

	go func() {
		_ = grpcSrv.Serve(ln)
	}()

	return s.grpcPort, nil
}

func (s *Server) StopGRPC() {
	if s.grpcSrv != nil {
		s.grpcSrv.GracefulStop()
	}
}

// GRPCTarget is what gets handed to the swarm subprocess as
// TANGENT_DAEMON_GRPC_TARGET — host:port, no scheme (grpc dial targets
// don't take one, unlike the HTTP BaseURL above).
func (s *Server) GRPCTarget() string {
	return fmt.Sprintf("127.0.0.1:%d", s.grpcPort)
}
