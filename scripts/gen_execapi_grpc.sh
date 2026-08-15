#!/usr/bin/env bash
# Regenerates the Go and Python execapi gRPC stubs from
# ide/shell/proto/execapi/v1/execapi.proto. The stubs are checked in (see
# Phase D of the gRPC-migration task this shipped with) — this script is
# for when the .proto changes, not run at build time.
#
# Requires on PATH: protoc, protoc-gen-go, protoc-gen-go-grpc (Go),
# and grpcio-tools installed in the active Python env (`pip install -e
# ".[dev]"` covers it).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROTO="ide/shell/proto/execapi/v1/execapi.proto"

cd "$REPO_ROOT"

echo "Generating Go stubs..."
mkdir -p ide/shell/internal/execapigrpc/pb
protoc --go_out=ide/shell --go_opt=module=shell \
       --go-grpc_out=ide/shell --go-grpc_opt=module=shell \
       "$PROTO"

echo "Generating Python stubs..."
rm -rf core/execapi_grpc
mkdir -p core/execapi_grpc
python -m grpc_tools.protoc \
  -I ide/shell/proto \
  --python_out=core/execapi_grpc \
  --grpc_python_out=core/execapi_grpc \
  --pyi_out=core/execapi_grpc \
  "$PROTO"

# grpc_tools.protoc emits `from execapi.v1 import execapi_pb2 as ...` in
# the _grpc.py file -- an import rooted at the proto's own package path,
# which only resolves if `execapi/` sits directly on sys.path. Every other
# module in this codebase imports absolutely from the repo root instead
# (`core.daemon_client`, `tools.shell_exec.handler`, ...), so patch the one
# generated line to match that convention rather than adding a bespoke
# sys.path entry just for this package.
GRPC_FILE="core/execapi_grpc/execapi/v1/execapi_pb2_grpc.py"
sed -i \
  's/from execapi\.v1 import execapi_pb2 as execapi_dot_v1_dot_execapi__pb2/from core.execapi_grpc.execapi.v1 import execapi_pb2 as execapi_dot_v1_dot_execapi__pb2/' \
  "$GRPC_FILE"

# Make every level a real importable package (grpc_tools does not emit
# __init__.py files).
touch core/execapi_grpc/__init__.py
touch core/execapi_grpc/execapi/__init__.py
touch core/execapi_grpc/execapi/v1/__init__.py

echo "Done:"
echo "  ide/shell/internal/execapigrpc/pb/execapi.pb.go"
echo "  ide/shell/internal/execapigrpc/pb/execapi_grpc.pb.go"
echo "  core/execapi_grpc/execapi/v1/execapi_pb2.py"
echo "  core/execapi_grpc/execapi/v1/execapi_pb2_grpc.py"
