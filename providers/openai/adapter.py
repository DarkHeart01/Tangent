"""OpenAI Chat Completions adapter for the Swarm provider interface.

The adapter intentionally follows the same transport contract as the Groq and
OpenRouter adapters: normalized completions, tool calls, streaming chunks,
token counting, cost estimation, tracing, and provider-specific exceptions.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from core.exceptions import ProviderError, RateLimitError
from core.task import TokenUsage
from observability.cost import estimate_cost
from observability.logutil import get_logger
from observability.tracing import Span, get_tracer
from providers.base import CompletionResult, LLMProvider, StreamChunk, ToolCall

log = get_logger("providers.openai")

DEFAULT_MODEL = "gpt-5.6"


def _load_sdk() -> Any:
    """Load the SDK lazily so offline registry discovery remains usable."""
    try:
        from openai import AsyncOpenAI
    except ImportError as exc:  # pragma: no cover - depends on installation extras
        raise ProviderError("OpenAI provider requires the 'openai' package") from exc
    return AsyncOpenAI


class OpenAIAdapter(LLMProvider):
    """OpenAI adapter using the official async SDK and Chat Completions API."""

    def __init__(
        self,
        api_key: str,
        default_model: str = DEFAULT_MODEL,
        organization: str | None = None,
        project: str | None = None,
        client: Any | None = None,
    ) -> None:
        if not api_key and client is None:
            raise ValueError("api_key is required unless a test client is supplied")
        self._default_model = default_model
        if client is not None:
            self._client = client
        else:
            sdk_client = _load_sdk()
            self._client = sdk_client(api_key=api_key, organization=organization, project=project)

    @property
    def name(self) -> str:
        return "openai"

    def _resolve_model(self, model: str | None) -> str:
        return model or self._default_model

    @staticmethod
    def _request_payload(
        messages: list[dict[str, Any]],
        model: str,
        tools: list[dict[str, Any]] | None,
        temperature: float,
        max_tokens: int | None,
        kwargs: dict[str, Any],
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        payload.update(kwargs)
        return payload

    @staticmethod
    def _normalize_error(exc: Exception) -> ProviderError:
        status = getattr(exc, "status_code", None)
        if status == 429 or exc.__class__.__name__ == "RateLimitError":
            return RateLimitError(str(exc))
        if status in {401, 403} or exc.__class__.__name__ in {
            "AuthenticationError",
            "PermissionDeniedError",
        }:
            return ProviderError(f"OpenAI authentication/permission error: {exc}")
        return ProviderError(str(exc))

    @staticmethod
    def _parse_tool_calls(message: Any) -> list[ToolCall]:
        parsed: list[ToolCall] = []
        for call in getattr(message, "tool_calls", None) or []:
            raw_arguments = getattr(getattr(call, "function", None), "arguments", "{}")
            try:
                arguments = json.loads(raw_arguments or "{}")
            except json.JSONDecodeError:
                arguments = {"raw": raw_arguments}
            function = getattr(call, "function", None)
            parsed.append(
                ToolCall(
                    id=getattr(call, "id", ""),
                    name=getattr(function, "name", ""),
                    arguments=arguments,
                )
            )
        return parsed

    @staticmethod
    def _usage(response: Any) -> TokenUsage:
        usage = getattr(response, "usage", None)
        if usage is None:
            return TokenUsage(input_tokens=0, output_tokens=0, total_tokens=0)
        input_tokens = int(getattr(usage, "prompt_tokens", getattr(usage, "input_tokens", 0)) or 0)
        output_tokens = int(
            getattr(usage, "completion_tokens", getattr(usage, "output_tokens", 0)) or 0
        )
        total_tokens = int(getattr(usage, "total_tokens", input_tokens + output_tokens) or 0)
        return TokenUsage(
            input_tokens=input_tokens, output_tokens=output_tokens, total_tokens=total_tokens
        )

    @retry(
        retry=retry_if_exception_type(RateLimitError),
        wait=wait_exponential(multiplier=1, min=2, max=60),
        stop=stop_after_attempt(5),
        reraise=True,
    )
    async def complete(
        self,
        messages: list[dict[str, Any]],
        model: str,
        tools: list[dict[str, Any]] | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
        **kwargs: Any,
    ) -> CompletionResult:
        resolved_model = self._resolve_model(model)
        payload = self._request_payload(
            messages, resolved_model, tools, temperature, max_tokens, kwargs
        )
        tracer = get_tracer()
        with Span(tracer, "openai.complete", "llm", model=resolved_model) as span:
            try:
                response = await self._client.chat.completions.create(**payload)
            except Exception as exc:
                normalized = self._normalize_error(exc)
                log.warning("openai_completion_error", model=resolved_model, error=str(normalized))
                raise normalized from exc

            choice = response.choices[0]
            message = choice.message
            tool_calls = self._parse_tool_calls(message)
            usage = self._usage(response)
            cost = self.estimate_cost(usage, resolved_model)
            span.set(
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                cost=cost,
                tool_calls=len(tool_calls),
                finish_reason=choice.finish_reason,
            )
            return CompletionResult(
                content=getattr(message, "content", None),
                tool_calls=tool_calls,
                usage=usage,
                model=resolved_model,
                finish_reason=choice.finish_reason or "stop",
            )

    async def stream(
        self,
        messages: list[dict[str, Any]],
        model: str,
        tools: list[dict[str, Any]] | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[StreamChunk]:
        resolved_model = self._resolve_model(model)
        payload = self._request_payload(
            messages, resolved_model, tools, temperature, max_tokens, kwargs
        )
        payload["stream"] = True
        try:
            stream = await self._client.chat.completions.create(**payload)
            async for chunk in stream:
                if not getattr(chunk, "choices", None):
                    continue
                choice = chunk.choices[0]
                delta = getattr(choice, "delta", None)
                content = getattr(delta, "content", None) if delta else None
                if content:
                    yield StreamChunk(
                        delta=content, finish_reason=getattr(choice, "finish_reason", None)
                    )
        except Exception as exc:
            normalized = self._normalize_error(exc)
            log.warning("openai_stream_error", model=resolved_model, error=str(normalized))
            raise normalized from exc

    def count_tokens(self, text: str, model: str) -> int:
        try:
            import tiktoken

            encoding = tiktoken.encoding_for_model(self._resolve_model(model))
            return len(encoding.encode(text))
        except (ImportError, KeyError, ValueError):
            return max(1, len(text) // 4)

    def estimate_cost(self, usage: TokenUsage, model: str) -> float:
        return estimate_cost(usage, self._resolve_model(model))
