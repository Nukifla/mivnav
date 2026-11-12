# SPDX-License-Identifier: GPL-2.0-only
"""Release updates: what GitHub has, what the updater is doing, and how to
start it.

Three independent pieces, each injectable for tests:

- :class:`UpdateChecker` asks the GitHub releases API for the newest
  release. The boat is usually offline, so a failure is an *answer*
  (``error`` text), never an exception, and is remembered for a while so a
  panel polling every two seconds does not re-dial a dead uplink each time.
- :func:`read_status` reads the status file ``deploy/update.sh`` writes.
  This process never writes it: the updater restarts this process midway,
  so only the updater can tell the whole story.
- :func:`start_unit` hands a target to systemd as
  ``mivnav-update@<target>.service``. The target becomes a unit instance
  name and then an argument to a shell script, so it is validated against
  a strict pattern first (:func:`valid_target`) — never passed through.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, Protocol

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

log = logging.getLogger(__name__)


class UpdatesSlice(Protocol):
    """What :class:`UpdateChecker` reads of ``mivnav.config.model.UpdatesConfig``
    — structural, so this kernel package needn't import the config model
    (whose import graph reaches the features import-linter keeps it from)."""

    @property
    def check(self) -> bool: ...

    @property
    def include_prereleases(self) -> bool: ...


#: ``GET /repos/{owner}/{repo}/releases`` — newest first, drafts hidden from
#: anonymous callers. The owner's case is GitHub's canonical spelling.
RELEASES_URL = "https://api.github.com/repos/Nukifla/mivnav/releases"

#: A successful lookup is good for this long; "Check now" bypasses it.
CACHE_TTL_S = 6 * 3600.0
#: A failed lookup (offline, rate-limited) is remembered for this long, so
#: an open Software panel doesn't re-dial a dead uplink on every poll.
ERROR_TTL_S = 10 * 60.0
#: Short on purpose: this backs a settings panel, and offline is the norm.
HTTP_TIMEOUT = httpx.Timeout(8.0, connect=4.0)
#: Release notes are shown in a phone-sized panel, not archived.
MAX_NOTES_CHARS = 20_000

UpdateState = Literal[
    "idle",
    "checking",
    "downloading",
    "installing",
    "restarting",
    "done",
    "failed",
    "rolled_back",
]

#: States in which a second update must be refused (409).
IN_PROGRESS_STATES: frozenset[str] = frozenset(
    {"checking", "downloading", "installing", "restarting"}
)

#: An in-progress status this long without a write is a dead updater (killed
#: with the box, OOM, power cut) — reported as ``failed`` so it cannot block
#: every later update forever. Generous: a slow marina uplink downloading a
#: release must not trip it.
STALE_AFTER_S = 60 * 60.0

# --- versions ---------------------------------------------------------------

_SEMVER = re.compile(
    r"^v?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})"
    r"(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$"
)

#: ``latest`` or an explicit tag. Becomes ``mivnav-update@<this>.service``
#: and the updater's ``$1``: letters, digits, dots and dashes only, so no
#: systemd escape sequence, path separator or shell metacharacter survives.
_TARGET = re.compile(
    r"^(?:latest|v(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})"
    r"(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)$"
)
_MAX_TARGET_LEN = 64

Version = tuple[int, int, int, tuple[int | str, ...] | None]


def parse_version(text: str) -> Version | None:
    """``"0.2.0"``/``"v0.2.0-rc.1"`` → a comparable tuple; ``None`` for
    anything that is not one (``"dev"``, a stray tag)."""
    m = _SEMVER.match(text.strip())
    if m is None:
        return None
    pre = m.group(4)
    pre_parts = (
        tuple(int(p) if p.isdigit() else p for p in pre.split(".")) if pre is not None else None
    )
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), pre_parts)


def _pre_key(pre: tuple[int | str, ...] | None) -> tuple:
    # SemVer §11: a release sorts after all of its pre-releases; numeric
    # identifiers sort before alphanumeric ones, then field by field.
    if pre is None:
        return (1,)
    return (0, tuple((0, p, "") if isinstance(p, int) else (1, 0, p) for p in pre))


def compare_versions(a: str, b: str) -> int | None:
    """-1/0/1 like ``cmp``; ``None`` when either is not a version."""
    pa, pb = parse_version(a), parse_version(b)
    if pa is None or pb is None:
        return None
    ka = (pa[:3], _pre_key(pa[3]))
    kb = (pb[:3], _pre_key(pb[3]))
    return (ka > kb) - (ka < kb)


def valid_target(target: str) -> bool:
    """Whether ``target`` may become an update unit's instance name."""
    return len(target) <= _MAX_TARGET_LEN and _TARGET.match(target) is not None


