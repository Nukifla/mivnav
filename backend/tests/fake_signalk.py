# SPDX-License-Identifier: GPL-2.0-only
"""A SignalK v1 delta stream, faked, on its own thread.

Real sockets on a real loopback port, because the whole point of moving
the connection server-side is the connection: a test double injected at
`SignalKService(connect=…)` would prove the bookkeeping and skip the part
that can actually be wrong. It counts sessions, which is how "one upstream
connection serves N clients" is stated as an assertion.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Any

from websockets.asyncio.server import serve

SELF_ID = "urn:mrn:signalk:uuid:4f7a-boat"


class FakeSignalK:
    """Speaks just enough SignalK: a hello, then whatever you broadcast."""

    def __init__(self, self_id: str = SELF_ID) -> None:
        self.self_id = self_id
        #: Sessions accepted since start. The upstream-sharing assertion.
        self.sessions = 0
        #: Subscription messages received, in order.
        self.subscriptions: list[Any] = []
        #: Each session's request headers, in order — how a test sees the
        #: write socket's ``Authorization``.
        self.headers: list[dict[str, str]] = []
        self._clients: set[Any] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._stopping = asyncio.Event()
        self._ready = threading.Event()
        self.port = 0

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> FakeSignalK:
        def run() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._loop = loop
            try:
                loop.run_until_complete(self._main())
            finally:
                loop.close()

        self._thread = threading.Thread(target=run, name="fake-signalk", daemon=True)
        self._thread.start()
        assert self._ready.wait(10), "the fake SignalK server never came up"
        return self

    def stop(self) -> None:
        if self._loop is None or self._thread is None:
            return
        self._loop.call_soon_threadsafe(self._stopping.set)
        self._thread.join(timeout=10)

    async def _main(self) -> None:
        async with serve(self._session, "127.0.0.1", 0) as server:
            self.port = server.sockets[0].getsockname()[1]
            self._ready.set()
            await self._stopping.wait()

    async def _session(self, socket: Any) -> None:
        self.sessions += 1
        self.headers.append(dict(socket.request.headers))
        self._clients.add(socket)
        # The hello frame; `self` is the only way a client can tell the own
        # ship from an AIS target.
        await socket.send(json.dumps({"self": f"vessels.{self.self_id}", "version": "1.0.0"}))
        try:
            async for raw in socket:
                self.subscriptions.append(json.loads(raw))
        except Exception:  # noqa: BLE001 — a client dropping is normal
            pass
        finally:
            self._clients.discard(socket)

    # -- the test's side ---------------------------------------------------

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/signalk/v1/stream?subscribe=none"

    def broadcast(self, message: dict[str, Any]) -> None:
        text = json.dumps(message)

        async def send() -> None:
            for socket in list(self._clients):
                await socket.send(text)

        assert self._loop is not None
        asyncio.run_coroutine_threadsafe(send(), self._loop).result(timeout=10)

    def delta(
        self, values: list[tuple[str, Any]], *, vessel: str | None = None
    ) -> dict[str, Any]:
        """A delta of arbitrary path/value pairs, for the own ship or a target."""
        return {
            "context": f"vessels.{vessel or self.self_id}",
            "updates": [{"values": [{"path": path, "value": value} for path, value in values]}],
        }

    def position(self, lat: float, lng: float, *, vessel: str | None = None) -> dict[str, Any]:
        """A position delta for the own ship, or for an AIS target."""
        return self.delta([("navigation.position", {"latitude": lat, "longitude": lng})], vessel=vessel)

    def wait_sessions(self, count: int, timeout: float = 10.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.sessions >= count:
                return
            time.sleep(0.01)
        raise AssertionError(f"expected {count} upstream sessions, saw {self.sessions}")
