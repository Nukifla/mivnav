# SPDX-License-Identifier: GPL-2.0-only
"""M-DATA-2 load-time vocabulary migration.

The config field names were normalised across providers (consistent
``*_budget_bytes`` / ``rescan_interval_s`` / ``prefetch`` / ``upstream_*_url``).
An existing ``config.json`` on a boat holds the OLD names; the model is
``extra="forbid"``, so without a migration every such file would fail to load.
These tests pin the migration: an old file loads with the right values, the
mapping is idempotent and non-destructive, and — the negative control — removing
the migration makes the old file fail.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from mivnav.config import ConfigError, ConfigStore
from mivnav.config.migrate import migrate

# A complete o-charts + weather block in the OLD vocabulary, as a boat set up
# before M-DATA-2 has it on disk.
OLD_OCHARTS = {
    "cell_budget": 111,
    "tile_budget": 222,
    "rescan_interval": 7.5,
    "warm_overview": False,
}
OLD_WEATHER = {
    "cache_budget": 333,
    "tiles_url": "https://tiles.example",
    "forecast_url": "https://forecast.example",
}


def write_config(tmp_path: Path, body: dict) -> Path:
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"version": 1, **body}))
    return path


# -- the pure mapping ------------------------------------------------------


def test_migrate_renames_every_old_key() -> None:
    out = migrate({"ocharts": dict(OLD_OCHARTS), "weather": dict(OLD_WEATHER)})
    assert out["ocharts"] == {
        "cell_budget_bytes": 111,
        "tile_budget_bytes": 222,
        "rescan_interval_s": 7.5,
        "prefetch": False,
    }
    # Weather is a plugin now: its old section moves, untouched, to its
    # plugin block (the plugin renames its own keys — see its tests).
    assert "weather" not in out
    assert out["plugins"]["weather"] == OLD_WEATHER


def test_migrate_keeps_an_existing_plugin_block_over_the_old_section() -> None:
    out = migrate({"weather": {"a": 1}, "plugins": {"weather": {"b": 2}}})
    assert "weather" not in out
    assert out["plugins"] == {"weather": {"b": 2}}


def test_migrate_moves_an_enabled_beta_routing_section_to_its_plugin() -> None:
    """Autorouting is a plugin now: the old top-level ``routing`` section
    moves to ``plugins.autorouting``; its ``beta_enabled`` switch is dropped,
    and ``true`` means the plugin stays on."""
    out = migrate({"routing": {"beta_enabled": True, "default_draft_m": 1.6}})
    assert "routing" not in out
    assert out["plugins"]["autorouting"] == {"default_draft_m": 1.6}
    assert "autorouting" not in out.get("plugins_disabled", ())


@pytest.mark.parametrize("section", [{}, {"beta_enabled": False}, {"beta_enabled": "yes"}])
def test_migrate_switches_autorouting_off_unless_the_beta_was_on(section) -> None:
    """The beta switch was off by default: moving it must not turn the
    auto-router on for a boat that never had it."""
    out = migrate({"routing": {**section, "algorithm": "graph"}})
    assert "routing" not in out
    assert out["plugins"]["autorouting"] == {"algorithm": "graph"}
    assert out["plugins_disabled"] == ["autorouting"]


def test_migrate_does_not_list_autorouting_twice_in_plugins_disabled() -> None:
    out = migrate({"routing": {}, "plugins_disabled": ["weather", "autorouting"]})
    assert out["plugins_disabled"] == ["weather", "autorouting"]
    # Idempotent: a second pass (no routing section left) changes nothing.
    assert migrate(out) == out


def test_an_old_routing_section_loads_switched_off(tmp_path: Path) -> None:
    path = write_config(tmp_path, {"routing": {"beta_enabled": False, "mivnav_beam_m": 3.0}})
    config = ConfigStore(path).get()
    assert config.plugins["autorouting"] == {"mivnav_beam_m": 3.0}
    assert config.plugins_disabled == ("autorouting",)


def test_migrate_does_not_mutate_its_argument() -> None:
    src = {"ocharts": dict(OLD_OCHARTS)}
    migrate(src)
    assert src == {"ocharts": dict(OLD_OCHARTS)}  # untouched


def test_migrate_is_idempotent_on_a_new_document() -> None:
    new = {
        "ocharts": {"cell_budget_bytes": 1, "prefetch": True},
        "plugins": {"weather": {"cache_budget_bytes": 2}},
        # every document the current code writes carries the notices slice
        # (without it, migrate_notices_datasets seeds the notices dataset)
        "notices": {"base_url": "https://niord.dma.dk"},
    }
    assert migrate(new) == new
    assert migrate(migrate(new)) == new


def test_migrate_prefers_the_new_key_and_drops_a_stale_old_twin() -> None:
    # A mixed document (both names present) keeps the NEW value and discards the
    # old — so a stray old key can never resurrect a wrong value or trip
    # extra="forbid".
    out = migrate({"ocharts": {"cell_budget": 1, "cell_budget_bytes": 999}})
    assert out["ocharts"] == {"cell_budget_bytes": 999}


def test_migrate_leaves_unknown_sections_alone() -> None:
    out = migrate({"signalk": {"host": "x"}, "version": 1, "notices": {}})
    assert out == {"signalk": {"host": "x"}, "version": 1, "notices": {}}


# -- the poi.regions -> regions relocation ----------------------------------

OLD_REGIONS = [
    {"name": "Kattegat", "min_lon": 10.0, "min_lat": 55.0, "max_lon": 12.5, "max_lat": 57.5}
]


def test_migrate_moves_poi_regions_to_top_level() -> None:
    out = migrate({"poi": {"overpass_url": "https://x", "regions": OLD_REGIONS}})
    # Plus a migrated `id` (region-id migration, uxzqvqpv): derived from the
    # region's name, folded into the end of the same migrate() pass.
    assert out["regions"] == [{**OLD_REGIONS[0], "id": "kattegat"}]
    assert out["poi"] == {"overpass_url": "https://x"}  # the old key is gone


def test_migrate_move_is_idempotent() -> None:
    once = migrate({"poi": {"regions": OLD_REGIONS}})
    assert migrate(once) == once


def test_migrate_move_never_clobbers_an_existing_top_level_regions() -> None:
    # A document that already carries the new top-level key (e.g. a client
    # that PATCHed `regions` and left a stale `poi.regions` beside it) keeps
    # the new value; the stale old-section key is still dropped, or it would
    # trip extra="forbid" on a `poi` that no longer declares `regions`.
    out = migrate({"poi": {"regions": OLD_REGIONS}, "regions": [{"name": "Kept"}]})
    assert out["regions"] == [{"name": "Kept", "id": "kept"}]
    assert "regions" not in out["poi"]


def test_migrate_move_does_not_mutate_its_argument() -> None:
    src = {"poi": {"regions": OLD_REGIONS}}
    migrate(src)
    assert src == {"poi": {"regions": OLD_REGIONS}}


# -- through the store (load + reload + round-trip) -------------------------


def test_an_old_config_file_loads_and_migrates(tmp_path: Path) -> None:
    path = write_config(tmp_path, {"ocharts": dict(OLD_OCHARTS), "weather": dict(OLD_WEATHER)})
    config = ConfigStore(path).get()
    assert config.ocharts.cell_budget_bytes == 111
    assert config.ocharts.tile_budget_bytes == 222
    assert config.ocharts.rescan_interval_s == 7.5
    assert config.ocharts.prefetch is False
    # Kept (opaque) for the weather plugin, installed or not.
    assert config.plugins["weather"] == OLD_WEATHER


def test_an_old_config_file_survives_a_reload(tmp_path: Path) -> None:
    """The hand-edit workflow: an operator's old-vocabulary edits are still
    honoured on POST /config/reload, not just at first load."""
    path = write_config(tmp_path, {"ocharts": {"cell_budget": 111}})
    store = ConfigStore(path)
    # rewrite the file by hand, still in the old vocabulary
    path.write_text(json.dumps({"version": 1, "ocharts": {"cell_budget": 424242}}))
    reloaded = store.reload()
    assert reloaded.ocharts.cell_budget_bytes == 424242


def test_a_partial_old_file_keeps_the_defaults_for_absent_fields(tmp_path: Path) -> None:
    # Only one old key present; the rest fall back to model defaults.
    path = write_config(tmp_path, {"ocharts": {"warm_overview": False}})
    config = ConfigStore(path).get()
    assert config.ocharts.prefetch is False
    assert config.ocharts.cell_budget_bytes > 0  # default, not lost


def test_the_migrated_config_persists_in_the_new_vocabulary(tmp_path: Path) -> None:
    # After loading an old file, any write rewrites it in the new vocabulary,
    # so the old names do not linger on disk.
    path = write_config(tmp_path, {"ocharts": dict(OLD_OCHARTS)})
    store = ConfigStore(path)
    store.patch({"ocharts": {"tile_budget_bytes": 888}})
    on_disk = json.loads(path.read_text())["ocharts"]
    assert "cell_budget" not in on_disk and "cell_budget_bytes" in on_disk
    assert "warm_overview" not in on_disk and "prefetch" in on_disk
    assert on_disk["tile_budget_bytes"] == 888


def test_without_the_migration_an_old_file_loses_the_old_values(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The negative control: prove the migration is what preserves an old
    file's values, not merely what keeps it loading. rlnkntlm made a stale
    key tolerant at load time — it no longer crashes even with the
    migration neutralised — but without the migration the old values are
    still lost to defaults, not carried forward."""
    monkeypatch.setattr("mivnav.config.store.migrate", lambda raw: dict(raw))
    path = write_config(tmp_path, {"ocharts": dict(OLD_OCHARTS)})
    config = ConfigStore(path).get()
    assert config.ocharts.cell_budget_bytes != OLD_OCHARTS["cell_budget"]
    assert config.ocharts.tile_budget_bytes != OLD_OCHARTS["tile_budget"]


