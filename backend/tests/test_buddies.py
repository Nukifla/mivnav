# SPDX-License-Identifier: GPL-2.0-only
import json
import threading
import time
from pathlib import Path

import pytest

from mivnav.features.buddies import aiscast
from mivnav.features.buddies.model import Fix, Report, newest
from mivnav.features.buddies.runtime import BuddiesRuntime, DuplicateBuddy
from mivnav.signalk.model import VesselTracker

NOW = 1_800_000_000.0
#: Trimmed from the live reply of 2026-10-31.
AISCAST_BODY = {
    "features": [
        {
            "geometry": {"coordinates": [18.999, 69.664], "type": "Point"},
            "properties": {
                "callsign": "OZ1234",
                "cog": 22.7,
                "length": 12,
                "mmsi": 219123456,
                "name": "SEABIRD",
                "seen": "2026-10-25T11:29:39Z",
                "sog": 5.1,
                "source": "aishub",
                "type": 36,
            },
        }
    ]
}


def fix(source: str, at: float, lat: float = 1.0) -> Fix:
    return Fix(source=source, lat=lat, lng=2.0, fix_at=at)


def test_newest_fix_wins_whichever_source_it_came_from() -> None:
    assert newest([fix("signalk", NOW - 600), fix("aiscast", NOW - 60)], NOW).source == "aiscast"


def test_the_boats_own_receiver_wins_a_near_tie() -> None:
    assert newest([fix("aiscast", NOW - 10), fix("signalk", NOW - 25)], NOW).source == "signalk"


def test_a_fix_from_the_future_cannot_outrank_a_good_one() -> None:
    assert newest([fix("aiscast", NOW + 3600), fix("signalk", NOW - 60)], NOW).source == "signalk"


def test_aiscast_speed_is_knots_and_is_stored_as_ms() -> None:
    report = aiscast.parse(AISCAST_BODY)[0]
    assert report.mmsi == "219123456"
    assert report.name == "SEABIRD"
    assert report.fix.sog_ms == pytest.approx(5.1 * 0.514444, abs=1e-3)
    assert report.fix.via == "aishub"


def test_a_malformed_feature_costs_one_boat_not_the_poll() -> None:
    body = {"features": [{"geometry": None}, *AISCAST_BODY["features"]]}
    assert [r.mmsi for r in aiscast.parse(body)] == ["219123456"]


def test_poll_batches_at_the_measured_limit_of_ten() -> None:
    urls: list[str] = []
    aiscast.poll([f"{i:09d}" for i in range(23)], lambda url: urls.append(url) or {})
    assert [u.split("=")[1].count(",") + 1 for u in urls] == [10, 10, 3]


def runtime(tmp_path: Path, poll, signalk=None, clock=lambda: NOW) -> BuddiesRuntime:
    return BuddiesRuntime(
        signalk,
        list_path=tmp_path / "buddies.json",
        positions_path=tmp_path / "positions.json",
        poll=poll,
        clock=clock,
    )


def report(mmsi: str, at: float) -> Report:
    return Report(mmsi=mmsi, fix=fix("aiscast", at), name="SEABIRD")


def test_a_buddy_with_no_position_is_listed_without_one(tmp_path: Path) -> None:
    rt = runtime(tmp_path, lambda _m: [])
    rt.add("219123456", "bird")
    assert [(b["nickname"], "position" in b) for b in rt.list()["buddies"]] == [("bird", False)]
    rt.close()


def test_add_answers_without_waiting_for_the_network(tmp_path: Path) -> None:
    release = threading.Event()

    def slow(_m):
        release.wait(5)
        return []

    rt = runtime(tmp_path, slow)
    started = time.monotonic()
    rt.add("219123456", None)
    assert time.monotonic() - started < 1
    release.set()
    rt.close()


def test_a_failed_poll_keeps_the_saved_position_and_only_ages_it(tmp_path: Path) -> None:
    calls = {"n": 0}

    def poll(_m):
        calls["n"] += 1
        if calls["n"] > 1:
            raise OSError("no internet")
        return [report("219123456", NOW - 100)]

    rt = runtime(tmp_path, poll)
    rt.add("219123456", None)
    rt.refresh()
    rt.refresh()
    listed = rt.list()
    assert listed["lastPoll"]["ok"] is False
    assert listed["buddies"][0]["position"]["ageS"] == 100
    assert listed["buddies"][0]["aisName"] == "SEABIRD"
    rt.close()


