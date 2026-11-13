# SPDX-License-Identifier: GPL-2.0-only
"""Load-time migration of a config document: field NAMES (:func:`migrate`)
plus two VALUE-level migrations (:func:`migrate_region_ids`,
:func:`migrate_notices_datasets`), all run once on read, before
``Config.model_validate`` (``extra="forbid"``). See
docs/architecture/config-migrate.md for the full rename table and rationale.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from collections.abc import Mapping
from typing import Any

from mivnav.features.notices.config import (
    DEFAULT_DATASET_ID,
    DEFAULT_TTL_S,
    REGION_DK,
    REGION_GL,
    default_notices_dataset,
)

log = logging.getLogger(__name__)

#: ``section -> {old field name: new field name}``. Renames a key only
#: inside its own section object. See docs/architecture/config-migrate.md.
RENAMES: dict[str, dict[str, str]] = {
    "ocharts": {
        "cell_budget": "cell_budget_bytes",
        "tile_budget": "tile_budget_bytes",
        "rescan_interval": "rescan_interval_s",
        "warm_overview": "prefetch",
        "serving_headroom": "over_zoom",
    },
}

#: Top-level sections that became a plugin's settings block: ``section ->
#: plugin id``, moved to ``plugins.<id>`` (when that block is not already
#: set). Done here, not by the plugin, so a config that still has the old
#: section loads — and keeps it — when the plugin is not installed.
PLUGIN_SECTIONS: dict[str, str] = {"weather": "weather", "routing": "autorouting"}

#: ``section -> flag``: an old :data:`PLUGIN_SECTIONS` section whose own
#: on/off flag became the plugin's switch. The flag is dropped from the moved
#: block, and unless it was ``true`` the plugin lands in ``plugins_disabled``
#: — the beta autorouting switch was off by default, and moving it must not
#: turn the auto-router on for a boat that never had it.
PLUGIN_SECTION_SWITCHES: dict[str, str] = {"routing": "beta_enabled"}

#: ``section -> {retired field names}``, stripped before validation
#: (``extra="forbid"``). See docs/architecture/config-migrate.md (M-DATA-3).
DROPS: dict[str, set[str]] = {
    "ocharts": {
        "finest_fill",
        "finest_fill_min_zoom",
        "finest_fill_max_cells",
        "finest_fill_reach",
        "sets_dir",
    },
    "poi": {"dir"},
    "satellite": {"dir"},
}

#: ``(old_section, old_field, new_top_level_field)`` — a field relocated to a
#: new top-level key rather than renamed in place. See
#: docs/architecture/config-migrate.md for why these two specifically.
MOVES: tuple[tuple[str, str, str], ...] = (
    ("poi", "regions", "regions"),
    ("charts", "dir", "data_root"),
)

#: Top-level sections retired OUTRIGHT (the section itself no longer exists,
#: unlike a DROPS field within a section the model still declares). See
#: docs/architecture/config-migrate.md.
RETIRED_SECTIONS: frozenset[str] = frozenset({"charts", "osm"})

#: Provider ids retired outright — a ``datasets`` entry naming one is DROPPED
#: on load; baked bytes are left on disk (logged), not deleted. See
#: docs/architecture/config-migrate.md.
RETIRED_PROVIDERS: frozenset[str] = frozenset({"osm"})


def migrate(raw: Mapping[str, Any]) -> dict[str, Any]:
    """A copy of ``raw`` with old field names mapped to the new vocabulary,
    retired keys dropped, and relocated fields moved to their new top-level
    home. Pure — never mutates ``raw`` or its nested dicts. A rename/move
    only applies when the old key is present and the new one is not already
    set, so re-running is a no-op."""
    out: dict[str, Any] = dict(raw)
    for section, mapping in RENAMES.items():
        block = out.get(section)
        if not isinstance(block, Mapping):
            continue
        migrated = dict(block)
        for old, new in mapping.items():
            if old in migrated and new not in migrated:
                migrated[new] = migrated.pop(old)
            else:
                # already new-vocabulary, or absent — drop a stale old key that
                # would otherwise fail extra="forbid" beside its new twin
                migrated.pop(old, None)
        out[section] = migrated
    for section, retired in DROPS.items():
        block = out.get(section)
        if not isinstance(block, Mapping):
            continue
        dropped = dict(block)
        for key in retired:
            dropped.pop(key, None)
        out[section] = dropped
    for section, old_field, new_top in MOVES:
        block = out.get(section)
        if not isinstance(block, Mapping) or old_field not in block:
            continue
        moved = dict(block)
        value = moved.pop(old_field)
        if new_top not in out:
            # Only relocate when nothing already occupies the new top-level
            # key — a document that already has the new vocabulary (or a
            # patch that set it in the same call) keeps that value; the stale
            # old-section key is still dropped either way, so it cannot trip
            # extra="forbid" beside a section that no longer declares it.
            out[new_top] = value
        out[section] = moved
    for section in RETIRED_SECTIONS:
        out.pop(section, None)
    for section, plugin_id in PLUGIN_SECTIONS.items():
        if section not in out:
            continue
        block = out.pop(section)
        plugins = dict(out.get("plugins") or {})
        if plugin_id not in plugins and isinstance(block, Mapping):
            moved = dict(block)
            switch = PLUGIN_SECTION_SWITCHES.get(section)
            if switch is not None and moved.pop(switch, False) is not True:
                disabled = list(out.get("plugins_disabled") or ())
                if plugin_id not in disabled:
                    disabled.append(plugin_id)
                out["plugins_disabled"] = disabled
            plugins[plugin_id] = moved
        out["plugins"] = plugins
    out = drop_retired_provider_datasets(out)
    out = migrate_notices_datasets(out)
    return migrate_region_ids(out)


def drop_retired_provider_datasets(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Drop every ``datasets`` entry naming a :data:`RETIRED_PROVIDERS`
    provider. Loud, not silent: each drop is logged at WARNING with its id
    and provider, so a sailor can find an explanation for the disappearance.
    A malformed ``datasets`` value is left for ``Config.model_validate``."""
    datasets = raw.get("datasets")
    if not isinstance(datasets, list):
        return dict(raw)
    kept = []
    for entry in datasets:
        if isinstance(entry, Mapping) and entry.get("provider") in RETIRED_PROVIDERS:
            log.warning(
                "dropping dataset %r: provider %r no longer exists; its baked "
                "files (if any) are left on disk under data_root/%s — delete "
                "them by hand to reclaim the space, and re-declare the area as "
                "an osm_world dataset with a region to replace it",
                entry.get("id", "<no id>"),
                entry.get("provider"),
                entry.get("provider"),
            )
            continue
        kept.append(entry)
    out = dict(raw)
    out["datasets"] = kept
    return out


