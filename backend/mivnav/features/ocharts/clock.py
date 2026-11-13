# SPDX-License-Identifier: GPL-2.0-only
"""Today's date for the install-period check (o-charts policy: a set may
only be installed during its licence period — see ``install.py``).

The Pi on the boat has no RTC and usually no internet, so its clock may be
anything. The rule, in order:

1. The system clock, if it is synchronised (NTP, or chrony/gpsd feeding it
   from the GPS — ``timedatectl``'s ``NTPSynchronized``, which reads the
   kernel's sync flag, or systemd-timesyncd's marker file).
2. The GPS: SignalK's ``navigation.datetime`` of the own ship, while its
   fix is live.
3. The unsynchronised system clock, but only if it is plausible: not before
   :data:`CLOCK_FLOOR` (this check was written then) nor before the newest
   file in the set's own zip (o-charts built it, so it exists). This is the
   weak case — a Pi restoring its last shutdown time (fake-hwclock) runs
   *behind* — but it never accepts a clock that is provably wrong.
4. Otherwise there is no date to trust and the install is refused.
"""

from __future__ import annotations

import logging
import subprocess
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

#: No correct clock reads earlier than the day this check was written.
CLOCK_FLOOR = date(2026, 11, 13)

#: systemd-timesyncd's "synchronised at least once since boot" marker.
TIMESYNC_MARKER = Path("/run/systemd/timesync/synchronized")


class UntrustedClock(Exception):
    """No date can be trusted; the message says why and what to do."""


def system_clock_synchronised() -> bool:
    if TIMESYNC_MARKER.exists():
        return True
    try:
        out = subprocess.run(
            ["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
            capture_output=True,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return out.returncode == 0 and out.stdout.strip() == "yes"


def gps_date(snapshot: dict[str, Any]) -> date | None:
    """The UTC date of the own ship's ``navigation.datetime``, if its fix
    is live (``fixAge`` is present only while the fix is stale)."""
    own = snapshot.get("self")
    if not own or "fixAge" in snapshot:
        return None
    iso = own.get("positionAtIso")
    if not isinstance(iso, str):
        return None
    try:
        when = datetime.fromisoformat(iso)
    except ValueError:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return when.astimezone(UTC).date()


class InstallClock:
    """See the module docstring for the rule. Every source is injectable."""

    def __init__(
        self,
        gps: Callable[[], date | None] | None = None,
        synchronised: Callable[[], bool] = system_clock_synchronised,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._gps = gps
        self._synchronised = synchronised
        self._now = now

    def today(self, not_before: date | None = None) -> tuple[date, str]:
        """``(today, where it came from)``, or :class:`UntrustedClock`.
        ``not_before`` is a date the clock provably cannot precede (the
        set's own build date); it only matters for the fallback."""
        system = self._now().astimezone(UTC).date()
        if self._synchronised():
            return system, "synchronised system clock"
        if self._gps is not None:
            try:
                gps = self._gps()
            except Exception:  # noqa: BLE001 — a broken source is just absent
                log.exception("reading the GPS date failed")
                gps = None
            if gps is not None:
                return gps, "GPS"
        floor = CLOCK_FLOOR
        if not_before is not None:
            # a day of slack: the zip's times are the builder's local time
            floor = max(floor, not_before - timedelta(days=1))
        if system >= floor:
            return system, "system clock (not synchronised)"
        raise UntrustedClock(
            f"cannot tell today's date to check the licence period: the system "
            f"clock reads {system.isoformat()}, which is older than this software "
            f"or the chart set, and neither a synchronised clock nor a live GPS "
            f"time is available — set the clock or connect the GPS, then try again"
        )
