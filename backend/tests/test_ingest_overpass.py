# SPDX-License-Identifier: GPL-2.0-only
"""The Overpass fetcher's HTTP contract, without touching the real API.

Regression guard for the 406 bug: overpass-api.de's Apache front-end rejects a
generic/library User-Agent (``python-httpx/…``, ``curl/…``, even
``Mozilla/5.0``) with a bare HTTP 406, and answers the identical request 200
once it carries an app-identifying UA. So the fetcher MUST send a descriptive
User-Agent on the Overpass request; these tests pin that down with a
``MockTransport`` so no network is hit.
"""

from __future__ import annotations

import httpx
import pytest

# Before poi.overpass: importing it first walks into the mivnav.config <->
# poi.config import cycle (it used to pass only when another test module
# happened to import mivnav.config earlier in the run).
import mivnav.config  # noqa: F401
from mivnav.features.poi import overpass
from mivnav.features.poi.overpass import USER_AGENT, OverpassError, fetch_pois

BBOX = (-1.4, 50.75, -1.15, 50.85)

CANNED = {
    "elements": [
        {"type": "node", "id": 1, "lat": 50.79, "lon": -1.12,
         "tags": {"leisure": "marina", "name": "Haslar Marina"}},
    ]
}


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_fetch_sends_a_descriptive_user_agent() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["ua"] = request.headers.get("user-agent", "")
        return httpx.Response(200, json=CANNED)

    with _client(handler) as http:
        elements = fetch_pois(http, BBOX)

    assert elements == CANNED["elements"]
    # The exact value the proxy accepts — and, crucially, NOT the httpx default.
    assert seen["ua"] == USER_AGENT
    assert "mivnav" in seen["ua"].lower()
    assert "python-httpx" not in seen["ua"].lower()


def test_user_agent_overrides_a_client_default() -> None:
    """Even a client whose default UA would be rejected must still send ours:
    the header is set per-request, so the client's own default cannot leak."""
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["ua"] = request.headers.get("user-agent", "")
        return httpx.Response(200, json=CANNED)

    http = httpx.Client(
        transport=httpx.MockTransport(handler),
        headers={"User-Agent": "Mozilla/5.0"},  # a UA the real proxy 406s
    )
    with http:
        fetch_pois(http, BBOX)
    assert seen["ua"] == USER_AGENT


def test_406_is_wrapped_as_overpass_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(406, text="Not Acceptable")

    with _client(handler) as http, pytest.raises(OverpassError) as ei:
        fetch_pois(http, BBOX)
    assert "406" in str(ei.value)


def test_query_is_posted_as_the_data_form_field() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = request.content.decode()
        return httpx.Response(200, json=CANNED)

    with _client(handler) as http:
        fetch_pois(http, BBOX)
    # form-encoded `data=<QL>`, and the QL carries the JSON/out directives
    assert seen["body"].startswith("data=")
    assert "out%3Ajson" in seen["body"] or "out:json" in seen["body"]


def test_missing_elements_list_is_an_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"version": 0.6})  # no 'elements'

    with _client(handler) as http, pytest.raises(OverpassError):
        fetch_pois(http, BBOX)


def test_default_url_is_the_module_default(monkeypatch) -> None:
    """A caller that omits `url` hits the configured default endpoint."""
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json=CANNED)

    with _client(handler) as http:
        fetch_pois(http, BBOX)
    assert seen["url"] == overpass.DEFAULT_OVERPASS_URL


# --- transient-failure retry (the 504 bug) -------------------------------------
#
# The public Overpass instance 504s under load even for small queries that
# succeed on retry. `_post_query` retries RETRYABLE_STATUS + transport errors
# with backoff; `sleep` is injected so these tests don't actually wait.

NO_SLEEP = lambda _s: None  # noqa: E731 — trivial test stub


