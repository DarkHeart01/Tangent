"""Integration test — real Gemini embeddings, end-to-end index build + search.

Requires GEMINI_API_KEY; skipped otherwise (see conftest-style pattern used by
tests/integration/test_auth_deploy_monitor.py).
"""

from __future__ import annotations

import os

import pytest

from indexer.build import IndexBuilder
from indexer.embedder import Embedder
from indexer.search import CodeIndexSearcher
from indexer.store import CodeIndexStore
from providers.gemini.adapter import GeminiAdapter

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.environ.get("GEMINI_API_KEY"),
        reason="GEMINI_API_KEY not set",
    ),
]


@pytest.mark.asyncio
async def test_code_search_finds_known_function(tmp_path):
    (tmp_path / "billing.py").write_text(
        "def calculate_monthly_invoice_total(line_items):\n"
        "    return sum(item.price * item.quantity for item in line_items)\n",
        encoding="utf-8",
    )
    (tmp_path / "unrelated.py").write_text(
        "def render_login_page():\n    return '<html>login</html>'\n",
        encoding="utf-8",
    )

    provider = GeminiAdapter(api_key=os.environ["GEMINI_API_KEY"])
    embedder = Embedder(provider, "text-embedding-004")
    store = CodeIndexStore(index_dir=str(tmp_path / ".index"))
    builder = IndexBuilder(store, embedder, root=tmp_path, exclude_dirs=[".index"])

    stats = await builder.build()
    assert stats.files_indexed == 2

    searcher = CodeIndexSearcher(store, embedder)
    results = await searcher.search("compute the total invoice amount for a customer's line items", k=3)

    assert results
    assert results[0].file == "billing.py"
