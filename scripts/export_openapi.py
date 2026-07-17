"""Regenerate the static OpenAPI specs used by docs/api/swagger-ui.html.

Run from repo root:
    OPENAI_API_KEY=dummy python scripts/export_openapi.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def export_promptforge() -> None:
    backend_dir = REPO_ROOT / "devforge-frontend" / "backend"
    os.environ.setdefault("OPENAI_API_KEY", "dummy-for-schema-export")
    sys.path.insert(0, str(backend_dir))
    cwd = os.getcwd()
    os.chdir(backend_dir)
    try:
        from main import app  # type: ignore[import-not-found]
        spec = app.openapi()
    finally:
        os.chdir(cwd)
        sys.path.remove(str(backend_dir))

    out = backend_dir / "openapi.json"
    out.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    print(f"wrote {out} ({len(spec['paths'])} paths)")


def export_swarm() -> None:
    sys.path.insert(0, str(REPO_ROOT))
    from api.server import app  # type: ignore[import-not-found]
    spec = app.openapi()

    out = REPO_ROOT / "docs" / "api" / "swarm-openapi.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    print(f"wrote {out} ({len(spec['paths'])} paths)")


if __name__ == "__main__":
    export_promptforge()
    export_swarm()