_REGION_ID_FALLBACK = "region"


def _slugify_region_name(name: str) -> str:
    """The same slug rule as ``frontend/src/core/settings/slug.ts`` and
    :data:`mivnav.config.model._SAFE_ID_RE` — kept in lockstep so a migrated
    id is never rejected by ``Region``'s own ``id`` validator."""
    folded = unicodedata.normalize("NFKD", name)
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    slug = re.sub(r"[^a-z0-9._-]+", "-", folded.lower())
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    return slug or _REGION_ID_FALLBACK


def migrate_region_ids(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Give every region lacking an ``id`` a stable one MINTED from its
    ``name``, and repoint any dataset's ``region_id`` that named that
    region. Idempotent; see docs/architecture/config-migrate.md for the
    name-collision tie-break and why this isn't keyed on CONFIG_VERSION."""
    regions = raw.get("regions")
    if not isinstance(regions, list):
        return dict(raw)  # absent/malformed — nothing to migrate; validation will say why

    name_to_id: dict[str, str] = {}
    used_ids: set[str] = {r["id"] for r in regions if isinstance(r, Mapping) and "id" in r}
    migrated_regions: list[Any] = []
    for region in regions:
        if not isinstance(region, Mapping) or "id" in region:
            migrated_regions.append(region)
            continue
        name = region.get("name")
        base = _slugify_region_name(name if isinstance(name, str) else "")
        candidate = base
        n = 2
        while candidate in used_ids:
            candidate = f"{base}-{n}"
            n += 1
        used_ids.add(candidate)
        if isinstance(name, str):
            name_to_id.setdefault(name, candidate)  # first-wins on a name collision
        migrated_regions.append({**region, "id": candidate})

    out = dict(raw)
    out["regions"] = migrated_regions
    datasets = out.get("datasets")
    if isinstance(datasets, list) and name_to_id:
        out["datasets"] = [
            {**d, "region_id": name_to_id[d["region_id"]]}
            if isinstance(d, Mapping) and d.get("region_id") in name_to_id
            else d
            for d in datasets
        ]
    return out


#: The ``notices`` slice's keys from before notices were datasets — WHAT to
#: pull (Greenland or not), WHEN (``refresh_s``) and whether at all
#: (``enabled``) now live on a notices ``DatasetConfig``.
LEGACY_NOTICES_KEYS: tuple[str, ...] = ("enabled", "refresh_s", "include_greenland")


def migrate_notices_datasets(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Turn the retired notices slice keys into the one notices dataset
    they described: regions Denmark (+ Greenland if ``include_greenland``
    was on), ``schedule: "ttl"`` every ``refresh_s``, ``enabled`` carried
    over — unless the document already declares a notices dataset. The
    legacy keys are dropped either way. A document with no notices slice
    at all (written before the feature) gets the default dataset too. Idempotent: once the keys are gone
    (the next write), nothing re-runs — so a sailor who deletes the dataset
    keeps it deleted. A brand-new config gets the same dataset from
    :func:`mivnav.config.model.first_start_datasets` instead."""
    block = raw.get("notices")
    if block is None:
        # A config written before notices existed at all: it gets them the
        # way a first start does. (Every write since dumps the slice, so a
        # deleted notices dataset is never re-added.)
        block = {}
    elif not isinstance(block, Mapping) or not any(k in block for k in LEGACY_NOTICES_KEYS):
        return dict(raw)
    notices = dict(block)
    enabled = notices.pop("enabled", True)
    refresh_s = notices.pop("refresh_s", DEFAULT_TTL_S)
    greenland = notices.pop("include_greenland", True)
    out = dict(raw)
    out["notices"] = notices
    datasets = out.get("datasets", [])
    if not isinstance(datasets, list):
        return out  # malformed — validation will say why
    if any(isinstance(d, Mapping) and d.get("provider") == "notices" for d in datasets):
        return out
    taken = {d.get("id") for d in datasets if isinstance(d, Mapping)}
    dataset_id, n = DEFAULT_DATASET_ID, 2
    while dataset_id in taken:
        dataset_id, n = f"{DEFAULT_DATASET_ID}-{n}", n + 1
    try:
        ttl_s = max(60.0, float(refresh_s))
    except (TypeError, ValueError):
        ttl_s = DEFAULT_TTL_S
    dataset = default_notices_dataset(
        dataset_id=dataset_id,
        regions=(REGION_DK, REGION_GL) if greenland is not False else (REGION_DK,),
        ttl_s=ttl_s,
        enabled=enabled is not False,
    )
    log.info(
        "notices are a dataset now: declared %r (regions %s, every %.0f s%s) "
        "from the old notices settings",
        dataset_id, "+".join(dataset["params"]["regions"]), ttl_s,
        "" if dataset["enabled"] else ", disabled",
    )
    out["datasets"] = [*datasets, dataset]
    return out
