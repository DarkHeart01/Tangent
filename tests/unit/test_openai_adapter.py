from __future__ import annotations

from types import SimpleNamespace

import pytest

from core.exceptions import ProviderError, RateLimitError
from providers.openai.adapter import OpenAIAdapter


class FakeCompletions:
    def __init__(self, response):
        self.response = response
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.response


class FakeClient:
    def __init__(self, response):
        self.chat = SimpleNamespace(completions=FakeCompletions(response))


def completion_response():
    message = SimpleNamespace(
        content="I inspected the repository.",
        tool_calls=[
            SimpleNamespace(
                id="call_123",
                function=SimpleNamespace(name="filesystem", arguments='{"path":"README.md"}'),
            )
        ],
    )
    return SimpleNamespace(
        choices=[SimpleNamespace(message=message, finish_reason="tool_calls")],
        usage=SimpleNamespace(prompt_tokens=12, completion_tokens=5, total_tokens=17),
    )


@pytest.mark.asyncio
async def test_complete_builds_chat_completions_request_and_normalizes_response():
    client = FakeClient(completion_response())
    adapter = OpenAIAdapter(api_key="test-key", default_model="gpt-test", client=client)

    result = await adapter.complete(
        [{"role": "user", "content": "Inspect the repo"}],
        model="",
        tools=[{"type": "function", "function": {"name": "filesystem"}}],
        temperature=0.2,
        max_tokens=256,
    )

    request = client.chat.completions.calls[0]
    assert request["model"] == "gpt-test"
    assert request["messages"][0]["content"] == "Inspect the repo"
    assert request["tools"][0]["function"]["name"] == "filesystem"
    assert request["tool_choice"] == "auto"
    assert request["temperature"] == 0.2
    assert request["max_tokens"] == 256
    assert result.content == "I inspected the repository."
    assert result.finish_reason == "tool_calls"
    assert result.tool_calls[0].name == "filesystem"
    assert result.tool_calls[0].arguments == {"path": "README.md"}
    assert result.usage.input_tokens == 12
    assert result.usage.output_tokens == 5
    assert result.usage.total_tokens == 17


def test_malformed_tool_arguments_are_preserved_for_recovery():
    message = SimpleNamespace(
        tool_calls=[
            SimpleNamespace(
                id="call_bad",
                function=SimpleNamespace(name="shell_exec", arguments="{not-json"),
            )
        ]
    )

    calls = OpenAIAdapter._parse_tool_calls(message)

    assert calls[0].id == "call_bad"
    assert calls[0].name == "shell_exec"
    assert calls[0].arguments == {"raw": "{not-json"}


class AsyncStream:
    def __init__(self, chunks):
        self.chunks = chunks

    def __aiter__(self):
        return self._items()

    async def _items(self):
        for chunk in self.chunks:
            yield chunk


@pytest.mark.asyncio
async def test_stream_yields_text_deltas_and_finish_reason():
    chunks = [
        SimpleNamespace(
            choices=[SimpleNamespace(delta=SimpleNamespace(content="hello"), finish_reason=None)]
        ),
        SimpleNamespace(
            choices=[SimpleNamespace(delta=SimpleNamespace(content=" world"), finish_reason="stop")]
        ),
    ]
    client = FakeClient(AsyncStream(chunks))
    adapter = OpenAIAdapter(api_key="test-key", client=client)

    result = [chunk async for chunk in adapter.stream([], model="gpt-test")]

    assert [chunk.delta for chunk in result] == ["hello", " world"]
    assert result[-1].finish_reason == "stop"
    assert client.chat.completions.calls[0]["stream"] is True


def test_error_normalization_preserves_retryable_and_fatal_categories():
    class RateLimitSDKError(Exception):
        status_code = 429

    class AuthenticationSDKError(Exception):
        status_code = 401

    rate_error = RateLimitSDKError("too many requests")
    auth_error = AuthenticationSDKError("invalid key")
    generic_error = RuntimeError("server failed")

    assert isinstance(OpenAIAdapter._normalize_error(rate_error), RateLimitError)
    assert isinstance(OpenAIAdapter._normalize_error(auth_error), ProviderError)
    assert not isinstance(OpenAIAdapter._normalize_error(generic_error), RateLimitError)