def _sequence_handler(responses):
    """A handler that returns each of `responses` (status or Exception) in turn,
    tracking how many times it was called."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        i = calls["n"]
        calls["n"] += 1
        item = responses[min(i, len(responses) - 1)]
        if isinstance(item, Exception):
            raise item
        if item == 200:
            return httpx.Response(200, json=CANNED)
        return httpx.Response(item, text="overloaded")

    return handler, calls


def test_504_then_success_is_retried() -> None:
    handler, calls = _sequence_handler([504, 504, 200])
    with _client(handler) as http:
        els = overpass._post_query(http, "q", overpass.DEFAULT_OVERPASS_URL, sleep=NO_SLEEP)
    assert els == CANNED["elements"]
    assert calls["n"] == 3  # two 504s, then the 200


def test_exhausted_retries_raise_with_the_status() -> None:
    handler, calls = _sequence_handler([504, 504, 504])
    with _client(handler) as http, pytest.raises(OverpassError) as ei:
        overpass._post_query(http, "q", overpass.DEFAULT_OVERPASS_URL, sleep=NO_SLEEP)
    assert "504" in str(ei.value)
    assert calls["n"] == overpass.OVERPASS_RETRIES  # tried the full budget


def test_a_permanent_4xx_is_not_retried() -> None:
    handler, calls = _sequence_handler([400, 200])
    with _client(handler) as http, pytest.raises(OverpassError) as ei:
        overpass._post_query(http, "q", overpass.DEFAULT_OVERPASS_URL, sleep=NO_SLEEP)
    assert "400" in str(ei.value)
    assert calls["n"] == 1  # bad QL is permanent — no retry


def test_transport_error_then_success_is_retried() -> None:
    handler, calls = _sequence_handler([httpx.ConnectTimeout("boom"), 200])
    with _client(handler) as http:
        els = overpass._post_query(http, "q", overpass.DEFAULT_OVERPASS_URL, sleep=NO_SLEEP)
    assert els == CANNED["elements"]
    assert calls["n"] == 2


# --- on_retry: the job-log wiring (mivnav.ingest.runner.IngestRunner._log) --

def test_on_retry_is_called_with_a_message_for_each_retry() -> None:
    """`on_retry` (the ingest job's log-appender hook) fires once per retried
    attempt, with the same message `log.warning` records — the wiring
    `PoiIngestRunner._bake` relies on to surface a 504/transport retry into
    the polled job log. It must NOT fire for the final, unretried failure
    (that is reported through the job's `error` state instead, not the log)."""
    lines: list[str] = []
    handler, calls = _sequence_handler([504, 504, 200])
    with _client(handler) as http:
        overpass._post_query(
            http, "q", overpass.DEFAULT_OVERPASS_URL, sleep=NO_SLEEP, on_retry=lines.append
        )
    assert calls["n"] == 3
    assert len(lines) == 2  # one per retried 504, not per attempt
    assert all("504" in line and "retry" in line for line in lines)


def test_on_retry_is_not_called_for_an_exhausted_final_failure() -> None:
    lines: list[str] = []
    handler, _ = _sequence_handler([504, 504, 504])
    with _client(handler) as http, pytest.raises(OverpassError):
        overpass._post_query(
            http, "q", overpass.DEFAULT_OVERPASS_URL, sleep=NO_SLEEP, on_retry=lines.append
        )
    # Every attempt but the last was retried; the final attempt raises
    # without calling on_retry again.
    assert len(lines) == overpass.OVERPASS_RETRIES - 1


# --- a 200 that is really a failure (Overpass `remark`) ------------------------


def test_a_runtime_error_remark_is_an_error_not_a_truncated_result() -> None:
    """A query that hits its [timeout:]/memory limit still answers HTTP 200,
    with the partial `elements` it had and the reason in `remark`. Returning
    those would bake a silently truncated set; it must fail with the reason."""
    body = {
        "elements": CANNED["elements"],
        "remark": 'runtime error: Query timed out in "query" at line 3 after 181 seconds.',
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=body)

    with _client(handler) as http, pytest.raises(OverpassError) as ei:
        fetch_pois(http, BBOX)
    assert "timed out" in str(ei.value)


def test_a_non_error_remark_is_ignored() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={**CANNED, "remark": "runtime remark: fine"})

    with _client(handler) as http:
        assert fetch_pois(http, BBOX) == CANNED["elements"]


# --- split_bbox: a big bbox fetched as tiles -----------------------------------


def test_a_small_bbox_is_one_tile_unchanged() -> None:
    assert overpass.split_bbox(BBOX) == [BBOX]


def test_the_denmark_2026_box_splits_into_a_grid_that_covers_it_exactly() -> None:
    """The user's "Denmark 2026" region (13.3 x 3.9 deg) — one query for it
    ran ~180 s against Overpass's 180 s timeout. 4 x 2 tiles, each within the
    limits, sharing edges, with the outer edges exactly the region's."""
    box = (3.2485062, 54.3641714, 16.5106873, 58.260919)
    tiles = overpass.split_bbox(box)
    assert len(tiles) == 8
    for t in tiles:
        assert t[2] - t[0] <= overpass.TILE_MAX_LON_DEG
        assert t[3] - t[1] <= overpass.TILE_MAX_LAT_DEG
    assert min(t[0] for t in tiles) == box[0]
    assert min(t[1] for t in tiles) == box[1]
    assert max(t[2] for t in tiles) == box[2]
    assert max(t[3] for t in tiles) == box[3]
    # Area adds up: no gap, no overlap.
    area = sum((t[2] - t[0]) * (t[3] - t[1]) for t in tiles)
    assert area == pytest.approx((box[2] - box[0]) * (box[3] - box[1]))


# --- busy servers: long backoff, Retry-After, fallback servers -------------------
#
# Measured on the boat's Pi: one tile of a "Denmark" bake drew 504 on all 4
# attempts of the old 5/10/20 s schedule, and the whole bake failed.

PRIMARY = "https://overpass-api.de/api/interpreter"
FALLBACK = "https://overpass.example/api/interpreter"


def _per_host_handler(plan: dict[str, list]):
    """Each host answers its own sequence (status, (status, headers) or an
    exception; the last entry repeats). Records every (host, n) call."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        seq = plan[host]
        i = sum(1 for h in calls if h == host)
        calls.append(host)
        item = seq[min(i, len(seq) - 1)]
        if isinstance(item, Exception):
            raise item
        status, headers = item if isinstance(item, tuple) else (item, {})
        if status == 200:
            return httpx.Response(200, json=CANNED, headers=headers)
        return httpx.Response(status, text="busy", headers=headers)

    return handler, calls


def test_busy_backs_off_long_with_more_attempts_than_other_errors() -> None:
    slept: list[float] = []
    handler, calls = _per_host_handler({"overpass-api.de": [504, 429, 503, 504, 200]})
    with _client(handler) as http:
        els = overpass._post_query(http, "q", PRIMARY, sleep=slept.append)
    assert els == CANNED["elements"]
    assert slept == list(overpass.BUSY_BACKOFF_S) == [30.0, 60.0, 120.0, 240.0]
    assert len(calls) == 5

    # A 502 / transport error keeps the short schedule and budget.
    slept.clear()
    handler, calls = _per_host_handler({"overpass-api.de": [502]})
    with _client(handler) as http, pytest.raises(OverpassError):
        overpass._post_query(http, "q", PRIMARY, sleep=slept.append)
    assert slept == list(overpass.OTHER_BACKOFF_S)
    assert len(calls) == len(overpass.OTHER_BACKOFF_S) + 1 < overpass.OVERPASS_RETRIES


def test_busy_delays_are_jittered() -> None:
    slept: list[float] = []
    handler, _ = _per_host_handler({"overpass-api.de": [504, 504, 200]})
    with _client(handler) as http:
        overpass._post_query(http, "q", PRIMARY, sleep=slept.append, jitter=overpass._jitter)
    for got, base in zip(slept, overpass.BUSY_BACKOFF_S):
        assert base * (1 - overpass.JITTER) <= got <= base * (1 + overpass.JITTER)


def test_retry_after_is_honoured_and_clamped() -> None:
    slept: list[float] = []
    lines: list[str] = []
    handler, _ = _per_host_handler({
        "overpass-api.de": [(429, {"Retry-After": "7"}), (503, {"Retry-After": "99999"}), 200]
    })
    with _client(handler) as http:
        overpass._post_query(http, "q", PRIMARY, sleep=slept.append, on_retry=lines.append)
    assert slept == [7.0, overpass.MAX_RETRY_AFTER_S]
    assert lines[0] == "Overpass busy (429) at overpass-api.de, retry 1/4 in 7s"

    # An HTTP-date Retry-After works too.
    import email.utils
    import time as _time

    when = email.utils.formatdate(_time.time() + 45, usegmt=True)
    slept.clear()
    handler, _ = _per_host_handler({"overpass-api.de": [(504, {"Retry-After": when}), 200]})
    with _client(handler) as http:
        overpass._post_query(http, "q", PRIMARY, sleep=slept.append)
    assert 40 <= slept[0] <= 46


def test_a_server_that_keeps_failing_hands_over_to_the_next() -> None:
    slept: list[float] = []
    lines: list[str] = []
    answered: list[str] = []
    handler, calls = _per_host_handler({"overpass-api.de": [504], "overpass.example": [200]})
    with _client(handler) as http:
        els = fetch_pois(
            http, BBOX, url=PRIMARY, fallback_urls=[FALLBACK, PRIMARY],
            sleep=slept.append, jitter=lambda d: d, on_retry=lines.append,
            on_server=answered.append,
        )
    assert els == CANNED["elements"]
    assert calls == ["overpass-api.de"] * overpass.OVERPASS_RETRIES + ["overpass.example"]
    assert answered == [FALLBACK]
    assert lines[-1] == "Overpass returned 504 from overpass-api.de — trying overpass.example instead"


def test_every_server_failing_names_them_all() -> None:
    handler, calls = _per_host_handler({"overpass-api.de": [400], "overpass.example": [400]})
    with _client(handler) as http, pytest.raises(OverpassError) as ei:
        fetch_pois(http, BBOX, url=PRIMARY, fallback_urls=[FALLBACK], sleep=lambda _s: None)
    assert "400" in str(ei.value)
    assert "overpass-api.de, overpass.example" in str(ei.value)
    assert calls == ["overpass-api.de", "overpass.example"]


def test_an_area_query_on_a_server_without_area_data_is_a_failure() -> None:
    """A mirror without area data answers a country query with ZERO elements
    and no error; that must not bake an empty country — it fails over."""
    with_areas = {**CANNED, "osm3s": {"timestamp_areas_base": "2026-09-26T22:02:21Z"}}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "overpass-api.de":
            return httpx.Response(200, json={"elements": [], "osm3s": {}})
        return httpx.Response(200, json=with_areas)

    with _client(handler) as http:
        assert overpass.fetch_pois_area(
            http, "DK", url=PRIMARY, fallback_urls=[FALLBACK]
        ) == CANNED["elements"]
    with _client(handler) as http, pytest.raises(OverpassError, match="no area data"):
        overpass.fetch_pois_area(http, "DK", url=PRIMARY)


def test_config_keeps_overpass_url_first_and_adds_the_fallbacks() -> None:
    import mivnav.config  # noqa: F401 — import order (config <-> poi.config cycle)
    from mivnav.features.poi.config import DEFAULT_OVERPASS_FALLBACK_URLS, PoiConfig

    assert PoiConfig().overpass_urls() == (overpass.DEFAULT_OVERPASS_URL, *DEFAULT_OVERPASS_FALLBACK_URLS)
    # An existing config with only overpass_url: that one first, then the defaults.
    cfg = PoiConfig(overpass_url=FALLBACK)
    assert cfg.overpass_urls()[0] == FALLBACK
    assert PoiConfig(overpass_url=PRIMARY, overpass_fallback_urls=()).overpass_urls() == (PRIMARY,)
    assert PoiConfig(overpass_fallback_urls=(PRIMARY, "", FALLBACK)).overpass_urls() == (PRIMARY, FALLBACK)


def test_split_is_capped_per_axis() -> None:
    """An antimeridian country's enclosing box on the bbox fallback
    (-180..180) stays a bounded number of requests."""
    tiles = overpass.split_bbox((-180.0, 18.0, 180.0, 72.0))
    assert len(tiles) == overpass.TILE_MAX_PER_AXIS**2
