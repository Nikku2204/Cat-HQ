"""Static/SPA serving tests (docs/04 Phase 1 — test_static_spa.py).

Covers: / serving index.html vs the JSON hint, cache headers (immutable for
hashed /assets, no-cache for the shell files), deep SPA-route fallback, API
routes winning over the catch-all, and path-traversal containment (dotted
targets → 404; extensionless targets → contained, then served the SPA shell
by design — the docs/04 "fall through to the SPA shell" clause).

STATIC_DIR is a module global in app.main read at call time, so each test
points it at a tmp_path tree via monkeypatch. Static/SPA routes are
unauthenticated by design → anon_client throughout.

Traversal notes: httpx normalizes LITERAL dot segments ("/../x" never leaves
the client — verified against httpx 0.28), so HTTP-level tests use encoded
forms (%2e%2e) plus a double-slash absolute path, and a spy on
_static_response asserts the hostile path actually reached the route. The
plain "../" form is exercised by calling _static_response directly.
"""
from __future__ import annotations

import pytest

import app.main as app_main

# Distinctive bodies so assertions can prove exactly which file was served
# (and that index.html never leaks into 401/404 responses).
INDEX_HTML = "<!doctype html><!-- cathq-index-marker --><title>Cat HQ</title>"
SW_JS = "// cathq service worker (test stub)\n"
MANIFEST = '{"name": "Cat HQ", "display": "standalone"}'
ASSET_JS = "// cathq hashed asset (test stub)\n"
CANARY = "CANARY-OUTSIDE-STATIC-DO-NOT-SERVE"

_NO_CACHE = "no-cache"
_IMMUTABLE = "public, max-age=31536000, immutable"


# ── fixtures ─────────────────────────────────────────────────────────────


@pytest.fixture
def static_tree(tmp_path, monkeypatch):
    """Frontend-build-shaped tree at tmp_path/static, patched into
    app.main.STATIC_DIR (resolved — the containment check compares resolved
    paths). Canary secrets sit OUTSIDE the tree as traversal targets: dotted
    tmp_path/secret.txt (hits spa()'s file-looking 404 branch) plus
    extensionless tmp_path/flatsecret and tmp_path/secretdir/creds (hit the
    SPA-navigation fallthrough branch)."""
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text(INDEX_HTML)
    (static / "sw.js").write_text(SW_JS)
    (static / "manifest.webmanifest").write_text(MANIFEST)
    (static / "assets" / "app-abc123.js").write_text(ASSET_JS)
    (tmp_path / "secret.txt").write_text(CANARY)
    (tmp_path / "flatsecret").write_text(CANARY)
    (tmp_path / "secretdir").mkdir()
    (tmp_path / "secretdir" / "creds").write_text(CANARY)
    static = static.resolve()
    monkeypatch.setattr(app_main, "STATIC_DIR", static)
    return static


@pytest.fixture
def static_calls(monkeypatch):
    """Record every raw `path` reaching _static_response — proves a hostile
    path survived client-side URL normalization and hit the resolve check."""
    calls: list[str] = []
    real = app_main._static_response

    def spy(path: str):
        calls.append(path)
        return real(path)

    monkeypatch.setattr(app_main, "_static_response", spy)
    return calls


# ── / (root) ─────────────────────────────────────────────────────────────


async def test_root_serves_index(anon_client, static_tree):
    resp = await anon_client.get("/")
    assert resp.status_code == 200
    assert resp.text == INDEX_HTML
    assert resp.headers["cache-control"] == _NO_CACHE
    assert resp.headers["content-type"].startswith("text/html")


@pytest.mark.parametrize("variant", ["dir_absent", "index_absent"])
async def test_root_json_hint_without_build(anon_client, tmp_path, monkeypatch, variant):
    """No frontend build (dev loop): / answers the JSON hint, not a 404."""
    static = tmp_path / "static"  # tmp_path is already resolved
    if variant == "index_absent":
        static.mkdir()
    monkeypatch.setattr(app_main, "STATIC_DIR", static)
    resp = await anon_client.get("/")
    assert resp.status_code == 200
    assert resp.json() == {"app": app_main.settings.app_name, "hint": "see /health"}


# ── cache headers ────────────────────────────────────────────────────────


async def test_hashed_asset_immutable(anon_client, static_tree):
    resp = await anon_client.get("/assets/app-abc123.js")
    assert resp.status_code == 200
    assert resp.text == ASSET_JS
    assert resp.headers["cache-control"] == _IMMUTABLE


@pytest.mark.parametrize(
    "path,body",
    [
        ("/index.html", INDEX_HTML),
        ("/sw.js", SW_JS),
        ("/manifest.webmanifest", MANIFEST),
    ],
)
async def test_shell_files_no_cache(anon_client, static_tree, path, body):
    """index/sw/manifest must revalidate every load (stale-SW footgun)."""
    resp = await anon_client.get(path)
    assert resp.status_code == 200
    assert resp.text == body
    assert resp.headers["cache-control"] == _NO_CACHE


async def test_cache_policy_keyed_on_resolved_path(anon_client, static_tree):
    """/assets/../index.html resolves INSIDE the tree so it is served, but
    the cache policy keys off the resolved location: no-cache, never
    immutable (contract stated in the _static_response comment)."""
    resp = await anon_client.get("/assets/%2e%2e/index.html")
    assert resp.status_code == 200
    assert resp.text == INDEX_HTML
    assert resp.headers["cache-control"] == _NO_CACHE


# ── SPA fallback ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("path", ["/history", "/some/deep/route"])
async def test_deep_route_falls_back_to_index(anon_client, static_tree, path):
    resp = await anon_client.get(path)
    assert resp.status_code == 200
    assert resp.text == INDEX_HTML
    assert resp.headers["cache-control"] == _NO_CACHE
    assert resp.headers["content-type"].startswith("text/html")


