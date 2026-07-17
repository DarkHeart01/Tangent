"""Layered config loader: defaults → user home → project dir → env → CLI overrides."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

import yaml

from configs.schema import AgentSpec, SwarmConfig, ToolSpec, TopologySpec


def _load_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def load_swarm_config(cli_overrides: Optional[dict[str, Any]] = None) -> SwarmConfig:
    """
    Merge layers in order (last wins):
      1. package defaults.yaml
      2. ~/.swarm/config.yaml
      3. ./.swarm.yaml  (project)
      4. environment variables (GROQ_API_KEY, SWARM_*)
      5. cli_overrides dict
    """
    defaults_path = Path(__file__).parent / "defaults.yaml"
    user_path = Path.home() / ".swarm" / "config.yaml"
    project_path = Path(".swarm.yaml")

    merged: dict[str, Any] = {}
    for p in [defaults_path, user_path, project_path]:
        merged.update(_load_yaml(p))

    if cli_overrides:
        merged.update({k: v for k, v in cli_overrides.items() if v is not None})

    return SwarmConfig(**merged)


_PROMPT_FRAGMENTS_DIR = Path(__file__).parent / "prompt_fragments"
_CODING_CORE_FRAGMENT = _PROMPT_FRAGMENTS_DIR / "coding_core.md"


def load_agent_spec(path: Path) -> AgentSpec:
    data = _load_yaml(path)
    try:
        spec = AgentSpec.model_validate(data)
    except Exception as exc:
        from core.exceptions import SpecValidationError
        raise SpecValidationError(str(path), str(exc)) from exc

    if spec.code_context and _CODING_CORE_FRAGMENT.exists():
        fragment = _CODING_CORE_FRAGMENT.read_text(encoding="utf-8").strip()
        spec = spec.model_copy(update={"system_prompt": f"{fragment}\n\n{spec.system_prompt}"})

    return spec


def load_tool_spec(path: Path) -> ToolSpec:
    data = _load_yaml(path)
    try:
        return ToolSpec.model_validate(data)
    except Exception as exc:
        from core.exceptions import SpecValidationError
        raise SpecValidationError(str(path), str(exc)) from exc


def load_topology_spec(path: Path) -> TopologySpec:
    data = _load_yaml(path)
    try:
        return TopologySpec.model_validate(data)
    except Exception as exc:
        from core.exceptions import SpecValidationError
        raise SpecValidationError(str(path), str(exc)) from exc