def test_positions_survive_a_restart(tmp_path: Path) -> None:
    first = runtime(tmp_path, lambda _m: [report("219123456", NOW - 432_000)])
    first.add("219123456", None)
    first.refresh()
    first.close()

    second = runtime(tmp_path, lambda _m: [])
    position = second.list()["buddies"][0]["position"]
    assert position["ageS"] == 432_000
    second.close()


def test_an_older_report_never_replaces_a_newer_one(tmp_path: Path) -> None:
    answers = [[report("219123456", NOW - 10)], [report("219123456", NOW - 500)]]
    rt = runtime(tmp_path, lambda _m: answers.pop(0))
    rt.add("219123456", None)
    rt.refresh()
    assert rt.list()["buddies"][0]["position"]["ageS"] == 10
    rt.close()


def test_a_note_is_saved_beside_the_nickname_and_can_be_cleared(tmp_path: Path) -> None:
    rt = runtime(tmp_path, lambda _m: [])
    buddy = rt.add("219123456", None)
    assert rt.edit(buddy["id"], "bird", "Meet in Tromsø")["note"] == "Meet in Tromsø"

    reopened = runtime(tmp_path, lambda _m: [])
    assert reopened.list()["buddies"][0]["note"] == "Meet in Tromsø"
    assert "note" not in reopened.edit(buddy["id"], "bird", None)
    rt.close()
    reopened.close()


def test_duplicate_mmsi_refused(tmp_path: Path) -> None:
    rt = runtime(tmp_path, lambda _m: [])
    rt.add("219123456", None)
    with pytest.raises(DuplicateBuddy):
        rt.add("219123456", "again")
    rt.close()


def test_a_corrupt_list_is_an_error_not_an_empty_list(tmp_path: Path) -> None:
    (tmp_path / "buddies.json").write_text("{not json")
    rt = runtime(tmp_path, lambda _m: [])
    with pytest.raises(ValueError):
        rt.add("219123456", None)
    assert (tmp_path / "buddies.json").read_text() == "{not json"


def test_a_list_saved_before_the_nickname_rename_keeps_its_nicknames(tmp_path: Path) -> None:
    (tmp_path / "buddies.json").write_text(
        json.dumps({"buddies": [{"id": "a", "name": "bird", "mmsi": "219123456"}]})
    )
    rt = runtime(tmp_path, lambda _m: [])
    assert rt.list()["buddies"][0]["nickname"] == "bird"
    rt.close()


def delta(mmsi: str, source: str, stamp: str) -> str:
    return json.dumps(
        {
            "context": f"vessels.urn:mrn:imo:mmsi:{mmsi}",
            "updates": [
                {
                    "$source": source,
                    "timestamp": stamp,
                    "values": [
                        {
                            "path": "navigation.position",
                            "value": {"latitude": 56.0, "longitude": 10.0},
                        },
                        {"path": "", "value": {"mmsi": mmsi}},
                    ],
                }
            ],
        }
    )


def targets(tracker: VesselTracker, now: float) -> list[dict]:
    return tracker.snapshot(now, 600.0)["targets"]


def test_origin_says_where_a_position_came_from() -> None:
    tracker = VesselTracker()
    tracker.apply(delta("219654321", "signalk-aiscast.net", "2026-10-31T16:00:00Z"), 1000.0)
    assert targets(tracker, 1000.0)[0]["origin"] == "online"
    tracker.apply(delta("219654321", "can0.1", "2026-10-31T16:00:10Z"), 1010.0)
    assert targets(tracker, 1010.0)[0]["origin"] == "both"


def test_origin_forgets_a_receiver_that_stopped_hearing_the_ship() -> None:
    tracker = VesselTracker()
    tracker.apply(delta("219654321", "can0.1", "2026-10-31T16:00:00Z"), 1000.0)
    tracker.apply(delta("219654321", "signalk-aiscast.net", "2026-10-31T16:12:00Z"), 1720.0)
    assert targets(tracker, 1720.0)[0]["origin"] == "online"


def test_position_reports_carry_the_report_time_and_outlive_the_ttl() -> None:
    tracker = VesselTracker()
    tracker.apply(delta("219654321", "can0.1", "2026-10-31T16:00:00Z"), 1000.0)
    tracker.apply(delta("219654321", "can0.1", "2026-10-31T16:00:00Z"), 1000.0)
    reports = tracker.position_reports(frozenset({"219654321"}))
    assert reports[0]["reportIso"] == "2026-10-31T16:00:00Z"
    assert reports[0]["online"] is False
    assert tracker.position_reports(frozenset({"999999999"})) == []