@pytest.mark.parametrize("path", ["/assets/app-gone999.js", "/icon-512.png", "/nested/thing.map"])
async def test_file_like_miss_404s_not_index(anon_client, static_tree, path):
    """Missing file-looking paths must 404 — index.html here would poison
    caches and mask deploy mistakes (spa() comment contract)."""
    resp = await anon_client.get(path)
    assert resp.status_code == 404
    assert "cathq-index-marker" not in resp.text


async def test_deep_route_404_without_build(anon_client, tmp_path, monkeypatch):
    monkeypatch.setattr(app_main, "STATIC_DIR", tmp_path / "static")
    resp = await anon_client.get("/history")
    assert resp.status_code == 404


# ── API routes win over the catch-all ────────────────────────────────────


async def test_devices_wins_over_catch_all(anon_client, static_tree):
    """Anon /devices is a 401 JSON from the auth dependency — the SPA
    catch-all must never shadow API routes with index.html."""
    resp = await anon_client.get("/devices")
    assert resp.status_code == 401
    assert resp.headers["content-type"].startswith("application/json")
    assert "detail" in resp.json()
    assert "cathq-index-marker" not in resp.text


async def test_health_wins_over_catch_all(anon_client, static_tree):
    resp = await anon_client.get("/health")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/json")
    assert resp.json()["status"] == "ok"


# ── path traversal containment ───────────────────────────────────────────


@pytest.mark.parametrize(
    "url,expect_received",
    [
        ("/%2e%2e/secret.txt", "../secret.txt"),
        ("/%2e%2e/%2e%2e/secret.txt", "../../secret.txt"),
        ("/assets/%2e%2e/%2e%2e/secret.txt", "assets/../../secret.txt"),
    ],
)
async def test_encoded_traversal_404s(
    anon_client, static_tree, static_calls, url, expect_received
):
    resp = await anon_client.get(url)
    assert resp.status_code == 404  # contained: not 500, not the file
    assert CANARY not in resp.text
    # The decoded ".." really reached the route (not eaten by the client).
    assert static_calls[0] == expect_received


async def test_absolute_path_traversal_404s(anon_client, static_calls, static_tree, tmp_path):
    """Absolute request path: Path.__truediv__ with an absolute right-hand
    side DISCARDS STATIC_DIR entirely, so only the is_relative_to check
    stands between the request and the canary."""
    canary = tmp_path / "secret.txt"
    # Double leading slash keeps the captured {path} absolute after the route
    # pattern eats one "/". Full URL: a bare "//x/y" would be parsed as
    # scheme-relative (host "x") by httpx.
    resp = await anon_client.get(f"http://test/{canary}")
    assert resp.status_code == 404
    assert CANARY not in resp.text
    assert static_calls[0] == str(canary)


@pytest.mark.parametrize(
    "url,expect_received",
    [
        ("/%2e%2e/flatsecret", "../flatsecret"),
        ("/%2e%2e/%2e%2e/secretdir/creds", "../../secretdir/creds"),
    ],
)
async def test_extensionless_traversal_serves_spa_shell(
    anon_client, static_tree, static_calls, url, expect_received
):
    """Extensionless traversals are contained but NOT 404: _static_response
    rejects the out-of-tree resolve, then spa() classifies the dot-less last
    segment as an SPA navigation and serves index.html (docs/04: "contained
    and fall through to the SPA shell by design"). The canary must never
    leak; the 200 body must be the shell, no-cache."""
    resp = await anon_client.get(url)
    assert resp.status_code == 200
    assert resp.text == INDEX_HTML
    assert resp.headers["cache-control"] == _NO_CACHE
    assert CANARY not in resp.text
    # The decoded ".." really reached the route, was contained, and the
    # shell came from the fallthrough — not from serving the hostile path.
    assert static_calls == [expect_received, "index.html"]


async def test_absolute_extensionless_traversal_serves_spa_shell(
    anon_client, static_calls, static_tree, tmp_path
):
    """Absolute extensionless target (Path.__truediv__ discards STATIC_DIR):
    contained by is_relative_to, then falls through to the shell because the
    last segment has no dot."""
    canary = tmp_path / "flatsecret"
    # Double leading slash keeps the captured {path} absolute (see
    # test_absolute_path_traversal_404s).
    resp = await anon_client.get(f"http://test/{canary}")
    assert resp.status_code == 200
    assert resp.text == INDEX_HTML
    assert resp.headers["cache-control"] == _NO_CACHE
    assert CANARY not in resp.text
    assert static_calls == [str(canary), "index.html"]


async def test_extensionless_traversal_404_without_build(anon_client, tmp_path, monkeypatch):
    """No frontend build: the contained extensionless traversal has no shell
    to fall through to — 404, never 500, and never the canary."""
    (tmp_path / "flatsecret").write_text(CANARY)
    monkeypatch.setattr(app_main, "STATIC_DIR", tmp_path / "static")
    resp = await anon_client.get("/%2e%2e/flatsecret")
    assert resp.status_code == 404
    assert CANARY not in resp.text


def test_static_response_rejects_out_of_tree_paths(static_tree, tmp_path):
    """Direct unit check of the resolve/containment gate, including the
    literal ../ form that HTTP clients normalize away before the wire."""
    canary = tmp_path / "secret.txt"
    assert canary.is_file()  # target exists — only containment blocks it
    assert app_main._static_response("../secret.txt") is None
    assert app_main._static_response("assets/../../secret.txt") is None
    assert app_main._static_response(str(canary)) is None
