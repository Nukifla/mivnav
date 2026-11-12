# SPDX-License-Identifier: GPL-2.0-only
"""The normalized vessel picture, and the delta rules that maintain it.

Pure (no sockets/threads/clock — every time-aware method takes ``now``); the
snapshot IS the wire format; absent fields stay absent (AIS is partial by
design). Full rationale: docs/architecture/signalk-model.md.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from mivnav.autopilot.model import AutopilotState
from mivnav.collision.notices import NoticeState
from mivnav.shallow.notices import ShallowNoticeState
from mivnav.signalk.anchor import FROM_BOW_PATH, AnchorState, is_plugin_source
from mivnav.signalk.mob import MobNoticeState

# SignalK angles are radians; a chart plotter thinks in degrees.
_DEG = 180.0 / math.pi
# rad/s → deg/min: what AIS reports and what a mariner reads.
_DEG_PER_MIN = _DEG * 60.0

#: The ladder :func:`stale_age` reports on. Bucketed (not raw) because the
#: snapshot is only published on change: a raw age would differ every tick
#: and broadcast a dead sensor forever; bucketed, it costs one publish per
#: rung, then silence at the cap.
_AGE_BUCKETS = (10, 20, 30, 45, 60, 90, 120, 300, 600, 1800, 3600)

#: First rung by construction (not a second number that could drift): a
#: sounder/wind vane report at 1Hz+, so 10s of silence means stopped, not a
#: slow tick. Deliberately the frontend's `FIX_STALE_AFTER_S` — one idea of
#: "recently".
STALE_AFTER = float(_AGE_BUCKETS[0])

#: The ``$source`` prefix of positions that came over the internet rather
#: than from the boat's own receiver: the signalk-aiscast plugin, measured as
#: ``signalk-aiscast.net`` (own receiver: ``can0.1``). Everything else counts
#: as local, so an unknown new input never claims to be online.
ONLINE_SOURCE = "signalk-aiscast"
#: How recently a source must have given a position to count in ``origin``.
#: SignalK's ``values`` keeps a source's last report forever, so "ever heard
#: on our receiver" would say "both" about a ship that left hours ago.
ORIGIN_WINDOW_S = 10 * 60.0


def stale_age(age: float) -> int | None:
    """Seconds-ish since the last reading if it is stale, else ``None``.

    ``None`` is the *only* thing that means fresh — a sensor never heard
    from has no entry at all, so a consumer can't confuse "heard 2s ago"
    with "never spoken". Rounded down to a rung of :data:`_AGE_BUCKETS` so
    the age never overstates freshness, capped at the top rung.
    """
    if age < _AGE_BUCKETS[0]:
        return None
    rung = _AGE_BUCKETS[0]
    for candidate in _AGE_BUCKETS:
        if age < candidate:
            break
        rung = candidate
    return rung


def _note_position_source(vessel: Vessel, update: dict[str, Any], now: float) -> None:
    """Record where a position report came from and when it was taken.
    ``$source`` is the v1 stream's form, ``source.label`` the object form
    (the same two :func:`~mivnav.signalk.anchor.is_plugin_source` accepts)."""
    stamp = update.get("timestamp")
    vessel.position_report_iso = stamp if isinstance(stamp, str) else None
    label = update.get("$source")
    if not isinstance(label, str):
        source = update.get("source")
        label = source.get("label") if isinstance(source, dict) else None
    if not isinstance(label, str):
        return
    vessel.position_online = label.split(".", 1)[0] == ONLINE_SOURCE
    if vessel.position_online:
        vessel.online_position_at = now
    else:
        vessel.local_position_at = now


@dataclass
class Vessel:
    """One vessel's live state, in plotter units.

    SI on the way in (SignalK is m/s, radians, metres), plotter units on the
    way out, and the unit rides in the name at both ends — a units bug here
    is a silent wrong answer, so it has to be visible at the assignment.
    """

    #: SignalK's vessel key (``urn:mrn:imo:mmsi:265123456``). Identity, and
    #: the one field that is always on the wire: see :meth:`wire`.
    id: str = ""

    # -- position and motion (navigation.*) --------------------------------
    lng: float | None = None
    lat: float | None = None
    heading_deg: float | None = None
    cog_deg: float | None = None
    sog_ms: float | None = None
    stw_ms: float | None = None
    rot_deg_per_min: float | None = None
    position_at_iso: str | None = None

    # -- the boat's own sensors (environment.*) ----------------------------
    # Own-ship only in practice. Unlike everything above, these are
    # *guarded* readings (the depth instrument is an alarm's face), so
    # they're the only fields with an arrival time (see :attr:`seen_at`).
    depth_below_transducer_m: float | None = None
    depth_below_surface_m: float | None = None
    #: The CLEARANCE under the keel, as the boat's SignalK computes it from
    #: its configured offsets — shown on the depth tile when reported; the
    #: shallow alarm prefers the two depths above (mivnav.shallow.watch).
    depth_below_keel_m: float | None = None
    aws_ms: float | None = None
    awa_deg: float | None = None
    tws_ms: float | None = None
    twa_deg: float | None = None

    #: Wire-field name → wall-clock seconds of the last *accepted* value.
    #: Only the guarded ``environment.*`` fields are stamped. Keyed by the
    #: *wire* name so :meth:`wire`'s ``stale`` map needs no translation.
    seen_at: dict[str, float] = field(default_factory=dict)

    # -- identity (root keys, communication.*, registrations.*) ------------
    name: str | None = None
    mmsi: str | None = None
    callsign: str | None = None
    imo: str | None = None
    flag: str | None = None
    port: str | None = None
    #: ``sensors.ais.class`` — "A"/"B"/"ATON"/"BASE" by convention. Kept as
    #: a free string: the SignalK schema declares no enum for it (its
    #: constraint is a misspelled, inert ``pattern_`` key), so an
    #: unrecognised value is the transport's business, not ours to drop.
    ais_class: str | None = None

    # -- what kind of ship (design.*) --------------------------------------
    ship_type: str | None = None
    ship_type_id: int | None = None
    length_m: float | None = None
    beam_m: float | None = None
    air_height_m: float | None = None
    #: Held as both halves: n2k-signalk writes AIS msg 5's draft to
    #: ``design.draft.maximum``, nmea0183-signalk to ``design.draft.current``.
    #: Reading only one drops the draft of half the fleet; :meth:`wire`
    #: collapses the two into one ``draftM``.
    draft_current_m: float | None = None
    draft_max_m: float | None = None

    # -- where it is going (navigation.*) ----------------------------------
    nav_status: str | None = None
    destination: str | None = None
    eta_iso: str | None = None
    special_maneuver: str | None = None

    #: Wall-clock seconds of the last delta naming this vessel.
    last_seen: float = 0.0
    #: Wall-clock seconds of the last position REPORT (changed or not — a
    #: boat at anchor is not a dead GPS). Read for the own ship only, as the
    #: snapshot's ``fixAge``; not on the wire, and not in ``stale``, whose
    #: contract is the guarded sensors.
    position_seen_at: float | None = field(default=None, repr=False)
    #: The report's own ``timestamp`` (not ``position_at_iso``, which is
    #: ``navigation.datetime`` and absent on most targets). What decides
    #: which source's position is newest, so never on the wire: it would
    #: change the snapshot on every repeat report of an unmoved ship.
    position_report_iso: str | None = field(default=None, repr=False)
    #: Wall-clock seconds of the last position per kind of source, for
    #: ``origin``. Stamped only when the update names its source.
    local_position_at: float | None = field(default=None, repr=False)
    online_position_at: float | None = field(default=None, repr=False)
    #: Did the most recent position come through the online source?
    position_online: bool = field(default=False, repr=False)

    @property
    def has_fix(self) -> bool:
        return self.lng is not None and self.lat is not None

    def origin(self, now: float) -> str | None:
        """``"local"``, ``"online"``, ``"both"``, or ``None`` with no named
        source inside :data:`ORIGIN_WINDOW_S`. A word, not two ages: ages
        would republish the snapshot for every target at every rung."""
        fresh = lambda at: at is not None and now - at <= ORIGIN_WINDOW_S  # noqa: E731
        local, online = fresh(self.local_position_at), fresh(self.online_position_at)
        if local and online:
            return "both"
        return "local" if local else "online" if online else None

    def wire(self, now: float) -> dict[str, Any]:
        """The JSON shape the browser consumes (`frontend/src/info/vessel.ts`).

        camelCase, optional keys omitted rather than nulled. ``id``/position
        are unconditional (a fixless vessel is never published).
        """
        out: dict[str, Any] = {"id": self.id, "lng": self.lng, "lat": self.lat}
        for key, value in (
            ("headingDeg", self.heading_deg),
            ("cogDeg", self.cog_deg),
            ("sogMs", self.sog_ms),
            ("stwMs", self.stw_ms),
            ("rotDegPerMin", self.rot_deg_per_min),
            ("positionAtIso", self.position_at_iso),
            # Both depths go out as reported, not collapsed like draft —
            # different questions, and the offset between them is the
            # boat's, not ours to guess.
            ("depthBelowTransducerM", self.depth_below_transducer_m),
            ("depthBelowSurfaceM", self.depth_below_surface_m),
            ("depthBelowKeelM", self.depth_below_keel_m),
            ("awsMs", self.aws_ms),
            ("awaDeg", self.awa_deg),
            ("twsMs", self.tws_ms),
            ("twaDeg", self.twa_deg),
            ("name", self.name),
            ("mmsi", self.mmsi),
            ("callsign", self.callsign),
            ("imo", self.imo),
            ("flag", self.flag),
            ("port", self.port),
            ("aisClass", self.ais_class),
            ("shipType", self.ship_type),
            ("shipTypeId", self.ship_type_id),
            ("lengthM", self.length_m),
            ("beamM", self.beam_m),
            ("airHeightM", self.air_height_m),
            # current first: it is the loaded draft *now*, where the
            # transport reports it. maximum is the same AIS field arriving
            # by the other road — see the field comments.
            ("draftM", self.draft_current_m if self.draft_current_m is not None else self.draft_max_m),
            # `navigation.state`, under the AIS term of art. Briefly went out
            # under two names because the symbol renderer and the details
            # panel had each picked one; the frontend settled on navStatus.
            ("navStatus", self.nav_status),
            ("destination", self.destination),
            ("etaIso", self.eta_iso),
            ("specialManeuver", self.special_maneuver),
            ("origin", self.origin(now)),
        ):
            if value is not None:
                out[key] = value

        # THE STALENESS SIGNAL: `{wireField: ageSeconds}`, stale fields only.
        # Invariant #6: a field in `stale` shows struck through and must not
        # alarm. See docs/architecture/signalk-model.md.
        stale = {}
        for key in sorted(self.seen_at):
            age = stale_age(now - self.seen_at[key])
            if age is not None:
                stale[key] = age
        if stale:
            out["stale"] = stale
        return out


@dataclass
class Course:
    """The boat's active steering target, as SignalK reports it right now.

    Own-ship, read-side only, the wire mirror of the v2 Course API's
    ``nextPoint``/``previousPoint`` — the SAME object
    :mod:`mivnav.features.route.client` WRITES to. See
    docs/architecture/signalk-model.md ("Course wire mirror").
    """

    next_lat: float | None = None
    next_lng: float | None = None
    prev_lat: float | None = None
    prev_lng: float | None = None

    #: True once ANY course path has arrived — the same "seen" trick
    #: :class:`~mivnav.autopilot.model.Autopilot` uses, for the same reason:
    #: it is what tells "no course right now" (cleared, or never set) apart
    #: from "nothing has ever told us".
    seen: bool = field(default=False, repr=False)

    def wire(self) -> dict[str, Any] | None:
        """The JSON the browser consumes, or ``None`` if nothing is known.

        camelCase and omit-when-absent. A course with only a previous point
        still goes out — whether that's enough to draw is the frontend's call.
        """
        if not self.seen:
            return None
        out: dict[str, Any] = {}
        for key, value in (
            ("nextLat", self.next_lat),
            ("nextLng", self.next_lng),
            ("prevLat", self.prev_lat),
            ("prevLng", self.prev_lng),
        ):
            if value is not None:
                out[key] = value
        return out


def vessel_id(context: str) -> str:
    """``vessels.urn:…`` → ``urn:…``; anything else unchanged."""
    prefix = "vessels."
    return context[len(prefix) :] if context.startswith(prefix) else context


class VesselTracker:
    """Every vessel we have heard of, which one is us, our autopilot, and our course.

    Not thread-safe by itself — :class:`~mivnav.signalk.service.SignalKService`
    owns the lock. Autopilot/course live here, not on :class:`Vessel`, because
    only this class knows which context is the own vessel.
    """

    def __init__(self, extra_paths: list[str] | None = None) -> None:
        self._vessels: dict[str, Vessel] = {}
        self._self_id: str | None = None
        self._autopilot = AutopilotState()
        self._course = CourseState()
        self._arrival = ArrivalState()
        self._anchor = AnchorState()
        # Our own collision notifications as SignalK echoes them back.
        self._notices = NoticeState()
        # ... and our own shallow-water notification (mivnav.shallow.notices).
        self._shallow_notice = ShallowNoticeState()
        # notifications.mob, ours or anyone's (mivnav.signalk.mob).
        self._mob = MobNoticeState()
        # User-chosen paths (SignalKConfig.extra_paths) whose RAW own-ship
        # value is passed through for dashboard widgets, on top of the typed
        # model. See `_capture_extra` and the `paths` map in `snapshot`.
        self._extra_paths: set[str] = set(extra_paths or ())
        # path -> {"value", "seen_at", "units"?}. Own-ship only: a widget is
        # about the boat, and the subscription context (`vessels.*`) would
        # otherwise let a neighbour's value land here too.
        self._raw: dict[str, dict[str, Any]] = {}

    # -- writing -----------------------------------------------------------

    def apply(self, raw: str | bytes, now: float) -> None:
        """Fold one stream message in. Malformed input is dropped, not raised
        — one unparseable frame must not take the connection down with it.
        """
        try:
            message = json.loads(raw)
        except (ValueError, TypeError):
            return
        if not isinstance(message, dict):
            return

        # The hello frame carries `self`, and is the only way to tell the
        # own ship from an AIS target.
        who = message.get("self")
        if isinstance(who, str):
            self._self_id = vessel_id(who)

        updates = message.get("updates")
        if not isinstance(updates, list):
            return

        context = message.get("context")
        if not isinstance(context, str):
            # A delta with no context is about the own vessel. Before the
            # hello arrives we have no id for it, so there is nothing to
            # file it under yet.
            if self._self_id is None:
                return
            context = self._self_id
        key = vessel_id(context)
        target = self._vessel(key)
        target.last_seen = now
        is_self = key == self._self_id

        for update in updates:
            if not isinstance(update, dict):
                continue
            # `meta` carries a path's units — captured only for own-ship
            # extra paths, so a widget can label its number. Ignored for the
            # typed model, whose units are fixed by its handlers.
            if is_self and self._extra_paths:
                self._capture_meta(update.get("meta"))
            values = update.get("values")
            if not isinstance(values, list):
                continue
            # Only the plugin's own updates reach the anchor sink — see
            # `mivnav.signalk.anchor` for the N2K echo this keeps out.
            from_anchor_plugin = is_self and is_plugin_source(update)
            for item in values:
                if isinstance(item, dict) and isinstance(item.get("path"), str):
                    path, value = item["path"], item.get("value")
                    _apply_value(target, path, value, now)
                    if path == "navigation.position":
                        _note_position_source(target, update, now)
                    # Every own-ship path, unfiltered: each sink does its own
                    # recognise-or-walk (AutopilotState.apply / CourseState.apply).
                    if is_self:
                        self._autopilot.apply(path, value)
                        self._course.apply(path, value)
                        self._arrival.apply(path, value)
                        self._notices.apply(path, value)
                        self._shallow_notice.apply(path, value)
                        self._mob.apply(path, value)
                        if from_anchor_plugin:
                            self._anchor.apply(path, value)
                        elif path == FROM_BOW_PATH:
                            self._anchor.set_from_bow(value)
                        # Exact-match: we subscribe to each extra path by
                        # name, so the box emits it as a leaf at that path.
                        if path in self._extra_paths:
                            self._capture_extra(path, value, now)
        # The swing track rides own-ship fixes, so it is fed once per message,
        # after the position (if any) has been folded in.
        if is_self and target.lng is not None and target.lat is not None:
            self._anchor.record(target.lng, target.lat, now)

    def expire(self, now: float, ttl: float) -> None:
        """Drop AIS targets silent for longer than ``ttl``.

        Reclamation, not presentation — :meth:`snapshot` already hides them;
        without this the vessel map grows forever. Own vessel is never
        dropped. See docs/architecture/signalk-model.md ("Reads never mutate").
        """
        stale = [
            key
            for key, vessel in self._vessels.items()
            if key != self._self_id and now - vessel.last_seen > ttl
        ]
        for key in stale:
            del self._vessels[key]

    def _capture_extra(self, path: str, value: Any, now: float) -> None:
        """Record one user-chosen path's raw value for the dashboard.

        Kept RAW — no unit conversion, no shape rules: the backend has no
        opinion about extra paths. ``null`` is skipped, not stored, so a
        silent box ages via ``age`` instead of being blanked.
        """
        if value is None:
            return
        record = self._raw.get(path)
        if record is None:
            record = self._raw[path] = {}
        record["value"] = value
        record["seen_at"] = now

    def _capture_meta(self, meta: Any) -> None:
        """Pick a unit string out of a delta's ``meta`` for an extra path.

        Meta is sent about once, values continually, so the unit is stamped
        onto the record and left there.
        """
        if not isinstance(meta, list):
            return
        for item in meta:
            if not isinstance(item, dict):
                continue
            path = item.get("path")
            body = item.get("value")
            if path in self._extra_paths and isinstance(body, dict):
                units = body.get("units")
                if isinstance(units, str) and units:
                    self._raw.setdefault(path, {})["units"] = units

    def _raw_wire(self, now: float) -> dict[str, Any]:
        """The ``paths`` map: ``{path: {value, units?, age?}}``.

        Sorted and bucketed like the vessel ``stale`` map, so a healthy
        boat's snapshot doesn't tick on every publish. ``age`` present only
        when stale.
        """
        out: dict[str, Any] = {}
        for path in sorted(self._raw):
            record = self._raw[path]
            if "value" not in record:
                continue  # units arrived, a value never did
            entry: dict[str, Any] = {"value": record["value"]}
            if record.get("units"):
                entry["units"] = record["units"]
            age = stale_age(now - record["seen_at"])
            if age is not None:
                entry["age"] = age
            out[path] = entry
        return out

    def _vessel(self, key: str) -> Vessel:
        vessel = self._vessels.get(key)
        if vessel is None:
            # The key is the vessel's identity, so it is stamped on at
            # birth rather than threaded through snapshot(): every read
            # path gets it for free, and none can forget it.
            vessel = Vessel(id=key)
            self._vessels[key] = vessel
        return vessel

    # -- reading -----------------------------------------------------------

    def anchor_track(self) -> list[list[float]]:
        """The swing track while anchored — see :meth:`AnchorState.track`.
        Not in the snapshot: up to a day of fixes has no business riding a
        5 Hz broadcast; a client asks for it (``GET /anchor/track``)."""
        return self._anchor.track()

    def position_reports(self, mmsis: frozenset[str]) -> list[dict[str, Any]]:
        """The latest position of each vessel in ``mmsis``, whatever its age —
        for the buddy list, which keeps what this tracker forgets at its TTL.
        Pure. Not part of :meth:`snapshot`: see ``position_report_iso``."""
        out = []
        for key, vessel in self._vessels.items():
            if key == self._self_id or vessel.mmsi not in mmsis or not vessel.has_fix:
                continue
            out.append(
                {
                    "mmsi": vessel.mmsi,
                    "lat": vessel.lat,
                    "lng": vessel.lng,
                    "cogDeg": vessel.cog_deg,
                    "sogMs": vessel.sog_ms,
                    "headingDeg": vessel.heading_deg,
                    "name": vessel.name,
                    "callsign": vessel.callsign,
                    "shipTypeId": vessel.ship_type_id,
                    "lengthM": vessel.length_m,
                    "reportIso": vessel.position_report_iso,
                    "seenAt": vessel.position_seen_at,
                    "online": vessel.position_online,
                }
            )
        return out

    def own_position_seen_at(self) -> float | None:
        """Wall-clock seconds of the own ship's last position report (any,
        changed or not), or ``None`` if it never reported one — what the
        GNSS-lost watch measures silence from (``SignalKService``)."""
        own = self._vessels.get(self._self_id) if self._self_id else None
        return own.position_seen_at if own is not None else None

    def snapshot(self, now: float, ttl: float) -> dict[str, Any]:
        """``{"self": …|None, "targets": [...], "autopilot": …|None,
        "course": …|None, "arrival"?: {…}, "anchor"?: {…}, "fixAge"?: s,
        "collisionNotices"?: {…}, "paths"?: {…}}``.

        Pure. Vessels without a position are held but not published; targets
        sorted by id so identical pictures compare equal, letting the
        publisher send only on change.
        """
        own = self._vessels.get(self._self_id) if self._self_id else None
        targets = [
            vessel.wire(now)
            for key, vessel in sorted(self._vessels.items())
            if key != self._self_id and vessel.has_fix and now - vessel.last_seen <= ttl
        ]
        result: dict[str, Any] = {
            "self": own.wire(now) if own is not None and own.has_fix else None,
            "targets": targets,
            "autopilot": self._autopilot.snapshot(),
            "course": self._course.snapshot(),
        }
        # Backend-internal only, never sent to the browser; present only
        # once SignalK has reported an arrival notification (see `Arrival`).
        arrival = self._arrival.snapshot()
        if arrival is not None:
            result["arrival"] = arrival
        # Omitted until the anchoralarm plugin has spoken: absent = no
        # plugin, present without `lat` = anchor up. See `signalk.anchor`.
        anchor = self._anchor.snapshot()
        if anchor is not None:
            result["anchor"] = anchor
        # Present only while the own fix is stale (bucketed like `stale`): the
        # collision assessment refuses to compute from a dead GPS.
        if own is not None and own.position_seen_at is not None:
            age = stale_age(now - own.position_seen_at)
            if age is not None:
                result["fixAge"] = age
        # Omitted while none of OUR closestApproach notifications is active
        # on SignalK (see `mivnav.collision.notices`).
        notices = self._notices.snapshot()
        if notices is not None:
            result["collisionNotices"] = notices
        shallow_notice = self._shallow_notice.snapshot()
        if shallow_notice is not None:
            result["shallowNotice"] = shallow_notice
        # Omitted while no MOB notification is active on SignalK.
        mob = self._mob.snapshot()
        if mob is not None:
            result["mobNotice"] = mob
        # Omitted when empty so a boat with no extra paths is byte-for-byte
        # the old snapshot, preserving the publish-on-change guard.
        raw = self._raw_wire(now)
        if raw:
            result["paths"] = raw
        return result


class CourseState:
    """Folds ``navigation.course*`` deltas for the own vessel into one :class:`Course`.

    Not thread-safe by itself: held by :class:`VesselTracker`.
    """

    def __init__(self) -> None:
        self._course = Course()

    def apply(self, path: str, value: Any) -> None:
        """Fold one own-ship path/value in, recursing into unrecognised
        objects: the v2 Course API reaches us as either a leaf delta or a
        nested object depending on dialect — walking resolves both.
        """
        self._apply(path, value, 0)

    def _apply(self, path: str, value: Any, depth: int) -> None:
        handler = _COURSE_HANDLERS.get(path)
        if handler is not None:
            handler(self._course, value)
            return
        if isinstance(value, dict) and depth < _MAX_DEPTH:
            for key, child in value.items():
                if isinstance(key, str):
                    self._apply(f"{path}.{key}" if path else key, child, depth + 1)

    def snapshot(self) -> dict[str, Any] | None:
        """The picture right now. Pure — never mutates."""
        return self._course.wire()


@dataclass
class Arrival:
    """Has SignalK's course-provider plugin told us the vessel reached the
    active course's next point? Own-ship, read-only, **never sent to the
    browser**. See docs/architecture/signalk-model.md ("Arrival").
    """

    arrival_circle_entered: bool = False
    perpendicular_passed: bool = False

    #: True once ANY arrival path has ever reported — the same "seen" trick
    #: `Course` uses, so a boat that has never reported either notification
    #: produces no `"arrival"` snapshot key at all.
    seen: bool = field(default=False, repr=False)

    def wire(self) -> dict[str, Any] | None:
        if not self.seen:
            return None
        return {
            "arrivalCircleEntered": self.arrival_circle_entered,
            "perpendicularPassed": self.perpendicular_passed,
        }


class ArrivalState:
    """Folds the two ``notifications.navigation.course.*`` deltas for the
    own vessel into one :class:`Arrival`. Same shape and threading contract
    as :class:`CourseState`."""

    def __init__(self) -> None:
        self._arrival = Arrival()

    def apply(self, path: str, value: Any) -> None:
        """Fold one own-ship path/value in, recursing into unrecognised
        objects — same walk as :meth:`CourseState.apply`, in case a server
        coalesces both notifications under their shared parent object."""
        self._apply(path, value, 0)

    def _apply(self, path: str, value: Any, depth: int) -> None:
        handler = _ARRIVAL_HANDLERS.get(path)
        if handler is not None:
            handler(self._arrival, value)
            return
        if isinstance(value, dict) and depth < _MAX_DEPTH:
            for key, child in value.items():
                if isinstance(key, str):
                    self._apply(f"{path}.{key}" if path else key, child, depth + 1)

    def snapshot(self) -> dict[str, Any] | None:
        """The picture right now. Pure — never mutates."""
        return self._arrival.wire()


# -- the path table --------------------------------------------------------
# One entry per SignalK path, not an if/elif ladder (see
# docs/architecture/signalk-model.md). `now` reaches the setter, not the
# caller, because only the setter knows whether the value was *accepted*.

_Setter = Callable[[Vessel, Any, float], None]


def _number(attr: str, scale: float = 1.0, *, stamp: str | None = None) -> _Setter:
    """``stamp`` is the wire-field name to record an arrival time under —
    set it for the guarded sensors, leave it off for everything else. See
    :attr:`Vessel.seen_at`."""

    def apply(vessel: Vessel, value: Any, now: float) -> None:
        if _is_number(value):
            setattr(vessel, attr, float(value) * scale)
            if stamp is not None:
                vessel.seen_at[stamp] = now

    return apply


def _integer(attr: str) -> _Setter:
    def apply(vessel: Vessel, value: Any, now: float) -> None:
        if _is_number(value):
            setattr(vessel, attr, int(value))

    return apply


def _text(attr: str) -> _Setter:
    def apply(vessel: Vessel, value: Any, now: float) -> None:
        # AIS pads fixed-width string fields; an unset one arrives as spaces
        # or "". Blank must read as absent, not an empty answer.
        if isinstance(value, str) and value.strip():
            setattr(vessel, attr, value.strip())

    return apply


def _digits(attr: str) -> _Setter:
    """A numeric identity (MMSI). String on the wire — leading zeros are
    part of a nine-digit MMSI — but accepted as an int, because a parser
    that JSON-encodes it as a number is a thing that happens."""

    def apply(vessel: Vessel, value: Any, now: float) -> None:
        if isinstance(value, str) and value.strip():
            setattr(vessel, attr, value.strip())
        elif isinstance(value, int) and not isinstance(value, bool):
            setattr(vessel, attr, str(value))

    return apply


def _set_position(vessel: Vessel, value: Any, now: float) -> None:
    if not isinstance(value, dict):
        return
    lat, lng = value.get("latitude"), value.get("longitude")
    # Both or neither: half a fix is not a position, and keeping the old
    # one is better than plotting the boat on the equator.
    if _is_number(lat) and _is_number(lng):
        vessel.lat, vessel.lng = float(lat), float(lng)
        vessel.position_seen_at = now


_HANDLERS: dict[str, _Setter] = {
    # -- position and motion ----------------------------------------------
    "navigation.position": _set_position,
    "navigation.headingTrue": _number("heading_deg", _DEG),
    "navigation.courseOverGroundTrue": _number("cog_deg", _DEG),
    "navigation.speedOverGround": _number("sog_ms"),
    "navigation.speedThroughWater": _number("stw_ms"),
    "navigation.rateOfTurn": _number("rot_deg_per_min", _DEG_PER_MIN),
    "navigation.datetime": _text("position_at_iso"),
    # -- the boat's own sensors --------------------------------------------
    # DEPTH/WIND field choices: see docs/architecture/signalk-model.md
    # ("Depth pair", "Wind quartet"). Angles keep SignalK's sign convention:
    # -180..180, - to port.
    "environment.depth.belowTransducer": _number(
        "depth_below_transducer_m", stamp="depthBelowTransducerM"
    ),
    "environment.depth.belowSurface": _number("depth_below_surface_m", stamp="depthBelowSurfaceM"),
    "environment.depth.belowKeel": _number("depth_below_keel_m", stamp="depthBelowKeelM"),
    "environment.wind.speedApparent": _number("aws_ms", stamp="awsMs"),
    "environment.wind.angleApparent": _number("awa_deg", _DEG, stamp="awaDeg"),
    "environment.wind.speedTrue": _number("tws_ms", stamp="twsMs"),
    "environment.wind.angleTrueWater": _number("twa_deg", _DEG, stamp="twaDeg"),
    # -- identity ----------------------------------------------------------
    "name": _text("name"),
    "mmsi": _digits("mmsi"),
    "flag": _text("flag"),
    "port": _text("port"),
    "communication.callsignVhf": _text("callsign"),
    "registrations.imo": _text("imo"),
    "sensors.ais.class": _text("ais_class"),
    # -- what kind of ship -------------------------------------------------
    "design.aisShipType.id": _integer("ship_type_id"),
    "design.aisShipType.name": _text("ship_type"),
    "design.length.overall": _number("length_m"),
    "design.beam": _number("beam_m"),
    "design.airHeight": _number("air_height_m"),
    "design.draft.current": _number("draft_current_m"),
    "design.draft.maximum": _number("draft_max_m"),
    # -- where it is going -------------------------------------------------
    # Verbatim, not remapped: both parsers emit values outside the spec's
    # 29-value enum, and an unrecognised status shown as-is beats one dropped.
    "navigation.state": _text("nav_status"),
    "navigation.destination.commonName": _text("destination"),
    "navigation.destination.eta": _text("eta_iso"),
    # OFF-SPEC ON PURPOSE: schema says `navigation.maneuver`, both real
    # transports emit `navigation.specialManeuver`. Do not "fix" this.
    "navigation.specialManeuver": _text("special_maneuver"),
    "navigation.maneuver": _text("special_maneuver"),
}


def _apply_course_position(course: Course, which: str, value: Any) -> None:
    """Accept one ``{"latitude", "longitude"}`` object as the course's
    ``next`` or ``previous`` point. Both or neither, like `_set_position`."""
    if not isinstance(value, dict):
        return
    lat, lng = value.get("latitude"), value.get("longitude")
    if _is_number(lat) and _is_number(lng):
        if which == "next":
            course.next_lat, course.next_lng = float(lat), float(lng)
        else:
            course.prev_lat, course.prev_lng = float(lat), float(lng)
        course.seen = True


#: Two dialects mapped onto the same fields; see docs/architecture/
#: signalk-model.md ("Course dialects") for why `courseRhumbline.*` is
#: deliberately not read.
_COURSE_HANDLERS: dict[str, Callable[[Course, Any], None]] = {
    "navigation.course.nextPoint.position": lambda c, v: _apply_course_position(c, "next", v),
    "navigation.course.previousPoint.position": lambda c, v: _apply_course_position(c, "previous", v),
    "navigation.courseGreatCircle.nextPoint.position": lambda c, v: _apply_course_position(c, "next", v),
    "navigation.courseGreatCircle.previousPoint.position": lambda c, v: _apply_course_position(
        c, "previous", v
    ),
}

#: SignalK ALARM_STATE values that mean "not actually active" — a defensive
#: extra to the normal ``value is None`` clear: the verified plugin only
#: ever sends `null`, but treating either as inactive costs nothing.
_INACTIVE_ALARM_STATES = frozenset({"normal", "nominal"})


def _apply_arrival(arrival: Arrival, attr: str, value: Any) -> None:
    """Accept one arrival notification's value: a dict with a ``state`` while
    active, or ``None`` once cleared. Sets ``arrival.seen`` on either — a
    clear is still something SignalK told us, not nothing."""
    active = isinstance(value, dict) and value.get("state") not in _INACTIVE_ALARM_STATES
    setattr(arrival, attr, active)
    arrival.seen = True


#: Full paths (``notifications.`` prefix is part of the delta path, not a
#: namespace this table strips) — verified against
#: ``SignalK/course-provider-plugin`` source (GPLv2, see
#: docs/architecture/signalk-model.md).
_ARRIVAL_HANDLERS: dict[str, Callable[[Arrival, Any], None]] = {
    "notifications.navigation.course.arrivalCircleEntered": lambda a, v: _apply_arrival(
        a, "arrival_circle_entered", v
    ),
    "notifications.navigation.course.perpendicularPassed": lambda a, v: _apply_arrival(
        a, "perpendicular_passed", v
    ),
}

#: How far into an unrecognised object to look for paths we know. Bounds
#: the walk below against a pathological (or hostile) delta; the deepest
#: real path here is `sensors.ais.class`, at three.
_MAX_DEPTH = 6


def _apply_value(vessel: Vessel, path: str, value: Any, now: float, depth: int = 0) -> None:
    """Fold one path/value into ``vessel``, recursing into objects.

    A known path is handled; an unknown one holding an object is *walked* so
    a leaf delta and a nested delta resolve the same way. ``now`` is *our*
    clock at receipt, not the update's own ``timestamp`` — see
    docs/architecture/signalk-model.md (a dead sensor RTC must not
    permanently disarm the depth guard).
    """
    handler = _HANDLERS.get(path)
    if handler is not None:
        handler(vessel, value, now)
        return
    if isinstance(value, dict) and depth < _MAX_DEPTH:
        for key, child in value.items():
            if isinstance(key, str):
                _apply_value(vessel, f"{path}.{key}" if path else key, child, now, depth + 1)


def _is_number(value: Any) -> bool:
    # bool is an int in Python, and `"heading": true` is not a heading.
    return isinstance(value, (int, float)) and not isinstance(value, bool)
