# SPDX-License-Identifier: GPL-2.0-only
"""The config object and its file: round-trips, merge-patch semantics,
validation, and the secret-handling rules."""

from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from mivnav.config import Config, ConfigError, ConfigStore, redacted
from mivnav.config.model import SECRET_MASK, first_start_datasets
from mivnav.config.store import deep_merge
from mivnav.features.ocharts.shop import Credentials

PASSWORD = "correct-horse-battery-staple"
TOKEN = "eyJhbGciOiJIUzI1NiJ9.fake-signalk-device-token"


def store_at(tmp_path: Path, **kw) -> ConfigStore:
    return ConfigStore(tmp_path / "config.json", **kw)


# -- persistence -----------------------------------------------------------


def test_first_start_seeds_and_writes_both_files(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    assert store.path.is_file()
    assert store.credentials_path.is_file()
    # what was seeded is exactly what was read back
    assert ConfigStore(store.path).get() == store.get()


def test_the_primary_config_never_contains_secrets(tmp_path: Path) -> None:
    """config.json must be safe to read, copy, back up, or paste into a
    bug report. That is only true if a password categorically cannot be in
    it — so the key is absent entirely, not merely empty."""
    store = store_at(tmp_path)
    store.patch({"credentials": {"ocharts": {"user": "sailor", "password": PASSWORD}}})

    config_raw = json.loads(store.path.read_text())
    assert "credentials" not in config_raw
    assert PASSWORD not in store.path.read_text()
    assert "sailor" not in store.path.read_text()

    # ...and the secrets file holds them, alone
    creds_raw = json.loads(store.credentials_path.read_text())
    assert creds_raw["credentials"]["ocharts"] == {"user": "sailor", "password": PASSWORD}
    assert set(creds_raw) == {"version", "credentials"}


def test_the_credentials_file_is_not_readable_by_others(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    store.patch({"credentials": {"ocharts": {"user": "a", "password": PASSWORD}}})
    assert stat.S_IMODE(store.credentials_path.stat().st_mode) == 0o600


def test_credentials_in_the_primary_config_are_refused(tmp_path: Path) -> None:
    # a hand-edit that puts a password back into the copyable file must
    # not be silently honoured
    store = store_at(tmp_path)
    raw = json.loads(store.path.read_text())
    raw["credentials"] = {"ocharts": {"user": "x", "password": "y"}}
    store.path.write_text(json.dumps(raw))
    with pytest.raises(ConfigError, match="must not contain"):
        ConfigStore(store.path)


def test_credentials_hand_edited_in_while_running_are_refused_on_reload(
    tmp_path: Path,
) -> None:
    # the same refusal must hold on the *reload* path (POST /config/reload),
    # not just at startup: an operator who pastes a password into the
    # copyable file on a running server is the exact case the split exists
    # for. Pinned separately because a check that lived in __init__ alone
    # would pass every other test here and still honour this.
    store = store_at(tmp_path)
    raw = json.loads(store.path.read_text())
    raw["credentials"] = {"ocharts": {"user": "x", "password": "y"}}
    store.path.write_text(json.dumps(raw))
    with pytest.raises(ConfigError, match="must not contain"):
        store.reload()


def test_the_credentials_file_has_its_own_lifecycle(tmp_path: Path) -> None:
    """Routine config edits must not rewrite the secrets file."""
    store = store_at(tmp_path)
    store.patch({"credentials": {"ocharts": {"user": "sailor", "password": PASSWORD}}})
    before = store.credentials_path.stat().st_mtime_ns

    store.patch({"signalk": {"host": "sk"}})
    assert store.credentials_path.stat().st_mtime_ns == before  # untouched

    store.patch({"credentials": {"ocharts": {"password": "new"}}})
    assert store.credentials_path.stat().st_mtime_ns != before


def test_a_missing_credentials_file_is_simply_no_credentials(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    store.patch({"credentials": {"ocharts": {"user": "sailor", "password": PASSWORD}}})
    store.credentials_path.unlink()
    reopened = ConfigStore(store.path)
    assert reopened.get().credentials.ocharts.user == ""
    assert reopened.get().signalk.host == "localhost"  # the rest still loads


def test_an_unsupported_config_version_is_refused(tmp_path: Path) -> None:
    # a document written by a version that knew things we do not must not
    # be validated against today's schema and acted on
    store = store_at(tmp_path)
    raw = json.loads(store.path.read_text())
    raw["version"] = 99
    store.path.write_text(json.dumps(raw))
    with pytest.raises(ConfigError, match="version"):
        ConfigStore(store.path)


def test_config_round_trips_through_disk(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    store.patch(
        {
            "data_root": "/srv/charts",
            "ocharts": {"cell_budget_bytes": 1234, "s52_path": None},
            "signalk": {"host": "signalk.local", "port": 3443, "tls": True},
            "credentials": {"ocharts": {"user": "sailor@example.com", "password": PASSWORD}},
        }
    )
    # a second store over the same file — i.e. a server restart
    reopened = ConfigStore(store.path)
    assert reopened.get() == store.get()
    config = reopened.get()
    assert config.data_root == Path("/srv/charts")
    assert config.ocharts.cell_budget_bytes == 1234
    assert config.signalk.ws_url == "wss://signalk.local:3443/signalk/v1/stream?subscribe=none"
    assert config.credentials.ocharts.password.get_secret_value() == PASSWORD


def test_chart_detail_serving_knobs_round_trip(tmp_path: Path) -> None:
    """The chart-detail serving fields persist and reload verbatim."""
    store = store_at(tmp_path)
    store.patch(
        {
            "ocharts": {
                "over_zoom": 6,
                "under_zoom": 5,
                "detail_gap": 2,
                "max_cells_per_tile": 64,
                "chart_detail": 1.5,
            }
        }
    )
    reopened = ConfigStore(store.path).get().ocharts
    assert reopened.over_zoom == 6
    assert reopened.under_zoom == 5
    assert reopened.detail_gap == 2
    assert reopened.max_cells_per_tile == 64
    assert reopened.chart_detail == 1.5


def test_poi_ingest_knobs_round_trip(tmp_path: Path) -> None:
    """The POI ingest tunables (Overpass URL, zoom range) persist and reload
    verbatim — the round trip a config UI performs."""
    store = store_at(tmp_path)
    store.patch(
        {
            "poi": {
                "overpass_url": "https://overpass.example/api",
                "min_zoom": 4,
                "max_zoom": 12,
            }
        }
    )
    poi = ConfigStore(store.path).get().poi
    assert poi.overpass_url == "https://overpass.example/api"
    assert poi.min_zoom == 4
    assert poi.max_zoom == 12


def test_regions_round_trip(tmp_path: Path) -> None:
    """The boat-wide named regions (top-level `Config.regions`) persist and
    reload verbatim — shared by the POI and satellite bake pickers, unlike
    the ingest tunables above which stay under `poi`."""
    store = store_at(tmp_path)
    store.patch(
        {
            "regions": [
                {
                    "id": "kattegat",
                    "name": "Kattegat",
                    "min_lon": 10.0,
                    "min_lat": 55.0,
                    "max_lon": 12.5,
                    "max_lat": 57.5,
                }
            ]
        }
    )
    regions = ConfigStore(store.path).get().regions
    assert len(regions) == 1
    assert regions[0].id == "kattegat"
    assert regions[0].name == "Kattegat"
    assert regions[0].bbox == (10.0, 55.0, 12.5, 57.5)


def test_region_multi_bbox_round_trip(tmp_path: Path) -> None:
    """kolmnrsk: a region is a LIST of boxes now, not exactly one. `bboxes`
    persists and reloads verbatim, and `.bbox` is the box ENCLOSING every
    entry (the single rectangle POI/satellite still bake, unchanged)."""
    store = store_at(tmp_path)
    store.patch(
        {
            "regions": [
                {
                    "id": "archipelago",
                    "name": "Archipelago",
                    "bboxes": [
                        {"min_lon": 10.0, "min_lat": 55.0, "max_lon": 11.0, "max_lat": 56.0},
                        {"min_lon": 12.0, "min_lat": 57.0, "max_lon": 13.0, "max_lat": 58.0},
                    ],
                }
            ]
        }
    )
    region = ConfigStore(store.path).get().regions[0]
    assert len(region.bboxes) == 2
    assert region.bboxes[0].as_tuple() == (10.0, 55.0, 11.0, 56.0)
    assert region.bboxes[1].as_tuple() == (12.0, 57.0, 13.0, 58.0)
    # The enclosing box: the min of the mins, the max of the maxes.
    assert region.bbox == (10.0, 55.0, 13.0, 58.0)


def test_region_flat_fields_normalise_into_bboxes(tmp_path: Path) -> None:
    """The pre-kolmnrsk single-box shape (flat min_lon/…) is still accepted
    on the wire — an old `config.json`, or a client that has not been
    updated — and normalises into a one-entry `bboxes` in memory, with no
    `migrate.py` step: `Region._country_xor_bbox` does it on every load."""
    from mivnav.config.model import Region

    region = Region(id="x", min_lon=1.0, min_lat=2.0, max_lon=3.0, max_lat=4.0)
    assert len(region.bboxes) == 1
    assert region.bboxes[0].as_tuple() == (1.0, 2.0, 3.0, 4.0)
    assert region.bbox == (1.0, 2.0, 3.0, 4.0)


@pytest.mark.parametrize(
    "region_kwargs",
    [
        {"country": "DK"},
        {"min_lon": 1.0, "min_lat": 2.0, "max_lon": 3.0, "max_lat": 4.0},
        {
            "bboxes": [
                {"min_lon": 1.0, "min_lat": 2.0, "max_lon": 3.0, "max_lat": 4.0},
                {"min_lon": 5.0, "min_lat": 6.0, "max_lon": 7.0, "max_lat": 8.0},
            ]
        },
    ],
)
def test_region_full_dump_round_trips_for_every_variant(region_kwargs: dict) -> None:
    """The regression `_country_xor_bbox`'s docstring calls out: a region
    dumped in full (`model_dump`, which `ConfigStore.patch` deep-merges back
    through validation on EVERY PATCH — see `store.py`) must re-validate to
    an equal region, for all three variants. The old `model_fields_set`-gated
    version broke this for a country region (every field looks "set" once
    it has round-tripped through a full dump) — this is the case that would
    have caught it."""
    from mivnav.config.model import Region

    region = Region(id="x", **region_kwargs)
    dumped = region.model_dump(mode="json")
    reloaded = Region.model_validate(dumped)
    assert reloaded == region


def test_config_patch_survives_an_existing_country_region(tmp_path: Path) -> None:
    """The store-facing shape of the same bug: `ConfigStore.patch` deep-merges
    the CURRENT config (which includes every stored region, in full) with the
    patch and re-validates the whole thing — on every PATCH, not only one
    that touches `regions`. A boat with a country region configured must be
    able to patch anything else without that region's own round-trip
    tripping validation."""
    store = store_at(tmp_path)
    store.patch({"regions": [{"id": "denmark", "name": "Denmark", "country": "DK"}]})
    # An unrelated patch — data_root — still round-trips the stored country
    # region through `to_storage()` + `model_validate` underneath.
    store.patch({"data_root": str(tmp_path / "data2")})
    region = ConfigStore(store.path).get().regions[0]
    assert region.iso == "DK"


def test_poi_config_defaults_are_the_ingest_module_defaults(tmp_path: Path) -> None:
    """A config written before the ingest fields existed loads fine — they
    default in from the single source of truth in mivnav.features.poi.config."""
    from mivnav.features.poi.config import (
        DEFAULT_OVERPASS_URL,
        DEFAULT_POI_MAX_ZOOM,
        DEFAULT_POI_MIN_ZOOM,
        PoiConfig,
    )

    poi = PoiConfig()
    assert poi.overpass_url == DEFAULT_OVERPASS_URL
    assert poi.min_zoom == DEFAULT_POI_MIN_ZOOM == 6
    assert poi.max_zoom == DEFAULT_POI_MAX_ZOOM == 14


def test_config_regions_default_is_solent() -> None:
    """The top-level `Config.regions` default — a single built-in Solent
    entry, so a bare `POST /ingest/poi` still bakes something sensible."""
    from mivnav.config.model import Config

    regions = Config().regions
    assert len(regions) == 1
    assert regions[0].name == "Solent"
    assert regions[0].bbox == (-1.65, 50.68, -1.05, 50.82)


def test_poi_config_rejects_unknown_key(tmp_path: Path) -> None:
    """extra="forbid" must not be relaxed by the region model move."""
    from pydantic import ValidationError

    from mivnav.config.model import Region
    from mivnav.features.poi.config import PoiConfig

    with pytest.raises(ValidationError):
        PoiConfig(bogus=1)  # type: ignore[call-arg]
    with pytest.raises(ValidationError):
        Region(id="x", bogus=1)  # type: ignore[call-arg]


def test_poi_config_rejects_bad_zoom(tmp_path: Path) -> None:
    """min_zoom must not exceed max_zoom."""
    from pydantic import ValidationError

    from mivnav.features.poi.config import PoiConfig

    with pytest.raises(ValidationError):
        PoiConfig(min_zoom=14, max_zoom=6)


def test_config_rejects_degenerate_or_empty_regions(tmp_path: Path) -> None:
    """A degenerate region is rejected (min < max), and the top-level list
    must stay non-empty — same rule as before the move, just at the new
    location."""
    from pydantic import ValidationError

    from mivnav.config.model import Config, Region

    with pytest.raises(ValidationError):
        Region(id="x", min_lon=1.0, min_lat=0.0, max_lon=-1.0, max_lat=1.0)
    with pytest.raises(ValidationError):
        Config(regions=[])  # non-empty required


def test_a_config_lacking_the_serving_knobs_loads_with_defaults(tmp_path: Path) -> None:
    """An existing config.json written before these fields existed loads
    fine — they default in, no migration needed."""
    from mivnav.features.ocharts.service import (
        DEFAULT_DETAIL_GAP,
        DEFAULT_MAX_CELLS_PER_TILE,
        DEFAULT_OVER_ZOOM,
        DEFAULT_UNDER_ZOOM,
    )

    store = store_at(tmp_path)
    raw = json.loads(store.path.read_text())
    for key in ("over_zoom", "under_zoom", "detail_gap", "max_cells_per_tile"):
        raw["ocharts"].pop(key, None)
    store.path.write_text(json.dumps(raw))

    oc = ConfigStore(store.path).get().ocharts
    assert oc.over_zoom == DEFAULT_OVER_ZOOM == 8
    assert oc.under_zoom == DEFAULT_UNDER_ZOOM == 2
    assert oc.detail_gap == DEFAULT_DETAIL_GAP == 1
    assert oc.max_cells_per_tile == DEFAULT_MAX_CELLS_PER_TILE == 128


def test_a_config_with_retired_finest_fill_keys_migrates_cleanly(tmp_path: Path) -> None:
    """A config.json written before the finest-fill knobs were retired must
    still load: the model is extra="forbid", so the migration drops the stale
    keys before validation (mivnav.config.migrate.DROPS)."""
    store = store_at(tmp_path)
    raw = json.loads(store.path.read_text())
    # simulate a genuinely-old config: no new-vocabulary knobs, the retired
    # finest-fill keys present, and the old serving_headroom that renames to
    # over_zoom.
    for key in ("over_zoom", "under_zoom", "detail_gap"):
        raw["ocharts"].pop(key, None)
    raw["ocharts"].update(
        {
            "finest_fill": True,
            "finest_fill_min_zoom": 10,
            "finest_fill_max_cells": 2,
            "finest_fill_reach": 8,
            "serving_headroom": 5,
        }
    )
    store.path.write_text(json.dumps(raw))

    oc = ConfigStore(store.path).get().ocharts
    # the retired keys are gone (not attributes); the old serving_headroom
    # migrates to over_zoom (RENAMES); the new knobs default in
    assert oc.over_zoom == 5
    assert oc.under_zoom == 2
    assert oc.detail_gap == 1
    assert not hasattr(oc, "finest_fill")
    assert not hasattr(oc, "serving_headroom")


def test_a_failed_patch_leaves_config_and_files_untouched(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    before, before_bytes = store.get(), store.path.read_bytes()
    before_creds = store.credentials_path.read_bytes()
    with pytest.raises(ConfigError):
        store.patch({"signalk": {"port": 70000}})
    assert store.get() == before
    assert store.path.read_bytes() == before_bytes
    assert store.credentials_path.read_bytes() == before_creds


def test_unknown_keys_are_rejected_not_ignored(tmp_path: Path) -> None:
    # a hand-edited typo that silently does nothing is a config file's
    # worst failure mode — but that's about a live PATCH request, which gets
    # immediate feedback; see test_a_stale_key_on_disk_does_not_crash_the_boot
    # for why *loading* an old file on disk is a different call.
    store = store_at(tmp_path)
    with pytest.raises(ConfigError):
        store.patch({"signalk": {"hsot": "typo"}})
    with pytest.raises(ConfigError):
        store.patch({"nonsense": {}})


def test_a_stale_key_on_disk_does_not_crash_the_boot(tmp_path: Path) -> None:
    """rlnkntlm: a config.json with a field renamed/removed since it was
    written must not brick the boat's always-on server — it loads with
    defaults for the dropped section, not a hard crash."""
    store = store_at(tmp_path)
    raw = json.loads(store.path.read_text())
    raw["ocharts"]["cell_budget_bytes_typo_or_retired"] = 12345
    raw["nonsense_top_level_section"] = {"whatever": True}
    store.path.write_text(json.dumps(raw))

    reloaded = ConfigStore(store.path).get()
    assert reloaded == store.get()


def test_a_stale_key_next_to_a_real_error_still_fails(tmp_path: Path) -> None:
    """Dropping unknown keys must not paper over a genuinely bad value
    alongside one."""
    store = store_at(tmp_path)
    raw = json.loads(store.path.read_text())
    raw["ocharts"]["this_key_does_not_exist"] = True
    raw["signalk"]["port"] = 70000  # out of range
    store.path.write_text(json.dumps(raw))

    with pytest.raises(ConfigError):
        ConfigStore(store.path)


def test_a_corrupt_config_file_is_an_error_not_a_silent_default(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    path.write_text("{not json")
    with pytest.raises(ConfigError):
        ConfigStore(path)
    path.write_text(json.dumps({"signalk": {"port": -1}}))
    with pytest.raises(ConfigError):
        ConfigStore(path)


def test_reload_picks_up_a_hand_edited_file(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    raw = json.loads(store.path.read_text())
    raw["signalk"]["host"] = "edited-by-hand"
    store.path.write_text(json.dumps(raw))
    assert store.get().signalk.host == "localhost"  # not seen until reload
    assert store.reload().signalk.host == "edited-by-hand"


# -- merge patch -----------------------------------------------------------


def test_deep_merge_merges_objects_and_replaces_scalars() -> None:
    base = {"a": {"x": 1, "y": 2}, "b": 3}
    assert deep_merge(base, {"a": {"y": 9}, "b": 4}) == {"a": {"x": 1, "y": 9}, "b": 4}
    assert base == {"a": {"x": 1, "y": 2}, "b": 3}  # not mutated


def test_patch_leaves_omitted_fields_alone(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    store.patch({"signalk": {"host": "sk", "port": 4000}})
    store.patch({"signalk": {"host": "other"}})
    config = store.get()
    assert (config.signalk.host, config.signalk.port) == ("other", 4000)


def test_null_s52_path_is_a_real_setting_not_unchanged(tmp_path: Path) -> None:
    # the "null means leave alone" rule is scoped to the secret leaves
    # alone, precisely so this field keeps its meaning ("auto-detect")
    store = store_at(tmp_path)
    store.patch({"ocharts": {"s52_path": "/data/s52"}})
    assert store.get().ocharts.s52_path == Path("/data/s52")
    store.patch({"ocharts": {"s52_path": None}})
    assert store.get().ocharts.s52_path is None


# -- secrets ---------------------------------------------------------------


def test_patch_without_password_keeps_the_stored_one(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    store.patch({"credentials": {"ocharts": {"user": "sailor", "password": PASSWORD}}})
    store.patch({"credentials": {"ocharts": {"user": "renamed"}}})
    creds = store.get().credentials.ocharts
    assert creds.user == "renamed"
    assert creds.password.get_secret_value() == PASSWORD


def test_a_redacted_config_patches_back_without_wiping_the_password(tmp_path: Path) -> None:
    # the round trip a config UI actually performs: GET, edit, PATCH back
    store = store_at(tmp_path)
    store.patch({"credentials": {"ocharts": {"user": "sailor", "password": PASSWORD}}})
    document = redacted(store.get())
    document["signalk"]["host"] = "edited"
    store.patch(document)
    assert store.get().signalk.host == "edited"
    assert store.get().credentials.ocharts.password.get_secret_value() == PASSWORD


def test_an_empty_password_clears_it(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    store.patch({"credentials": {"ocharts": {"user": "sailor", "password": PASSWORD}}})
    store.patch({"credentials": {"ocharts": {"password": ""}}})
    assert store.get().credentials.ocharts.password.get_secret_value() == ""


def test_the_password_is_never_revealed_by_accident(tmp_path: Path) -> None:
    """Every serialisation *except* the explicit persistence path must
    mask it. This is the property that makes leaking it an opt-in
    mistake rather than an omission."""
    store = store_at(tmp_path)
    store.patch({"credentials": {"ocharts": {"user": "sailor", "password": PASSWORD}}})
    config = store.get()

    assert PASSWORD not in repr(config)
    assert PASSWORD not in str(config)
    assert PASSWORD not in config.model_dump_json()
    assert PASSWORD not in json.dumps(config.model_dump(mode="json"))
    assert PASSWORD not in json.dumps(redacted(config))
    assert SECRET_MASK not in json.dumps(redacted(config))  # null, not a mask
    assert redacted(config)["credentials"]["ocharts"]["password"] is None
    assert redacted(config)["credentials"]["ocharts"]["user"] == "sailor"  # not secret

    # ...and the two paths that must reveal it, do
    assert PASSWORD in json.dumps(config.to_storage())
    assert PASSWORD in store.credentials_path.read_text()


# -- the SignalK token: the same rules, because they are a table now -------
#
# These are not duplicates of the password tests above. The password's
# rules used to be hardcoded to its own path; a second secret is exactly
# the thing that would have broken silently, in both directions — leaked by
# a redaction that did not know about it, or wiped by a PATCH rule that did
# not either. So each rule is asserted again for the field that proves it
# generalised.


def test_the_signalk_token_is_never_revealed_by_accident(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    store.patch({"credentials": {"signalk": {"token": TOKEN}}})
    config = store.get()

    assert TOKEN not in repr(config)
    assert TOKEN not in str(config)
    assert TOKEN not in config.model_dump_json()
    assert TOKEN not in json.dumps(config.model_dump(mode="json"))
    assert TOKEN not in json.dumps(redacted(config))
    assert redacted(config)["credentials"]["signalk"]["token"] is None

    assert TOKEN in json.dumps(config.to_storage())
    assert TOKEN in store.credentials_path.read_text()


def test_the_signalk_token_never_touches_config_json(tmp_path: Path) -> None:
    # The one rule the whole two-file split exists for: config.json stays
    # safe to copy, back up, or paste into an issue.
    store = store_at(tmp_path)
    store.patch({"credentials": {"signalk": {"token": TOKEN}}})
    body = store.path.read_text()
    assert TOKEN not in body
    assert "credentials" not in body


def test_a_redacted_config_patches_back_without_wiping_the_token(tmp_path: Path) -> None:
    # The GET/edit/PATCH round trip a config UI performs. Before the secret
    # table this would have sent `token: null` and silently erased it.
    store = store_at(tmp_path)
    store.patch({"credentials": {"signalk": {"token": TOKEN}}})
    document = redacted(store.get())
    document["signalk"]["host"] = "edited"
    store.patch(document)
    assert store.get().signalk.host == "edited"
    assert store.get().credentials.signalk.token.get_secret_value() == TOKEN


def test_both_secrets_survive_one_round_trip(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    store.patch(
        {
            "credentials": {
                "ocharts": {"user": "sailor", "password": PASSWORD},
                "signalk": {"token": TOKEN},
            }
        }
    )
    store.patch(redacted(store.get()))
    creds = store.get().credentials
    assert creds.ocharts.password.get_secret_value() == PASSWORD
    assert creds.signalk.token.get_secret_value() == TOKEN


def test_an_empty_token_clears_it(tmp_path: Path) -> None:
    # "" is a real value meaning "no token" — the off-switch for commanding
    # the autopilot — and must not be confused with null's "leave alone".
    store = store_at(tmp_path)
    store.patch({"credentials": {"signalk": {"token": TOKEN}}})
    store.patch({"credentials": {"signalk": {"token": ""}}})
    assert store.get().credentials.signalk.token.get_secret_value() == ""


# -- migration off the env-var world --------------------------------------


def test_legacy_credentials_are_imported_once_at_first_start(tmp_path: Path) -> None:
    # removing env-var config must not log an existing deployment out of
    # the shop: the hand-placed ocharts.env is read once, into the config
    calls = []

    def legacy():
        calls.append(1)
        return Credentials(user="old@example.com", password=PASSWORD)

    store = store_at(tmp_path, legacy_credentials=legacy)
    assert store.get().credentials.ocharts.user == "old@example.com"
    assert store.get().credentials.ocharts.password.get_secret_value() == PASSWORD
    assert calls == [1]

    # a config now exists, so it is the source of truth and the legacy
    # file is never consulted again
    reopened = ConfigStore(store.path, legacy_credentials=legacy)
    assert reopened.get().credentials.ocharts.user == "old@example.com"
    assert calls == [1]


def test_no_legacy_file_seeds_empty_credentials(tmp_path: Path) -> None:
    store = store_at(tmp_path, legacy_credentials=lambda: None)
    assert store.get().credentials.ocharts.user == ""
    # a fresh config: defaults, plus the one seeded notices dataset
    assert store.get() == Config(datasets=first_start_datasets())


# -- M-DATA-3: data_root + Config.datasets ----------------------------------


def test_datasets_empty_by_default() -> None:
    assert Config().datasets == ()


def test_a_dataset_referencing_its_regions_id_is_valid() -> None:
    config = Config.model_validate(
        {
            "regions": [
                {"id": "solent", "name": "Solent"},
                {"id": "denmark", "name": "Denmark", "country": "DK"},
            ],
            "datasets": [
                {"id": "solent-poi", "provider": "poi", "name": "Solent POI", "region_id": "solent"},
                {"id": "dk-sat", "provider": "satellite", "name": "Denmark", "region_id": "denmark"},
            ],
        }
    )
    assert [d.id for d in config.datasets] == ["solent-poi", "dk-sat"]
    assert config.datasets[0].schedule == "manual"  # default
    assert config.datasets[0].params == {}


def test_a_dataset_with_no_region_is_valid() -> None:
    # e.g. an o-charts install, or a hand-imported chart — not region-shaped.
    config = Config.model_validate(
        {"datasets": [{"id": "US5OAKIQ", "provider": "charts", "name": "Oakland"}]}
    )
    assert config.datasets[0].region_id is None


def test_duplicate_dataset_ids_are_rejected() -> None:
    with pytest.raises(ValueError, match="unique"):
        Config.model_validate(
            {
                "datasets": [
                    {"id": "x", "provider": "poi", "name": "A"},
                    {"id": "x", "provider": "satellite", "name": "B"},
                ]
            }
        )


def test_a_dataset_referencing_an_unknown_region_is_rejected() -> None:
    with pytest.raises(ValueError, match="unknown region"):
        Config.model_validate(
            {"datasets": [{"id": "x", "provider": "poi", "name": "A", "region_id": "Nowhere"}]}
        )


def test_duplicate_region_ids_are_rejected() -> None:
    # Unlike names (see the test below), `id` is the ONE thing a dataset's
    # `region_id` can mean, so a collision here is a blanket boat-wide rule,
    # not a "only if referenced" carve-out.
    with pytest.raises(ValueError, match="region ids must be unique"):
        Config.model_validate(
            {"regions": [{"id": "dup", "name": "A"}, {"id": "dup", "name": "B", "min_lon": -1.5}]}
        )


def test_two_identically_named_regions_with_different_ids_are_both_referenceable() -> None:
    # The whole point of splitting `id` off `name` (uxzqvqpv): a naming
    # collision is now completely harmless, even when BOTH regions are
    # actively referenced — matching is by id, never by the (possibly
    # duplicated) label a sailor sees.
    config = Config.model_validate(
        {
            "regions": [
                {"id": "dup-1", "name": "Dup"},
                {"id": "dup-2", "name": "Dup", "min_lon": -1.5},
            ],
            "datasets": [
                {"id": "a", "provider": "poi", "name": "A", "region_id": "dup-1"},
                {"id": "b", "provider": "satellite", "name": "B", "region_id": "dup-2"},
            ],
        }
    )
    assert len(config.regions) == 2
    assert config.datasets[0].region_id == "dup-1"
    assert config.datasets[1].region_id == "dup-2"


def test_an_unknown_dataset_id_shape_is_rejected() -> None:
    with pytest.raises(ValueError, match="invalid dataset id"):
        Config.model_validate({"datasets": [{"id": "../escape", "provider": "poi", "name": "A"}]})


def test_an_unknown_dataset_provider_still_loads() -> None:
    # A plugin's provider: its datasets must survive the plugin being
    # removed (inert), not stop the config loading.
    config = Config.model_validate({"datasets": [{"id": "x", "provider": "gone_plugin", "name": "A"}]})
    assert config.datasets[0].provider == "gone_plugin"


def test_a_dataset_provider_must_be_a_safe_path_component() -> None:
    with pytest.raises(ValueError):
        Config.model_validate({"datasets": [{"id": "x", "provider": "../etc", "name": "A"}]})


def test_data_root_defaults_and_round_trips(tmp_path: Path) -> None:
    store = store_at(tmp_path)
    custom = tmp_path / "boat-data"
    store.patch({"data_root": str(custom)})
    reopened = ConfigStore(store.path).get()
    assert reopened.data_root == custom
