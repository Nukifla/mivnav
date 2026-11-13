# SPDX-License-Identifier: GPL-2.0-only
"""Out-of-tree plugins: optional add-ons kept under ``<repo>/plugins/<name>/``.

The plugins directory is NOT part of this repository (it is gitignored), so
every plugin is its own project. A plugin's backend half is the package
``plugins/<name>/backend/`` (an ``__init__.py`` defining ``PLUGIN``), loaded
under the module name ``mivnav_plugin_<name>`` so its own modules and tests
can import each other by that name. Its frontend half is picked up
separately by the frontend build (``frontend/src/plugins.ts``).

What a plugin can contribute (all optional, all resolved LAZILY so a
plugin's modules may import any part of mivnav without an import cycle):

- ``features`` — whole :class:`~mivnav.feature.Feature` registrations
  (routers, a runtime, optionally a ``/providers`` entry), mounted like the
  built-in ones.
- ``poi_sources`` — extra POI dataset implementations
  (:class:`mivnav.features.poi.sources.PoiSource`): a POI dataset can then be
  baked from that source, and its points merge with OpenStreetMap's.
- ``migrate_config`` — a load-time rewrite of the raw config document (e.g.
  to move the plugin's old keys into ``plugins.<id>``), run before
  validation.
- ``dataset_providers`` — ids of the dataset providers its features add
  (a ``DatasetConfig.provider`` may name one).

A plugin's own settings live in ``Config.plugins[<id>]`` — an opaque object
the plugin validates itself.

A plugin can be switched off without removing it: ``Config.plugins_disabled``
lists the ids. Every installed plugin is still loaded and its routers stay
mounted (FastAPI can't unmount), but a disabled plugin's routes answer 404,
its features drop out of ``/providers`` and the dataset runners, and its POI
sources are not offered — see :func:`active_plugins` and :func:`is_enabled`.
The config store keeps the disabled set current (:func:`set_disabled`), so a
``PATCH /config`` takes effect at once.

Kernel module: imports nothing from the features or the composition root.
"""

from __future__ import annotations

import importlib.util
import logging
import re
import sys
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

#: ``<repo>/plugins`` — next to ``backend/`` in a checkout and in the
#: deployed tree alike.
PLUGINS_DIR = Path(__file__).resolve().parents[2] / "plugins"

MODULE_PREFIX = "mivnav_plugin_"

_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")


@dataclass(frozen=True)
class Plugin:
    """What one plugin registers. ``id`` keys its ``Config.plugins`` block."""

    id: str
    #: What Settings shows for it (defaults to ``id``).
    label: str = ""
    #: Feature registrations, built on first use.
    features: Callable[[], Sequence[Any]] = field(default=lambda: ())
    #: ``mivnav.features.poi.sources.PoiSource`` instances, built on first use.
    poi_sources: Callable[[], Sequence[Any]] = field(default=lambda: ())
    #: Raw config document -> migrated copy; must be pure and idempotent.
    migrate_config: Callable[[dict[str, Any]], dict[str, Any]] | None = None
    #: Dataset provider ids its features register.
    dataset_providers: tuple[str, ...] = ()

    @property
    def title(self) -> str:
        return self.label or self.id


_lock = threading.RLock()
_loaded: tuple[Plugin, ...] | None = None
_disabled = False
#: ``Config.plugins_disabled``, as last set by the config store.
_switched_off: frozenset[str] = frozenset()
#: feature id -> the plugin that registered it (filled by plugin_features).
_feature_owner: dict[str, str] = {}


def disable() -> None:
    """Run without any plugin (the OpenAPI dump the frontend's generated
    types come from, and the core test suite). Call before anything asks."""
    global _loaded, _disabled
    with _lock:
        _disabled = True
        _loaded = ()


def _module_name(dirname: str) -> str:
    return MODULE_PREFIX + dirname.replace("-", "_")


def _load_one(directory: Path) -> Plugin | None:
    package = directory / "backend"
    init = package / "__init__.py"
    if not init.is_file():
        return None
    name = _module_name(directory.name)
    if not _NAME_RE.match(name[len(MODULE_PREFIX):]):
        log.warning("plugin %s: directory name is not a valid identifier, skipped", directory)
        return None
    module = sys.modules.get(name)
    if module is None:
        spec = importlib.util.spec_from_file_location(
            name, init, submodule_search_locations=[str(package)]
        )
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            del sys.modules[name]
            log.exception("plugin %s failed to load, skipped", directory.name)
            return None
    plugin = getattr(module, "PLUGIN", None)
    if not isinstance(plugin, Plugin):
        log.warning("plugin %s: backend/__init__.py defines no PLUGIN, skipped", directory.name)
        return None
    return plugin


def plugins(root: Path | None = None) -> tuple[Plugin, ...]:
    """Every plugin found under :data:`PLUGINS_DIR`, in directory-name order.
    Loaded once per process; a plugin that fails to import is logged and
    skipped, never fatal."""
    global _loaded
    with _lock:
        if _loaded is not None and root is None:
            return _loaded
        base = root or PLUGINS_DIR
        found: list[Plugin] = []
        if base.is_dir():
            for directory in sorted(p for p in base.iterdir() if p.is_dir()):
                if directory.name.startswith((".", "_")) or directory.name == "node_modules":
                    continue
                plugin = _load_one(directory)
                if plugin is not None:
                    found.append(plugin)
                    log.info("plugin loaded: %s (%s)", plugin.id, directory)
        result = tuple(found)
        if root is None:
            _loaded = result
        return result


def set_disabled(ids: Sequence[str]) -> None:
    """The plugins switched off in config (``Config.plugins_disabled``)."""
    global _switched_off
    _switched_off = frozenset(ids)


def is_enabled(plugin_id: str) -> bool:
    return plugin_id not in _switched_off


def active_plugins() -> tuple[Plugin, ...]:
    """The installed plugins that are not switched off."""
    return tuple(p for p in plugins() if is_enabled(p.id))


def plugin_features() -> tuple[Any, ...]:
    """Every installed plugin's features — disabled ones too: routers are
    mounted once, at startup, and gated per request instead."""
    out = []
    for p in plugins():
        for f in p.features():
            _feature_owner[f.id] = p.id
            out.append(f)
    return tuple(out)


def feature_owner(feature_id: str) -> str | None:
    """The plugin that registered ``feature_id`` (``None``: a built-in one)."""
    return _feature_owner.get(feature_id)


def feature_enabled(feature_id: str) -> bool:
    owner = feature_owner(feature_id)
    return owner is None or is_enabled(owner)


def plugin_dataset_providers() -> tuple[str, ...]:
    """Dataset provider ids every installed plugin adds."""
    return tuple(d for p in plugins() for d in p.dataset_providers)


def migrate_config(raw: Mapping[str, Any]) -> dict[str, Any]:
    """``raw`` passed through every plugin's ``migrate_config``."""
    out = dict(raw)
    for p in plugins():
        if p.migrate_config is not None:
            out = p.migrate_config(out)
    return out


def plugin_config(config: Any, plugin_id: str) -> Mapping[str, Any]:
    """The raw ``Config.plugins[plugin_id]`` block (``{}`` when absent)."""
    block = getattr(config, "plugins", {}).get(plugin_id)
    return block if isinstance(block, Mapping) else {}