# -- poi.regions -> regions, through the store -------------------------------


def test_an_old_config_with_poi_regions_loads_them_at_the_new_top_level(
    tmp_path: Path,
) -> None:
    """The regression this migration exists for: a boat's saved regions must
    survive the upgrade, not silently reset to the built-in Solent default."""
    path = write_config(
        tmp_path,
        {"poi": {"overpass_url": "https://x", "regions": OLD_REGIONS}},
    )
    config = ConfigStore(path).get()
    assert config.poi.overpass_url == "https://x"
    assert len(config.regions) == 1
    assert config.regions[0].name == "Kattegat"
    assert config.regions[0].bbox == (10.0, 55.0, 12.5, 57.5)


def test_the_migrated_regions_persist_at_the_new_top_level(tmp_path: Path) -> None:
    path = write_config(tmp_path, {"poi": {"regions": OLD_REGIONS}})
    store = ConfigStore(path)
    store.patch({"poi": {"overpass_url": "https://y"}})  # any write rewrites the file
    on_disk = json.loads(path.read_text())
    assert "regions" not in on_disk["poi"]
    # Round-tripped through the validated model, which also serialises the
    # (here, absent) `country` field — assert on the fields that came in.
    assert len(on_disk["regions"]) == 1
    assert on_disk["regions"][0]["name"] == "Kattegat"
    assert (
        on_disk["regions"][0]["min_lon"],
        on_disk["regions"][0]["min_lat"],
        on_disk["regions"][0]["max_lon"],
        on_disk["regions"][0]["max_lat"],
    ) == (10.0, 55.0, 12.5, 57.5)


