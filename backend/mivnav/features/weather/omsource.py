# SPDX-License-Identifier: GPL-2.0-only
"""The range-fetcher that feeds ``omfiles.OmFileReader.from_fsspec`` its
bytes. See docs/architecture/omsource-loopback.md for the Phase 0 finding
that made this possible, the path/cache-key contract with ``routes.py``,
the cross-thread loop bridging, and the error contract.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .proxy import WeatherProxy


class LoopbackOmSource:
    """Duck-typed range-fetcher for ``OmFileReader.from_fsspec`` — one
    instance per ``.om`` file being decoded. See module docstring.
    """

    def __init__(
        self,
        proxy: WeatherProxy,
        loop: asyncio.AbstractEventLoop,
        om_path: str,
    ) -> None:
        self._proxy = proxy
        self._loop = loop
        # Matches exactly what routes.py's data_spatial(_head) build from the
        # same `om_path` — see module docstring.
        self._path = f"data_spatial/{om_path}"

    def _run(self, coro):
        # Called from a worker thread (see module docstring); bridges onto
        # the event loop WeatherProxy actually runs on.
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result()

    def size(self, path: str) -> int:  # noqa: ARG002 — path unused, see below
        async def _get() -> int:
            status, headers = await self._proxy.head_om(self._path, "")
            if status != 200:
                raise OSError(f"weather HEAD {self._path!r} failed: status {status}")
            return int(headers["Content-Length"])

        return self._run(_get())

    def cat_file(self, path: str, start: int | None = None, end: int | None = None) -> bytes:  # noqa: ARG002
        async def _get() -> bytes:
            # No range (both bounds unset): routes.py's data_spatial only
            # calls om_range when the request carries a Range header, so
            # falls through to passthrough_tiles here too.
            if start is None and end is None:
                status, body, _ctype = await self._proxy.passthrough_tiles(self._path, "")
                if status != 200:
                    raise OSError(f"weather GET {self._path!r} failed: status {status}")
                return body
            s = start or 0
            e = str(end - 1) if end is not None else ""
            range_header = f"bytes={s}-{e}"
            status, _headers, body = await self._proxy.om_range(self._path, "", range_header)
            if status != 206:
                raise OSError(f"weather GET {self._path!r} failed: status {status}")
            return body

        return self._run(_get())
