# SPDX-License-Identifier: GPL-2.0-only
"""A fake Niord server (an ``httpx.MockTransport``) answering from the
recorded fixtures in ``tests/fixtures/niord/`` — trimmed copies of real
niord.dma.dk answers from 2026-10-03 (see that directory's SOURCE.txt).

The notices tests never reach the network: every runtime under test is
built with this transport.
"""

from __future__ import annotations

import json
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from mivnav.feature import FeatureCtx
from mivnav.features.notices.client import NIORD_TZ
from mivnav.features.notices.runtime import NoticesRuntime

FIXTURES = Path(__file__).parent / "fixtures" / "niord"

#: 2026-10-03 10:00 Copenhagen — the day the fixtures were recorded; EK R 18
#: has a firing period 08:00-22:00 local that day.
T0 = datetime(2026, 10, 3, 10, 0, tzinfo=NIORD_TZ).timestamp()

FE_ID = "b00a2472-bc97-408a-b13f-ccf3ebc1f475"  # EK D 396 firing exercise
ATTACHMENT_URL = (
    "https://niord.dma.dk/rest/repo/file/messages/7/24/7242e03c-1279-4235-b418-6ac11cf6b027/33/"
    "NM-270-22%20Femern_DK.pdf"
)


def load(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


class Clock:
    def __init__(self, t: float = T0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


class FakeNiord:
    """Routes like niord.dma.dk. ``down`` = every request fails at the
    transport (no uplink); ``broken`` = a set of path keys that 500."""

    def __init__(self) -> None:
        self.down = False
        self.broken: set[str] = set()
        self.calls: Counter[str] = Counter()
        self.messages = load("messages.json")
        self.feeds = {
            None: self.messages,
            "niord-fa": load("fa.json"),
            "niord-almanac": load("almanac.json"),
            "niord-annex": load("annex.json"),
        }
        self.periods = load("periods_2026-10-03.json")
        self.singles = {"NM-567-25": load("message_NM-567-25.json")}
        self.attachments = {ATTACHMENT_URL: b"%PDF-1.4 fake"}

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if self.down:
            raise httpx.ConnectError("no route to host", request=request)
        if path == "/rest/public/v1/messages":
            domain = request.url.params.get("domain")
            key = f"messages:{domain}"
            self.calls[key] += 1
            if key in self.broken:
                return httpx.Response(500)
            return httpx.Response(200, json=self.feeds[domain])
        if path == "/rest/firing-schedules/search-firing-area-periods":
            self.calls["periods"] += 1
            if "periods" in self.broken:
                return httpx.Response(404)
            # the real endpoint wants epoch ms (an ISO date 404s)
            int(request.url.params["date"])
            return httpx.Response(200, json=self.periods)
        if path.startswith("/rest/public/v1/message/"):
            ident = request.url.path.removeprefix("/rest/public/v1/message/")
            self.calls[f"message:{ident}"] += 1
            if ident in self.singles:
                return httpx.Response(200, json=self.singles[ident])
            return httpx.Response(404)
        url = str(request.url)
        if url in self.attachments:
            self.calls["attachment"] += 1
            return httpx.Response(200, content=self.attachments[url], headers={"content-type": "application/pdf"})
        return httpx.Response(404)


DATASET_ID = "notices-dk"


def notices_dataset(dataset_id: str = DATASET_ID, regions=("dk", "gl"), **over: Any) -> dict[str, Any]:
    """A notices ``DatasetConfig`` document (the seeded default's shape)."""
    from mivnav.features.notices.config import default_notices_dataset

    doc = default_notices_dataset(dataset_id=dataset_id, regions=tuple(regions))
    doc.update(over)
    return doc


def notices_api_runtime(root: Path, fake: FakeNiord, clock: Clock | None = None, *, datasets=None, **kw):
    """An isolated api ``Runtime`` whose ``notices`` feature talks to
    ``fake`` (and reads ``clock``), declaring ``datasets`` (default: the one
    seeded "Denmark + Greenland" dataset). Updates run through the REAL
    dataset path (runner factory, trigger, scheduler)."""
    from dataclasses import replace

    from mivnav.api.features import FEATURES
    from tests.conftest import isolated_runtime_at

    clock = clock or Clock()
    features = [
        replace(f, build_runtime=lambda ctx: NoticesRuntime(ctx, transport=fake.transport(), clock=clock, **kw))
        if f.id == "notices"
        else f
        for f in FEATURES
    ]
    rt = isolated_runtime_at(root, features=features)
    rt.patch_config({"datasets": list(datasets) if datasets is not None else [notices_dataset()]})
    return rt


def notices_of(rt) -> NoticesRuntime:
    return rt.feature("notices")


def update(rt, dataset_id: str = DATASET_ID, timeout: float = 10.0) -> dict[str, Any]:
    """Run one update of ``dataset_id`` through the generic dataset trigger
    and wait for it; returns the runner's final status."""
    assert rt.trigger_dataset(dataset_id), f"no update started for {dataset_id!r}"
    runner = rt.dataset_runner(dataset_id)
    wait(runner, timeout)
    return runner.status()


def wait(runner, timeout: float = 10.0) -> None:
    thread = runner._thread
    if thread is not None:
        thread.join(timeout)
    assert not runner.busy()