def test_without_the_migration_an_old_poi_regions_file_loses_the_regions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same negative control as above, for the relocation: without the move,
    `poi.regions` trips `extra="forbid"` (`poi` no longer declares that
    field) — rlnkntlm's tolerant load drops the whole stale key rather than
    refuse to start, landing on the built-in default region instead of a
    boat's actual saved ones. Exactly the silent loss the move exists to
    prevent (see this module's docstring) — the migration, not a crash, is
    what protects it."""
    monkeypatch.setattr("mivnav.config.store.migrate", lambda raw: dict(raw))
    path = write_config(tmp_path, {"poi": {"regions": OLD_REGIONS}})
    config = ConfigStore(path).get()
    assert [r.name for r in config.regions] != ["Kattegat"]


# -- M-DATA-3: charts.dir -> data_root, poi.dir/satellite.dir/ocharts.sets_dir
# dropped outright ------------------------------------------------------------


def test_migrate_moves_charts_dir_to_data_root() -> None:
    out = migrate({"charts": {"dir": "/srv/mivnav-data"}})
    assert out["data_root"] == "/srv/mivnav-data"
    assert "charts" not in out  # the whole retired section is gone, not just `dir`


def test_migrate_charts_dir_move_never_clobbers_an_existing_data_root() -> None:
    out = migrate({"charts": {"dir": "/old"}, "data_root": "/already-set"})
    assert out["data_root"] == "/already-set"
    assert "charts" not in out


def test_migrate_drops_the_other_three_legacy_dirs() -> None:
    out = migrate(
        {
            "poi": {"dir": "/old/poi", "overpass_url": "https://x"},
            "satellite": {"dir": "/old/sat", "min_zoom": 2},
            "ocharts": {"sets_dir": "/old/oc", "cell_budget_bytes": 5},
        }
    )
    assert out["poi"] == {"overpass_url": "https://x"}
    assert out["satellite"] == {"min_zoom": 2}
    assert out["ocharts"] == {"cell_budget_bytes": 5}


def test_migrate_data_root_move_is_idempotent() -> None:
    once = migrate({"charts": {"dir": "/srv/mivnav-data"}})
    assert migrate(once) == once


def test_an_old_config_file_with_all_four_legacy_dirs_loads(tmp_path: Path) -> None:
    path = write_config(
        tmp_path,
        {
            "charts": {"dir": str(tmp_path / "old-root")},
            "poi": {"dir": str(tmp_path / "old-poi")},
            "satellite": {"dir": str(tmp_path / "old-sat")},
            "ocharts": {"sets_dir": str(tmp_path / "old-oc")},
        },
    )
    config = ConfigStore(path).get()
    assert config.data_root == tmp_path / "old-root"


def test_without_the_migration_an_old_charts_dir_file_loses_the_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("mivnav.config.store.migrate", lambda raw: dict(raw))
    path = write_config(tmp_path, {"charts": {"dir": str(tmp_path)}})
    config = ConfigStore(path).get()
    assert config.data_root != tmp_path


# -- region-id migration (Region.id split off Region.name, uxzqvqpv) --------
#
# Regions used to be referenced by NAME (`DatasetConfig.region_id ->
# Region.name`); a settings UI that lets a sailor rename a region would then
# silently orphan every dataset pointing at the old name, so `Region` got a
# stable, separate `id` and `region_id` was repointed at it. An existing
# config.json predating this has neither: no region carries an `id`, and a
# dataset's `region_id` is still the region's NAME. `migrate_region_ids`
# (folded into `migrate()`) mints one id per region from its current name
# and rewrites every matching `region_id` in lockstep.


def test_migrate_region_ids_mints_an_id_from_the_name() -> None:
    out = migrate({"regions": [{"name": "Solent"}]})
    assert out["regions"] == [{"name": "Solent", "id": "solent"}]


def test_migrate_region_ids_repoints_a_dataset_region_id_from_name_to_id() -> None:
    out = migrate(
        {
            "regions": [{"name": "Denmark", "country": "DK"}],
            "datasets": [{"id": "dk-poi", "provider": "poi", "name": "DK", "region_id": "Denmark"}],
        }
    )
    assert out["regions"] == [{"name": "Denmark", "country": "DK", "id": "denmark"}]
    assert out["datasets"][0]["region_id"] == "denmark"


def test_migrate_region_ids_leaves_a_dataset_with_no_region_alone() -> None:
    out = migrate({"datasets": [{"id": "x", "provider": "charts", "name": "A"}]})
    assert "region_id" not in out["datasets"][0]


def test_migrate_region_ids_is_idempotent() -> None:
    once = migrate({"regions": [{"name": "Kattegat"}]})
    assert migrate(once) == once


def test_migrate_region_ids_untouched_when_ids_already_present() -> None:
    # An already-migrated document (or one an operator hand-edited into the
    # new vocabulary) is left exactly alone — no re-derivation, no rewrite.
    doc = {
        "regions": [{"name": "Renamed Later", "id": "kattegat"}],
        "datasets": [{"id": "x", "provider": "poi", "name": "A", "region_id": "kattegat"}],
        "notices": {},
    }
    assert migrate(doc) == doc


def test_migrate_region_ids_first_wins_on_a_duplicate_name() -> None:
    # Two regions sharing a name: only the first's derived id is a rewrite
    # target for a dataset's (old-vocabulary) region_id. No valid config.json
    # can actually have a dataset referencing a duplicated name (the old
    # by-name cross-check refused to validate one), so this is an arbitrary,
    # inconsequential tie-break, not a real-world ambiguity.
    out = migrate(
        {
            "regions": [{"name": "Dup"}, {"name": "Dup", "min_lon": -2.0}],
            "datasets": [{"id": "x", "provider": "poi", "name": "A", "region_id": "Dup"}],
        }
    )
    ids = [r["id"] for r in out["regions"]]
    assert ids == ["dup", "dup-2"]
    assert out["datasets"][0]["region_id"] == "dup"


def test_an_old_config_with_name_only_regions_loads_and_gets_stable_ids(
    tmp_path: Path,
) -> None:
    """The regression this migration exists for: an old config.json survives
    the upgrade with working dataset->region references, not a validation
    error (Region.id is required) or a silently dropped reference."""
    path = write_config(
        tmp_path,
        {
            "regions": [{"name": "Solent"}, {"name": "Denmark", "country": "DK"}],
            "datasets": [
                {"id": "solent-poi", "provider": "poi", "name": "P", "region_id": "Solent"},
                {"id": "dk-sat", "provider": "satellite", "name": "S", "region_id": "Denmark"},
            ],
        },
    )
    config = ConfigStore(path).get()
    by_name = {r.name: r.id for r in config.regions}
    assert by_name == {"Solent": "solent", "Denmark": "denmark"}
    # (a config this old predates notices too, so it also gains the
    # default notices dataset — test_notices_dataset.py)
    datasets = {d.id: d.region_id for d in config.datasets if d.provider != "notices"}
    assert datasets == {"solent-poi": "solent", "dk-sat": "denmark"}


def test_the_migrated_region_id_round_trips_through_a_patch(tmp_path: Path) -> None:
    path = write_config(
        tmp_path,
        {
            "regions": [{"name": "Kattegat", "min_lon": 10.0, "min_lat": 55.0, "max_lon": 12.5, "max_lat": 57.5}],
            "datasets": [{"id": "x", "provider": "poi", "name": "A", "region_id": "Kattegat"}],
        },
    )
    store = ConfigStore(path)
    assert store.get().datasets[0].region_id == "kattegat"
    # A no-op patch still round-trips the whole (now id-bearing) document —
    # the id stays "kattegat" rather than drifting on every write.
    store.patch({"poi": {"overpass_url": "https://y"}})
    reopened = ConfigStore(path).get()
    assert reopened.regions[0].id == "kattegat"
    assert reopened.datasets[0].region_id == "kattegat"


def test_without_the_migration_an_old_name_only_region_id_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("mivnav.config.store.migrate", lambda raw: dict(raw))
    path = write_config(tmp_path, {"regions": [{"name": "Solent"}]})
    with pytest.raises(ConfigError):
        ConfigStore(path)


# -- the retired `osm` feature (unqqplrl) ------------------------------------
#
# The regional Overpass-baked basemap feature was removed outright: its config
# slice AND its provider id are gone from the model. The Pi's own production
# config had a live `osm-basemap-denmark-2026` dataset, so BOTH have to be
# stripped on load or the plotter simply will not boot.


def test_an_old_config_with_an_osm_slice_and_dataset_still_loads(tmp_path: Path) -> None:
    path = write_config(
        tmp_path,
        {
            "osm": {"overpass_url": "https://overpass.example", "max_zoom": 12},
            "regions": [{"id": "dk", "name": "Denmark", "country": "DK"}],
            "datasets": [
                {
                    "id": "osm-basemap-denmark-2026",
                    "provider": "osm",
                    "name": "Denmark basemap",
                    "region_id": "dk",
                },
                {"id": "keep", "provider": "poi", "name": "POI", "region_id": "dk"},
            ],
        },
    )
    config = ConfigStore(path).get()
    assert [d.id for d in config.datasets if d.provider != "notices"] == ["keep"]
    assert not hasattr(config, "osm")


def test_migrate_drops_only_the_retired_providers_datasets() -> None:
    out = migrate(
        {
            "datasets": [
                {"id": "a", "provider": "osm"},
                {"id": "b", "provider": "osm_world"},
            ],
            "notices": {},
        }
    )
    assert out["datasets"] == [{"id": "b", "provider": "osm_world"}]


def test_migrate_leaves_a_config_with_no_datasets_alone() -> None:
    assert "datasets" not in migrate({"version": 1, "notices": {}})


def test_dropping_a_retired_dataset_is_pure_and_idempotent() -> None:
    raw = {"datasets": [{"id": "a", "provider": "osm"}], "notices": {}}
    once = migrate(raw)
    assert migrate(once)["datasets"] == []
    assert raw["datasets"] == [{"id": "a", "provider": "osm"}], "migrate must not mutate its input"


def test_a_patch_naming_the_retired_provider_is_rejected_cleanly(tmp_path: Path) -> None:
    """A client PATCHing a stale blob that still names `osm` must get a clean
    config error, not a 500 — the migration only runs on READ, so validation
    is what catches this one."""
    path = write_config(tmp_path, {})
    store = ConfigStore(path)
    with pytest.raises(ConfigError):
        store.patch({"datasets": [{"id": "a", "provider": "osm", "name": "a"}]})


# -- jt rsmpwtmw: the retired `schedule: "on-demand"` VALUE -------------------
#
# `on-demand` was a third `IngestSchedule` value meaning "never baked at all —
# this names a live, fetch-through cache". It split into `mode="live-cache"` +
# an ordinary schedule. `IngestSchedule` is a closed Literal and the model is
# `extra="forbid"`, so a boat whose config.json still says it would refuse to
# boot — and that config really is out there: the Pi has both a weather proxy
# entry and (jt rtmtmntz) an osm_world live-tile one.
#
# Unlike every other migration in this module the fold lives on the MODEL
# (`mivnav.config.model.fold_legacy_dataset_schedule`), not in `migrate()` —
# see that function's docstring. These tests therefore exercise it through the
# real doors: a file on disk, a PATCH, and a PUT body.

ON_DEMAND_CONFIG = {
    "regions": [{"id": "dk", "name": "Denmark", "country": "DK"}],
    "datasets": [
        {
            "id": "weather-live",
            "provider": "weather",
            "name": "Live weather",
            "schedule": "on-demand",
            "params": {"domains": ["dwd_icon_eu"]},
        },
        {
            "id": "osm-live",
            "provider": "osm_world",
            "name": "Live basemap",
            "schedule": "on-demand",
            "params": {},
        },
        {
            "id": "poi-dk",
            "provider": "poi",
            "name": "POI",
            "region_id": "dk",
            "schedule": "ttl",
            "ttl_s": 3600,
        },
    ],
}


def test_a_boats_config_with_on_demand_datasets_still_loads(tmp_path: Path) -> None:
    """The whole point: an existing config.json is not a boot failure."""
    config = ConfigStore(write_config(tmp_path, ON_DEMAND_CONFIG)).get()
    by_id = {d.id: d for d in config.datasets}
    assert [d.id for d in config.datasets if d.provider != "notices"] == [
        "weather-live", "osm-live", "poi-dk"
    ]
    for live in ("weather-live", "osm-live"):
        assert by_id[live].mode == "live-cache"
        # The schedule falls back to the ordinary default rather than being
        # left as an illegal value or invented as "ttl": the old declaration
        # said nothing about a cadence, so neither does the new one.
        assert by_id[live].schedule == "manual"
        assert by_id[live].ttl_s is None
    # An ordinary bake is untouched by any of this.
    assert by_id["poi-dk"].mode == "bake"
    assert by_id["poi-dk"].schedule == "ttl"
    assert by_id["poi-dk"].ttl_s == 3600


def test_the_on_demand_uniqueness_rule_survived_the_split(tmp_path: Path) -> None:
    """Two live caches for ONE provider still refuse to validate — the check
    moved from `schedule` to `mode` and must not have been lost with it."""
    path = write_config(
        tmp_path,
        {
            "datasets": [
                {"id": "a", "provider": "weather", "name": "a", "schedule": "on-demand"},
                {"id": "b", "provider": "weather", "name": "b", "mode": "live-cache"},
            ]
        },
    )
    with pytest.raises(ConfigError):
        ConfigStore(path).get()


def test_an_old_client_can_still_patch_an_on_demand_dataset(tmp_path: Path) -> None:
    """The reason this fold is on the model and not in `migrate()`: a
    service-worker-cached frontend several versions behind still PATCHes the
    old spelling, and `migrate()` never sees a patch."""
    store = ConfigStore(write_config(tmp_path, {}))
    config = store.patch(
        {
            "datasets": [
                {
                    "id": "wx",
                    "provider": "weather",
                    "name": "Live weather",
                    "schedule": "on-demand",
                }
            ]
        }
    )
    assert config.datasets[0].mode == "live-cache"
    assert config.datasets[0].schedule == "manual"


def test_an_explicit_mode_beats_the_legacy_schedule() -> None:
    """Value precedence, so a half-migrated document keeps whatever is already
    in the new vocabulary — same posture as every rename above."""
    from mivnav.config.model import DatasetConfig

    ds = DatasetConfig.model_validate(
        {
            "id": "wx",
            "provider": "weather",
            "name": "wx",
            "schedule": "on-demand",
            "mode": "bake",
        }
    )
    assert ds.mode == "bake"
    assert ds.schedule == "manual"


def test_folding_the_legacy_schedule_is_pure_and_idempotent() -> None:
    from mivnav.config.model import fold_legacy_dataset_schedule

    raw = {"id": "wx", "provider": "weather", "name": "wx", "schedule": "on-demand"}
    once = fold_legacy_dataset_schedule(raw)
    assert raw["schedule"] == "on-demand", "the fold must not mutate its input"
    assert once == fold_legacy_dataset_schedule(once)
