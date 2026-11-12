# SPDX-License-Identifier: GPL-2.0-only
"""Named visual-settings profiles: CRUD, opacity of the blob, and the
bounds the backend does enforce."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from mivnav.config.profiles import MAX_PROFILES, LayoutStore, NamedBlobStore, ProfileError, ProfileStore

# a plausible frontend ChartSettings payload — the backend must not care
NIGHT = {
    "colorScheme": "night",
    "safetyContour": 3,
    "shallowContour": 2,
    "deepContour": 10,
    "displayCategory": "standard",
    "showText": False,
    "twoShades": True,
}


def store_at(tmp_path: Path) -> ProfileStore:
    return ProfileStore(tmp_path / "profiles.json")


def test_save_get_list_delete(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    assert store.list() == []
    assert store.get("Night") is None

    saved = store.save("Night", NIGHT)
    assert saved["name"] == "Night"
    assert saved["settings"] == NIGHT
    assert saved["updated"] > 0

    assert store.get("Night")["settings"] == NIGHT
    assert [p["name"] for p in store.list()] == ["Night"]

    assert store.delete("Night") is True
    assert store.delete("Night") is False  # idempotent, reports the truth
    assert store.list() == []


def test_profiles_round_trip_through_disk(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    store.save("Night", NIGHT)
    store.save("Day", {"colorScheme": "day"})
    reopened = ProfileStore(store.path)  # i.e. a server restart
    assert {p["name"] for p in reopened.list()} == {"Night", "Day"}
    assert reopened.get("Night")["settings"] == NIGHT


def test_saving_an_existing_name_replaces_it(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    store.save("Night", NIGHT)
    store.save("Night", {"colorScheme": "dusk"})
    assert store.get("Night")["settings"] == {"colorScheme": "dusk"}
    assert len(store.list()) == 1


def test_the_settings_blob_is_opaque(tmp_path: Path) -> None:
    """The backend stores and returns the frontend's object verbatim: it
    does not model, validate or reshape display fields (it has no use for
    a safety contour and would need a migration per new toggle)."""
    store = store_at(tmp_path)
    weird = {"fieldTheBackendHasNeverHeardOf": [1, {"nested": None}], "safetyContour": "not a number"}
    assert store.save("X", weird)["settings"] == weird
    assert ProfileStore(store.path).get("X")["settings"] == weird


def test_names_are_human_and_bounded(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    # a name is a key inside one document, never a filename, so it is free
    # to be prose
    assert store.save("Night sailing, Skagerrak (2026)", NIGHT)["name"] is not None
    assert store.save("Nattsegling — Skagerrak", NIGHT)["name"] == "Nattsegling — Skagerrak"
    assert store.save("  padded  ", NIGHT)["name"] == "padded"
    assert store.get("padded") is not None

    for bad in ("", "   ", "x" * 65, "bad\nname", "bad\x00name"):
        with pytest.raises(ProfileError):
            store.save(bad, NIGHT)


def test_slashes_are_refused_because_the_name_is_a_url_path_segment(tmp_path: Path) -> None:
    # not traversal — the name is never a filename — but /config/profiles/{name}
    # cannot address a name containing a route boundary
    store = store_at(tmp_path)
    for bad in ("a/b", "../../etc/passwd", "back\\slash"):
        with pytest.raises(ProfileError):
            store.save(bad, NIGHT)
    # nothing the store writes is ever named after user input anyway
    store.save("Night", NIGHT)
    assert sorted(p.name for p in tmp_path.iterdir()) == ["profiles.json"]


def test_settings_must_be_a_bounded_json_object(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    for bad in ("a string", 42, ["a", "list"], None):
        with pytest.raises(ProfileError):
            store.save("X", bad)
    with pytest.raises(ProfileError):
        store.save("X", {"huge": "x" * 70_000})


def test_profile_count_is_capped(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    for i in range(MAX_PROFILES):
        store.save(f"p{i}", NIGHT)
    with pytest.raises(ProfileError):
        store.save("one too many", NIGHT)
    store.save("p0", {"replacing an existing one": "is still fine"})  # not a new name


def test_list_is_newest_first(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    store.save("old", NIGHT)
    store.save("new", NIGHT)
    assert [p["name"] for p in store.list()] == ["new", "old"]


def test_default_points_at_a_profile_and_round_trips(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    assert store.default() is None
    # cannot anoint what does not exist
    assert store.set_default("Night") is False
    assert store.default() is None

    store.save("Night", NIGHT)
    assert store.set_default("Night") is True
    assert store.default() == "Night"
    # survives a restart
    assert ProfileStore(store.path).default() == "Night"


def test_setting_default_replaces_and_clearing_is_scoped(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    store.save("Night", NIGHT)
    store.save("Day", {"colorScheme": "day"})
    store.set_default("Night")
    store.set_default("Day")  # replaces
    assert store.default() == "Day"

    store.clear_default("Night")  # not the default: no-op
    assert store.default() == "Day"
    store.clear_default("Day")
    assert store.default() is None
    store.clear_default()  # idempotent
    assert store.default() is None

    store.set_default("Day")
    store.clear_default()  # unscoped clear works too
    assert store.default() is None


def test_deleting_the_default_profile_clears_the_pointer(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    store.save("Night", NIGHT)
    store.set_default("Night")
    store.delete("Night")
    assert store.default() is None
    assert ProfileStore(store.path).default() is None  # no dangling pointer on disk


def test_a_dangling_default_on_disk_reads_as_unset(tmp_path: Path) -> None:
    # a hand edit that deletes the profile but leaves the pointer, or names
    # a profile that never existed, must not resolve to a dangling reference
    path = tmp_path / "profiles.json"
    path.write_text(json.dumps({"profiles": {}, "default": "Ghost"}))
    assert ProfileStore(path).default() is None


def test_a_corrupt_profiles_file_does_not_stop_the_plotter(tmp_path: Path) -> None:
    # presets are cosmetic; a boat that will not boot because of them is
    # a worse boat than one that lost them
    path = tmp_path / "profiles.json"
    path.write_text("{ not json")
    assert ProfileStore(path).list() == []
    path.write_text(json.dumps({"profiles": "not a dict"}))
    assert ProfileStore(path).list() == []
    # and it recovers: a save rewrites the file
    store = ProfileStore(path)
    store.save("Night", NIGHT)
    assert ProfileStore(path).get("Night")["settings"] == NIGHT


# -- NamedBlobStore, at the "layout" kind (LayoutStore) ---------------------
# `ProfileStore` IS `NamedBlobStore` at the profile kind/collection/entry-key
# defaults (every test above already exercises the shared machinery); these
# confirm the OTHER kind gets its own vocabulary, its own file-shaped
# document, and never collides with a profile store pointed elsewhere.

ARRANGEMENT = {"enabled": {"nav.sog": False}, "bands": {"rail": {"order": []}}}


def test_layout_store_is_a_named_blob_store_at_the_layout_kind(tmp_path: Path) -> None:
    store = LayoutStore(tmp_path / "layouts.json")
    assert isinstance(store, NamedBlobStore)
    saved = store.save("Passage", ARRANGEMENT)
    assert saved["name"] == "Passage"
    # the per-entry key is "arrangement", not "settings" — reusing the
    # profile's wire name here would read as if a layout WERE settings
    assert saved["arrangement"] == ARRANGEMENT
    assert "settings" not in saved
    assert store.get("Passage")["arrangement"] == ARRANGEMENT


def test_layout_store_errors_name_the_right_kind(tmp_path: Path) -> None:
    store = LayoutStore(tmp_path / "layouts.json")
    with pytest.raises(ProfileError, match="layout name"):
        store.save("", ARRANGEMENT)
    with pytest.raises(ProfileError, match="layout settings"):
        store.save("Passage", "not an object")


def test_layout_store_on_disk_uses_its_own_collection_key(tmp_path: Path) -> None:
    path = tmp_path / "layouts.json"
    LayoutStore(path).save("Passage", ARRANGEMENT)
    raw = json.loads(path.read_text())
    assert "layouts" in raw
    assert raw["layouts"]["Passage"]["arrangement"] == ARRANGEMENT


def test_two_kinds_must_never_share_a_path(tmp_path: Path) -> None:
    """`_write` serialises the WHOLE document from this store's own
    in-memory `_entries` — it does not read-modify-write the file, so it
    has no way to preserve a sibling collection key it does not know
    about. Pointing a profile store and a layout store at the same file is
    therefore destructive (the second `save` wipes the first store's
    entries entirely), which is exactly why `mivnav.api.deps.get_runtime`
    always gives them separate files and `_DEFAULT_PATH_BY_KIND` gives
    each kind its own default. This pins the hazard rather than asserting
    a safety the class does not provide."""
    path = tmp_path / "shared.json"
    ProfileStore(path).save("Night", NIGHT)
    LayoutStore(path).save("Passage", ARRANGEMENT)
    assert ProfileStore(path).get("Night") is None  # wiped by the layout save above
    assert LayoutStore(path).get("Passage")["arrangement"] == ARRANGEMENT


def test_layout_store_default_path_is_not_the_profile_store_default_path() -> None:
    # the whole point of `_DEFAULT_PATH_BY_KIND`: a caller that forgets to
    # pass a path for one kind must not land on the other kind's file. Not
    # exercised by constructing a path-less store here — that would read
    # whatever real file happens to sit at $XDG_CONFIG_HOME/mivnav on this
    # machine — so this goes through the path helpers `_DEFAULT_PATH_BY_KIND`
    # is built from directly.
    from mivnav.config.model import default_layouts_path, default_profiles_path

    assert default_layouts_path().name == "layouts.json"
    assert default_profiles_path().name == "profiles.json"
    assert default_layouts_path() != default_profiles_path()