# --- the status file -------------------------------------------------------


class UpdateStatus(BaseModel):
    """``status.json`` as ``update.sh`` writes it. Only ``state`` is
    guaranteed; ``idle`` is what a box that never updated reports."""

    model_config = ConfigDict(populate_by_name=True)

    state: UpdateState = "idle"
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None
    message: str | None = None
    started_at: str | None = None
    updated_at: str | None = None

    @property
    def in_progress(self) -> bool:
        return self.state in IN_PROGRESS_STATES


def _parse_time(value: str | None) -> float | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.timestamp()


def read_status(path: Path, now: float | None = None) -> UpdateStatus:
    """The updater's last word. Missing → ``idle``; unreadable → ``idle``
    with a message saying so (never a 500 — it is a status panel); an
    in-progress state that stopped being written → ``failed``."""
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return UpdateStatus()
    except OSError as e:
        return UpdateStatus(message=f"The update status could not be read: {e.strerror or e}")
    try:
        status = UpdateStatus.model_validate(json.loads(raw))
    except (ValueError, ValidationError) as e:
        log.warning("unreadable update status %s: %s", path, e)
        return UpdateStatus(message="The update status file is unreadable.")
    if status.in_progress:
        last = _parse_time(status.updated_at) or _parse_time(status.started_at)
        now = time.time() if now is None else now
        if last is not None and now - last > STALE_AFTER_S:
            return status.model_copy(
                update={
                    "state": "failed",
                    "message": (
                        f"The update stopped reporting progress ({status.state}) at "
                        f"{status.updated_at or status.started_at} and is assumed to have "
                        "died. See update.log beside the status file."
                    ),
                }
            )
    return status


# --- GitHub ------------------------------------------------------------------


class LatestRelease(BaseModel):
    """The newest release GitHub has that this server would offer."""

    version: str  # without the leading "v", like VERSION
    published_at: str | None
    notes_url: str | None
    notes: str


@dataclass(frozen=True)
class ReleaseCheck:
    latest: LatestRelease | None
    #: ISO-8601 of the last lookup attempt; ``None`` = never looked.
    checked_at: str | None
    error: str | None


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).isoformat(timespec="seconds")


def pick_latest(releases: object, include_prereleases: bool) -> LatestRelease | None:
    """The highest-versioned published release in a GitHub releases list
    — by version, not by list order (a backported patch release is
    published *after* a newer minor one)."""
    if not isinstance(releases, list):
        raise ValueError("GitHub's release list was not a list")
    best: dict | None = None
    for release in releases:
        if not isinstance(release, dict) or release.get("draft"):
            continue
        tag = release.get("tag_name")
        if not isinstance(tag, str):
            continue
        parsed = parse_version(tag)
        if parsed is None:
            continue
        if (release.get("prerelease") or parsed[3] is not None) and not include_prereleases:
            continue
        if best is None or compare_versions(tag, best["tag_name"]) == 1:
            best = release
    if best is None:
        return None
    release = best
    notes = release.get("body") if isinstance(release.get("body"), str) else ""
    return LatestRelease(
        version=release["tag_name"].removeprefix("v"),
        published_at=release.get("published_at") if isinstance(release.get("published_at"), str) else None,
        notes_url=release.get("html_url") if isinstance(release.get("html_url"), str) else None,
        notes=notes[:MAX_NOTES_CHARS],
    )


