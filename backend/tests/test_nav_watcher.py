# SPDX-License-Identifier: GPL-2.0-only
"""The nav watcher: adopt SignalK's course, and react to its arrival
notifications by advancing the followed route (#yprzuqtt).

This drives a real :class:`~mivnav.features.route.watcher.NavWatcher` against a fake
SignalK service (a sequence of pushed snapshots) and the *real* route store,
asserting the behaviour that steers an autopilot:

- it reacts to an arrival notification by issuing ONE lightweight advance,
  never a re-publish, and stops following (a full publish-``None``) at the
  route's last waypoint;
- it never acts on an arrival notification whose reported course does not
  match mivnav's own stored leg (the notification may be about a course
  some other app set);
- it adopts an externally-set SignalK course as the active leg, and this
  is also how the store's active waypoint catches up AFTER mivnav's own
  advance — there is no separate "our own advance" store write;
- ``course_sync: false`` disables both;
- it re-subscribes when the connection is rebuilt (the ``None`` push), and
  forgets what it last observed when it does;
- the blocking work (the store write and any publish) happens on the
  watcher's worker thread, never on the SignalK listener thread — the
  non-blocking-listener rule the whole design rests on.

Both the full publish (:func:`~mivnav.features.route.publish.publish_active_leg`)
and the lightweight advance (:func:`~mivnav.features.route.publish.advance_active_route`)
are spied rather than driven over a socket: what matters here is *that* and
*when* the watcher calls each, and on which thread. The wire itself (URLs,
bodies, the never-break-GO rule, and the load-bearing "previousPoint comes
from route data, not the vessel" claim) is tested in ``tests/test_course.py``.
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterator

import pytest

from mivnav.features.route import watcher as watcher_module
from mivnav.features.route.publish import PublishResult
from mivnav.features.route.store import ActiveLeg
from mivnav.features.route.watcher import NavWatcher
from tests.conftest import isolated_runtime_at, memory_route_store

# A due-east, three-waypoint route near the equator.
ROUTE = {
    "name": "Passage",
    "waypoints": [
        {"id": "w1", "name": "Start", "lat": 0.0, "lon": 0.000},
        {"id": "w2", "name": "Middle", "lat": 0.0, "lon": 0.010},
        {"id": "w3", "name": "End", "lat": 0.0, "lon": 0.020},
    ],
}

OFF_SNAPSHOT: dict[str, Any] = {"status": "off"}


def snap(
    *,
    next: tuple[float, float] | None = None,
    prev: tuple[float, float] | None = None,
    arrival_circle: bool = False,
    perpendicular: bool = False,
) -> dict[str, Any]:
    """A snapshot carrying a SignalK course report
    (:class:`mivnav.signalk.model.Course`'s wire shape) and/or an arrival
    notification state (:class:`mivnav.signalk.model.Arrival`'s). The
    watcher reads neither the vessel's own position nor its fix status any
    more (#yprzuqtt) — only ``course``/``arrival`` — so this is the whole of
    what a test needs to drive it.
    """
    msg: dict[str, Any] = {"status": "connected"}
    course: dict[str, Any] = {}
    if next is not None:
        course["nextLat"], course["nextLng"] = next
    if prev is not None:
        course["prevLat"], course["prevLng"] = prev
    if course:
        msg["course"] = course
    msg["arrival"] = {"arrivalCircleEntered": arrival_circle, "perpendicularPassed": perpendicular}
    return msg


class FakeService:
    """The slice of :class:`SignalKService` the watcher uses: subscribe (with
    synchronous current-snapshot delivery), unsubscribe, and a way for the
    test to push later snapshots and the ``None`` close signal."""

    def __init__(self) -> None:
        self._listener: Callable[[dict[str, Any] | None], None] | None = None
        self.subscribes = 0
        self.unsubscribes = 0

    def subscribe(
        self, listener: Callable[[dict[str, Any] | None], None]
    ) -> Callable[[], None]:
        self.subscribes += 1
        self._listener = listener
        listener(OFF_SNAPSHOT)  # the real service delivers the snapshot at once

        def unsubscribe() -> None:
            self.unsubscribes += 1
            self._listener = None

        return unsubscribe

    def push(self, snapshot: dict[str, Any] | None) -> None:
        """Deliver a snapshot (or the ``None`` close signal) as the service
        thread would. Runs on the caller's thread — the point being that the
        watcher must not do its blocking work here."""
        listener = self._listener
        if listener is not None:
            listener(snapshot)


def wait_until(predicate: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("condition never held")


class PublishSpy:
    """Records every `publish_active_leg` call and the thread it ran on.

    Returns a real :class:`PublishResult` because the watcher now reads one
    (#zsswlmpz) — a spy that returned ``None`` would make this double lie
    about the very thing that changed. Set :attr:`result` to a failed one to
    drive the watcher's could-not-publish branch.
    """

    def __init__(self) -> None:
        self.calls: list[ActiveLeg | None] = []
        self.threads: list[str] = []
        self.result = PublishResult("cleared", "spy")

    def __call__(self, runtime: Any, active_leg: ActiveLeg | None) -> PublishResult:
        self.calls.append(active_leg)
        self.threads.append(threading.current_thread().name)
        return self.result


class AdvanceSpy:
    """Records every `advance_active_route` call and the thread it ran on —
    the lightweight arrival step, never a re-publish. Returns a real
    :class:`PublishResult` for the same reason :class:`PublishSpy` does."""

    def __init__(self) -> None:
        self.count = 0
        self.threads: list[str] = []
        self.result = PublishResult("advanced", "spy")

    def __call__(self, runtime: Any) -> PublishResult:
        self.count += 1
        self.threads.append(threading.current_thread().name)
        return self.result


@pytest.fixture
def harness(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable]:
    """Build ``(runtime, service, watcher, publish_spy, advance_spy)`` with
    the route saved, the fake service wired in, and both publish paths
    spied. ``course_sync`` on, tolerance 10 m, unless overridden."""
    created: list[NavWatcher] = []

    def build(course_sync: bool = True, match_tolerance_m: float = 10.0):
        runtime = isolated_runtime_at(tmp_path)  # SignalK disabled
        # Routes live on SignalK (#vozswkrl), and this file is about
        # THREADING, not the wire: give the store a dict box so a route can
        # exist here at all without a second HTTP server in the picture.
        # `_nearest_waypoint` still reads the store's in-memory mirror, which
        # is the property that actually matters below (nothing on the
        # listener thread may block).
        runtime.routes = memory_route_store()[0]
        runtime.config.patch(
            {
                "nav": {
                    "course_sync": course_sync,
                    "course_match_tolerance_m": match_tolerance_m,
                }
            }
        )
        runtime.routes.save("r1", ROUTE)
        service = FakeService()
        # The watcher resolves the service through runtime.signalk(); shadow
        # the method so it never touches the (disabled) real Derived.
        runtime.signalk = lambda: service  # type: ignore[method-assign]
        publish_spy = PublishSpy()
        advance_spy = AdvanceSpy()
        monkeypatch.setattr(watcher_module, "publish_active_leg", publish_spy)
        monkeypatch.setattr(watcher_module, "advance_active_route", advance_spy)
        watcher = NavWatcher(runtime)
        created.append(watcher)
        return runtime, service, watcher, publish_spy, advance_spy

    yield build
    for w in created:
        w.stop()


def active_of(runtime: Any) -> tuple[str, str] | None:
    leg = runtime.routes.active()
    return (leg.route_id, leg.waypoint_id) if leg else None


# -- reacting to arrival (#yprzuqtt) -----------------------------------------


def test_an_arrival_notification_triggers_the_lightweight_advance(harness: Callable) -> None:
    runtime, service, watcher, publish_spy, advance_spy = harness()
    runtime.routes.set_active(ActiveLeg(route_id="r1", waypoint_id="w1"))
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    # SignalK's course still agrees with the active leg (nextPoint == w1,
    # the just-arrived-at target), and it reports an arrival.
    service.push(snap(next=(0.0, 0.000), arrival_circle=True))
    wait_until(lambda: advance_spy.count >= 1)

    # The lightweight step, not a re-publish — no full publish call, and the
    # store's active waypoint has NOT moved (that is the read-side's job,
    # once SignalK echoes the new nextPoint — see the next test).
    assert publish_spy.calls == []
    assert active_of(runtime) == ("r1", "w1")


def test_an_advance_that_never_reached_signalk_is_logged_as_a_failure(
    harness: Callable, caplog
) -> None:
    # #zsswlmpz. An arrival has no HTTP caller behind it, so this log line is
    # the ONLY place a failed advance can show up — and it used to announce
    # "advancing w1 toward w2" whether or not the PUT reached the box, which
    # is how publishing could have been dead since #yprzuqtt with the log
    # still reading like a healthy boat.
    runtime, service, watcher, publish_spy, advance_spy = harness()
    advance_spy.result = PublishResult("failed", "the SignalK server did not answer PUT")
    runtime.routes.set_active(ActiveLeg(route_id="r1", waypoint_id="w1"))
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    with caplog.at_level(logging.DEBUG):
        service.push(snap(next=(0.0, 0.000), arrival_circle=True))
        wait_until(lambda: advance_spy.count >= 1)
        wait_until(lambda: any(r.levelno >= logging.WARNING for r in caplog.records))

    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert any("could NOT be advanced" in r.getMessage() for r in warnings)
    assert not any("reacted to a SignalK arrival" in r.getMessage() for r in caplog.records)


def test_perpendicular_passed_triggers_the_advance_too(harness: Callable) -> None:
    # Either notification is the arrival signal (module docstring) — the
    # circle-OR-passing-line rule, now computed by SignalK.
    runtime, service, watcher, publish_spy, advance_spy = harness()
    runtime.routes.set_active(ActiveLeg(route_id="r1", waypoint_id="w1"))
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    service.push(snap(next=(0.0, 0.000), perpendicular=True))
    wait_until(lambda: advance_spy.count >= 1)


def test_the_store_catches_up_via_the_read_side_after_an_advance(harness: Callable) -> None:
    # No special-casing an "our own advance" echo differently from an
    # external one (module docstring): the store's active waypoint moves
    # only once SignalK's course delta reports the new nextPoint, through
    # the SAME adoption mechanism #svotsyyy built for a second app.
    runtime, service, watcher, publish_spy, advance_spy = harness()
    runtime.routes.set_active(ActiveLeg(route_id="r1", waypoint_id="w1"))
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    service.push(snap(next=(0.0, 0.000), arrival_circle=True))
    wait_until(lambda: advance_spy.count >= 1)
    assert active_of(runtime) == ("r1", "w1")  # not yet — no echo seen

    # SignalK echoes the new leg (w1 -> w2) and the arrival clears (the
    # distance to the new, further-away nextPoint takes it out of range).
    service.push(snap(next=(0.0, 0.010), prev=(0.0, 0.000), arrival_circle=False))
    wait_until(lambda: active_of(runtime) == ("r1", "w2"))
    assert publish_spy.calls == []  # still never a republish


def test_stops_following_and_clears_at_the_last_waypoint(harness: Callable) -> None:
    runtime, service, watcher, publish_spy, advance_spy = harness()
    runtime.routes.set_active(ActiveLeg(route_id="r1", waypoint_id="w3"))
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    service.push(snap(next=(0.0, 0.020), arrival_circle=True))  # arrived at the last mark
    wait_until(lambda: runtime.routes.active() is None)  # route complete
    wait_until(lambda: publish_spy.calls == [None])  # a full clear, not a lightweight step
    assert advance_spy.count == 0


def test_advances_all_the_way_through_and_completes(harness: Callable) -> None:
    runtime, service, watcher, publish_spy, advance_spy = harness()
    runtime.routes.set_active(ActiveLeg(route_id="r1", waypoint_id="w1"))
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    service.push(snap(next=(0.0, 0.000), arrival_circle=True))
    wait_until(lambda: advance_spy.count == 1)
    service.push(snap(next=(0.0, 0.010), prev=(0.0, 0.000)))  # echo: w1 -> w2
    wait_until(lambda: active_of(runtime) == ("r1", "w2"))

    service.push(snap(next=(0.0, 0.010), prev=(0.0, 0.000), arrival_circle=True))
    wait_until(lambda: advance_spy.count == 2)
    service.push(snap(next=(0.0, 0.020), prev=(0.0, 0.010)))  # echo: w2 -> w3
    wait_until(lambda: active_of(runtime) == ("r1", "w3"))

    service.push(snap(next=(0.0, 0.020), prev=(0.0, 0.010), arrival_circle=True))
    wait_until(lambda: runtime.routes.active() is None)
    assert publish_spy.calls == [None]
    assert advance_spy.count == 2  # w1->w2, w2->w3; the last waypoint clears instead


def test_ignores_an_arrival_notification_whose_course_disagrees(harness: Callable) -> None:
    # A human GO'd to w1, but SignalK's actual course points somewhere else
    # entirely (a second app took over). An arrival notification about THAT
    # course must not advance (or clear) mivnav's leg.
    runtime, service, watcher, publish_spy, advance_spy = harness()
    runtime.routes.set_active(ActiveLeg(route_id="r1", waypoint_id="w1"))
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    service.push(snap(next=(5.0, 5.0), arrival_circle=True))
    time.sleep(0.1)
    assert active_of(runtime) == ("r1", "w1")
    assert advance_spy.count == 0
    assert publish_spy.calls == []


def test_arrival_with_nothing_followed_is_inert(harness: Callable) -> None:
    runtime, service, watcher, publish_spy, advance_spy = harness()
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    # A course matching no known waypoint, so the (independent) adoption
    # mechanism has nothing to adopt either — isolating this test to the
    # arrival-reaction path's own "nothing followed" guard.
    service.push(snap(next=(5.0, 5.0), arrival_circle=True))
    time.sleep(0.1)
    assert runtime.routes.active() is None
    assert advance_spy.count == 0
    assert publish_spy.calls == []


def test_arrival_fires_exactly_once_despite_a_burst(harness: Callable) -> None:
    # The 5 Hz reality: many frames report the notification still active.
    # Exactly one advance must result, not one per frame.
    runtime, service, watcher, publish_spy, advance_spy = harness()
    runtime.routes.set_active(ActiveLeg(route_id="r1", waypoint_id="w1"))
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    for _ in range(20):
        service.push(snap(next=(0.0, 0.000), arrival_circle=True))
    wait_until(lambda: advance_spy.count >= 1)
    time.sleep(0.1)
    assert advance_spy.count == 1


def test_an_irrelevant_message_stream_never_publishes(harness: Callable) -> None:
    runtime, service, watcher, publish_spy, advance_spy = harness()
    runtime.routes.set_active(ActiveLeg(route_id="r1", waypoint_id="w1"))
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    for _ in range(10):
        service.push(snap())  # no course, no arrival
    time.sleep(0.1)
    assert advance_spy.count == 0
    assert publish_spy.calls == []
    assert active_of(runtime) == ("r1", "w1")


def test_course_sync_off_disables_both_adoption_and_arrival_reaction(harness: Callable) -> None:
    runtime, service, watcher, publish_spy, advance_spy = harness(course_sync=False)
    runtime.routes.set_active(ActiveLeg(route_id="r1", waypoint_id="w1"))
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    service.push(snap(next=(0.0, 0.000), arrival_circle=True))
    time.sleep(0.1)
    assert active_of(runtime) == ("r1", "w1")  # nothing reacted
    assert advance_spy.count == 0
    assert publish_spy.calls == []


def test_resubscribe_forgets_the_last_observed_arrival(harness: Callable) -> None:
    # A rebuilt connection owes nothing to what the old one last reported —
    # the same (still-active) notification, first seen again on the fresh
    # subscription, must be treated as new, not silently ignored.
    runtime, service, watcher, publish_spy, advance_spy = harness()
    runtime.routes.set_active(ActiveLeg(route_id="r1", waypoint_id="w1"))
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    arrived = snap(next=(0.0, 0.000), arrival_circle=True)
    service.push(arrived)
    wait_until(lambda: advance_spy.count == 1)

    service.push(None)  # the connection is rebuilt
    wait_until(lambda: service.subscribes >= 2)

    service.push(arrived)  # the identical (still-active) report, re-delivered
    wait_until(lambda: advance_spy.count == 2)


# -- read side: the active leg follows SignalK too (#svotsyyy) --------------


def test_adopts_an_externally_set_course_that_matches_a_known_waypoint(harness: Callable) -> None:
    # Nothing followed locally, but SignalK already reports a course pointing
    # at w2 — as if a second app (or pypilot itself) set it. mivnav adopts it
    # as the active leg (a store write), and never publishes: SignalK already
    # has this course.
    runtime, service, watcher, publish_spy, advance_spy = harness()
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    service.push(snap(next=(0.0, 0.010)))  # w2
    wait_until(lambda: active_of(runtime) == ("r1", "w2"))
    time.sleep(0.05)
    assert publish_spy.calls == []  # adoption never republishes


def test_a_course_matching_no_known_waypoint_adopts_nothing(harness: Callable) -> None:
    runtime, service, watcher, publish_spy, advance_spy = harness()
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    # Half a degree away from every waypoint on the only saved route.
    service.push(snap(next=(5.0, 5.0)))
    time.sleep(0.1)
    assert runtime.routes.active() is None  # nothing to adopt, nothing cleared either
    assert publish_spy.calls == []


def test_repeating_the_same_course_report_does_not_re_adopt(harness: Callable) -> None:
    # Edge-triggered: a human then presses GO elsewhere; the SAME (unchanged)
    # external report must not be re-applied over that decision on the next
    # frame — it is not a new fact, so it must not act again.
    runtime, service, watcher, publish_spy, advance_spy = harness()
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    course = snap(next=(0.0, 0.010))  # w2
    service.push(course)
    wait_until(lambda: active_of(runtime) == ("r1", "w2"))

    runtime.routes.set_active(ActiveLeg(route_id="r1", waypoint_id="w3"))
    for _ in range(10):
        service.push(course)  # the identical report, repeated
    time.sleep(0.1)
    assert active_of(runtime) == ("r1", "w3")  # the human's GO stands


def test_course_sync_off_restores_fully_manual_operation(harness: Callable) -> None:
    runtime, service, watcher, publish_spy, advance_spy = harness(course_sync=False)
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    # An external course matching w2 must NOT be adopted with the override off.
    service.push(snap(next=(0.0, 0.010)))
    time.sleep(0.1)
    assert runtime.routes.active() is None


def test_resubscribe_forgets_the_last_observed_course(harness: Callable) -> None:
    # A rebuilt connection owes nothing to what the old one last reported —
    # the same report, first seen again on the fresh subscription, must be
    # treated as a change (not silently ignored as "no update").
    runtime, service, watcher, publish_spy, advance_spy = harness()
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    course = snap(next=(0.0, 0.010))  # w2
    service.push(course)
    wait_until(lambda: active_of(runtime) == ("r1", "w2"))

    # A human then GOes elsewhere, and the connection is rebuilt.
    runtime.routes.set_active(ActiveLeg(route_id="r1", waypoint_id="w3"))
    service.push(None)
    wait_until(lambda: service.subscribes >= 2)

    # The identical course, re-delivered on the fresh subscription's first
    # message, is treated as new information and re-adopted.
    service.push(course)
    wait_until(lambda: active_of(runtime) == ("r1", "w2"))


# -- rebuilt connection -------------------------------------------------------


def test_resubscribes_after_a_none_push(harness: Callable) -> None:
    runtime, service, watcher, publish_spy, advance_spy = harness()
    runtime.routes.set_active(ActiveLeg(route_id="r1", waypoint_id="w1"))
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    # The service was rebuilt (config change): it pushes None.
    service.push(None)
    wait_until(lambda: service.subscribes >= 2)  # re-resolved and re-subscribed
    assert service.unsubscribes >= 1

    # And it is live again: an arrival on the fresh subscription still acts.
    service.push(snap(next=(0.0, 0.000), arrival_circle=True))
    wait_until(lambda: advance_spy.count >= 1)


# -- the non-blocking-listener contract -------------------------------------


def test_the_advance_happens_off_the_listener_thread(harness: Callable) -> None:
    runtime, service, watcher, publish_spy, advance_spy = harness()
    runtime.routes.set_active(ActiveLeg(route_id="r1", waypoint_id="w1"))
    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    caller = threading.current_thread().name
    service.push(snap(next=(0.0, 0.000), arrival_circle=True))  # the "listener" runs on THIS thread
    wait_until(lambda: advance_spy.count >= 1)

    assert advance_spy.threads == ["nav-watcher"]
    assert caller != "nav-watcher"


def test_the_store_write_and_publish_happen_off_the_listener_thread_at_route_end(
    harness: Callable,
) -> None:
    runtime, service, watcher, publish_spy, advance_spy = harness()
    runtime.routes.set_active(ActiveLeg(route_id="r1", waypoint_id="w3"))  # the last waypoint

    write_threads: list[str] = []
    real_set_active = runtime.routes.set_active

    def recording_set_active(active: Any) -> Any:
        write_threads.append(threading.current_thread().name)
        return real_set_active(active)

    runtime.routes.set_active = recording_set_active  # type: ignore[method-assign]

    watcher.start()
    wait_until(lambda: service.subscribes >= 1)

    caller = threading.current_thread().name
    service.push(snap(next=(0.0, 0.020), arrival_circle=True))
    wait_until(lambda: runtime.routes.active() is None)

    assert write_threads == ["nav-watcher"]
    assert publish_spy.threads == ["nav-watcher"]
    assert caller != "nav-watcher"


def test_start_and_stop_are_clean_and_idempotent(harness: Callable) -> None:
    runtime, service, watcher, publish_spy, advance_spy = harness()
    watcher.start()
    watcher.start()  # idempotent
    wait_until(lambda: service.subscribes >= 1)
    watcher.stop()
    watcher.stop()  # idempotent
    assert service.unsubscribes >= 1


# -- runtime-isolation hole (ylotntqx) ---------------------------------------
#
# Not a NavWatcher bug at all: mivnav.api.app._lifespan starts a NavWatcher
# against `get_runtime()` directly whenever `app.dependency_overrides` has no
# entry for it — which happens for real, under full-suite load, because
# several fixtures' teardown does an unconditional
# `app.dependency_overrides.pop(get_runtime, None)` (test_autopilot.py,
# test_course.py, test_signalk_access.py, test_signalk_paths.py,
# test_weather_render_routes.py) instead of restoring whatever was there
# before (the pattern test_datasets_api.py's `dc` fixture already had to
# adopt for the same reason — see its docstring, vyvqpxmn). That silently
# strips the session's isolated `get_runtime` override for every later test,
# and the next `with TestClient(app) as c:` anywhere falls back to a Runtime
# built from the real $XDG_CONFIG_HOME — the developer's real
# config/live SignalK connection. A NavWatcher started against
# that real Runtime is a real background thread, named "nav-watcher" like
# any other, that keeps calling whatever `watcher_module.publish_active_leg`
# currently is — including a later, unrelated test's `monkeypatch`-installed
# Spy — until its own `stop()` runs, which under load can itself time out
# the 10s join and abandon the thread rather than kill it. That is the
# leaked `ActiveLeg` this file's flake actually was.


def test_get_runtime_fallback_is_the_isolated_runtime_not_a_fresh_one(
    isolated_runtime, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The exact fallback app.py's lifespan uses (`get_runtime()`, called
    directly, not through `app.dependency_overrides`) must return the
    session's isolated Runtime, never build a fresh one from
    `$XDG_CONFIG_HOME` — regardless of what any test's own override
    bookkeeping did. Never points this at the developer's real
    ~/.config/mivnav, even to prove the hole: XDG_CONFIG_HOME is
    monkeypatched to an empty decoy directory first, so a failing run here
    (if conftest's `_runtime` seeding is ever removed) is safe — it would
    build a throwaway Runtime rooted at the decoy, not the real one.
    """
    decoy_home = tmp_path / "decoy-config-home"
    decoy_home.mkdir()
    monkeypatch.setenv("XDG_CONFIG_HOME", str(decoy_home))

    from mivnav.api.deps import get_runtime

    assert get_runtime() is isolated_runtime, (
        "get_runtime() must be the session's isolated Runtime even when "
        "called directly — otherwise a test whose dependency_overrides "
        "bookkeeping drops the get_runtime key silently reaches past it"
    )
    assert not any(decoy_home.iterdir()), (
        "get_runtime() must not have built (and written into) a Runtime "
        "rooted at the decoy default path"
    )