class UpdateChecker:
    """The cached "what is the newest release" lookup.

    Built from the ``updates`` config slice through a
    :class:`~mivnav.config.derived.Derived`, so turning
    ``include_prereleases`` on or off drops the cached answer with it.
    """

    def __init__(
        self,
        config: UpdatesSlice,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.time,
        url: str = RELEASES_URL,
    ) -> None:
        self.config = config
        self._transport = transport
        self._clock = clock
        self._url = url
        self._result: ReleaseCheck | None = None
        self._fetched_at = 0.0

    def _fresh(self) -> bool:
        if self._result is None:
            return False
        ttl = ERROR_TTL_S if self._result.error else CACHE_TTL_S
        return self._clock() - self._fetched_at < ttl

    async def check(self, refresh: bool = False) -> ReleaseCheck:
        """The cached answer, or a new lookup when it is stale (and
        automatic checks are on) or ``refresh`` asks for one."""
        if not refresh:
            if self._fresh() or (self._result is not None and not self.config.check):
                assert self._result is not None
                return self._result
            if not self.config.check:
                return ReleaseCheck(latest=None, checked_at=None, error=None)
        now = self._clock()
        try:
            latest = await self._fetch()
            result = ReleaseCheck(latest=latest, checked_at=_iso(now), error=None)
        except _LookupFailed as e:
            log.info("release check failed: %s", e)
            # Keep showing what we last knew; only the error is new.
            known = self._result.latest if self._result is not None else None
            result = ReleaseCheck(latest=known, checked_at=_iso(now), error=str(e))
        self._result = result
        self._fetched_at = now
        return result

    async def _fetch(self) -> LatestRelease | None:
        try:
            async with httpx.AsyncClient(
                timeout=HTTP_TIMEOUT, transport=self._transport, follow_redirects=True
            ) as client:
                resp = await client.get(
                    self._url,
                    params={"per_page": 30},
                    headers={
                        "Accept": "application/vnd.github+json",
                        "User-Agent": "mivnav-updater",
                    },
                )
        except httpx.HTTPError as e:
            raise _LookupFailed(
                f"GitHub is not reachable (offline?): {type(e).__name__}"
            ) from e
        if resp.status_code != 200:
            hint = " (rate limited, try again later)" if resp.status_code in (403, 429) else ""
            raise _LookupFailed(f"GitHub answered HTTP {resp.status_code}{hint}")
        try:
            return pick_latest(resp.json(), self.config.include_prereleases)
        except ValueError as e:
            raise _LookupFailed(f"GitHub's answer was not understood: {e}") from e


class _LookupFailed(Exception):
    pass


# --- systemd ------------------------------------------------------------------

#: ``(argv) -> (returncode, output)``. Injected so no test runs systemctl.
Runner = Callable[[Sequence[str]], tuple[int, str]]


def systemctl_runner(argv: Sequence[str]) -> tuple[int, str]:
    """The real runner. ``--no-block`` makes systemctl return as soon as
    the job is queued, so this is quick; the timeout is a backstop."""
    try:
        proc = subprocess.run(list(argv), capture_output=True, text=True, timeout=20, check=False)
    except FileNotFoundError:
        return 127, f"{argv[0]} not found"
    except subprocess.TimeoutExpired:
        return 124, f"{argv[0]} did not answer"
    return proc.returncode, (proc.stderr or proc.stdout).strip()


class UnitStartFailed(Exception):
    pass


def update_unit(target: str) -> str:
    """The template-unit instance for ``target`` (validated)."""
    if target != "rollback" and not valid_target(target):
        raise ValueError(f"not an update target: {target!r}")
    return f"mivnav-update@{target}.service"


def start_unit(target: str, runner: Runner) -> str:
    """Queue the updater for ``target`` and return the unit name. Raises
    :class:`UnitStartFailed` with systemctl's own words (typically polkit
    refusing because ``install.sh`` never installed the rule)."""
    unit = update_unit(target)
    code, output = runner(["systemctl", "start", "--no-block", unit])
    if code != 0:
        raise UnitStartFailed(output or f"systemctl exited with {code}")
    return unit
