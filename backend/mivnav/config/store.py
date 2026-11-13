# SPDX-License-Identifier: GPL-2.0-only
"""Persistence for :class:`~mivnav.config.model.Config`.

Two files: ``config.json`` (never a secret) and ``credentials.json``
(0600, rewritten only when a secret changes). See docs/architecture/config-store.md.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError

from .dataset_layout import migrate_legacy_dataset_dirs
from .migrate import migrate
from mivnav.plugins import migrate_config as migrate_plugin_config
from mivnav.plugins import set_disabled as set_plugins_disabled
from .model import (
    CONFIG_VERSION,
    CREDENTIALS_KEY,
    SECRET_FIELDS,
    Config,
    default_config_path,
    first_start_datasets,
)

#: Old per-provider dataset-dir fields M-DATA-3 retired; read out of the RAW
#: document by :func:`_legacy_dataset_dirs` before
#: :func:`~mivnav.config.migrate.migrate` drops/renames them.
_LEGACY_DATASET_DIR_FIELDS: tuple[tuple[str, str, str], ...] = (
    ("charts", "dir", "charts"),
    ("poi", "dir", "poi"),
    ("satellite", "dir", "satellite"),
    ("ocharts", "sets_dir", "ocharts"),
)

CREDENTIALS_FILENAME = "credentials.json"

if TYPE_CHECKING:
    from mivnav.features.ocharts.shop import Credentials

log = logging.getLogger(__name__)


def _legacy_dataset_dirs(raw: Mapping[str, Any]) -> dict[str, Path]:
    """``{provider: old directory}`` for every one of
    :data:`_LEGACY_DATASET_DIR_FIELDS` still present in ``raw``."""
    out: dict[str, Path] = {}
    for section, field, provider in _LEGACY_DATASET_DIR_FIELDS:
        block = raw.get(section)
        if isinstance(block, Mapping) and field in block:
            out[provider] = Path(block[field])
    return out

# Injected rather than imported so a store under a tmp test path can't reach
# out and read the developer's real ~/.config/mivnav/ocharts.env.
LegacyCredentials = Callable[[], "Credentials | None"]

# (current, candidate) -> None; raises to veto. See ConfigStore.patch.
Guard = Callable[[Config, Config], None]


class ConfigError(Exception):
    """A config document that is not valid (bad JSON, or bad values)."""


def deep_merge(base: Mapping[str, Any], patch: Mapping[str, Any]) -> dict[str, Any]:
    """RFC-7386-ish merge: nested objects merge, everything else replaces.
    Absent keys keep their current value; null does *not* delete (see
    :func:`_drop_null_secrets` for the one place null does mean something).
    """
    out = dict(base)
    for key, value in patch.items():
        current = out.get(key)
        if isinstance(value, Mapping) and isinstance(current, Mapping):
            out[key] = deep_merge(current, value)
        else:
            out[key] = value
    return out


def _drop_null_secrets(patch: Mapping[str, Any]) -> dict[str, Any]:
    """Strip a null at any :data:`~mivnav.config.model.SECRET_FIELDS` leaf
    ("leave unchanged", for GET-edit-PATCH). Scoped to secrets only — a
    blanket rule would break ``ocharts.s52_path``, where null is real."""
    out = dict(patch)
    for path in SECRET_FIELDS:
        out = _drop_null_leaf(out, path)
    return out


def _drop_null_leaf(node: Mapping[str, Any], path: tuple[str, ...]) -> dict[str, Any]:
    """``node``, minus ``path`` if it is present and null. Anything else —
    absent, non-null, or a branch that is not an object — is unchanged."""
    key, rest = path[0], path[1:]
    if key not in node:
        return dict(node)
    child = node[key]
    if not rest:
        return {k: v for k, v in node.items() if k != key} if child is None else dict(node)
    if not isinstance(child, Mapping):
        return dict(node)
    return {**node, key: _drop_null_leaf(child, rest)}


#: Safety bound on :func:`_validate_tolerating_unknown_fields`'s retry loop,
#: guarding against a pathological document that keeps exposing new errors.
_MAX_UNKNOWN_FIELD_PASSES = 20


def _drop_error_loc(node: Any, loc: tuple[str | int, ...]) -> Any:
    """``node``, minus the value at ``loc`` (a pydantic ``ValidationError``
    error's ``loc``) — the key/index itself removed, not just nulled, since an
    ``extra_forbidden`` leaf must stop existing to stop tripping validation."""
    if not loc:
        return node
    key, rest = loc[0], loc[1:]
    if isinstance(node, list):
        if not isinstance(key, int) or key >= len(node):
            return node
        out_list = list(node)
        out_list[key] = _drop_error_loc(out_list[key], rest)
        return out_list
    if isinstance(node, Mapping):
        if key not in node:
            return dict(node)
        if not rest:
            return {k: v for k, v in node.items() if k != key}
        return {**node, key: _drop_error_loc(node[key], rest)}
    return node


class ConfigStore:
    """The current config, and its file.

    Pure: no globals, no import-time side effects. One per process (built
    at the composition root, mivnav.api.deps) or one per test.
    """

    def __init__(
        self,
        path: Path | None = None,
        credentials_path: Path | None = None,
        legacy_credentials: LegacyCredentials | None = None,
    ) -> None:
        self.path = path or default_config_path()
        # Defaulted beside the config rather than to the global default, so
        # a store pointed at a tmp dir keeps *both* files there — a test
        # must not be able to write the developer's real credentials.
        self.credentials_path = credentials_path or (self.path.parent / CREDENTIALS_FILENAME)
        self._legacy_credentials = legacy_credentials
        self._lock = threading.Lock()
        self._install(self._read_or_seed())

    def _install(self, config: Config) -> None:
        """Make ``config`` current, and tell the plugin kernel which plugins
        it switches off (so a toggle takes effect without a restart)."""
        self._config = config
        set_plugins_disabled(config.plugins_disabled)

    def get(self) -> Config:
        """The current config. Immutable — safe to hold and to compare."""
        with self._lock:
            return self._config

    def _read_or_seed(self) -> Config:
        if not self.path.exists():
            config = self._seed()
            self._write(config, previous=None)
            log.info("wrote initial config to %s", self.path)
            return config
        return self._read()

    def _read_json(self, path: Path) -> dict[str, Any]:
        try:
            raw = json.loads(path.read_text())
        except OSError as e:
            raise ConfigError(f"cannot read {path}: {e}") from e
        except json.JSONDecodeError as e:
            raise ConfigError(f"{path} is not valid JSON: {e}") from e
        if not isinstance(raw, dict):
            raise ConfigError(f"{path} must contain a JSON object")
        return raw

    def _read(self) -> Config:
        raw = self._read_json(self.path)
        # Captured before `migrate()` drops/renames these fields — the only
        # place their old values are still visible (physical-file relocation
        # is kept separate from the pure key-rename; see dataset_layout).
        legacy_dirs = _legacy_dataset_dirs(raw)
        # Normalise old field names (M-DATA-2) before anything else reads the
        # document, so an existing config.json keeps working. Idempotent.
        raw = migrate(raw)
        # Then each installed plugin's own key moves (mivnav.plugins).
        raw = migrate_plugin_config(raw)
        version = raw.get("version", CONFIG_VERSION)
        if version != CONFIG_VERSION:
            # No migration path exists yet — there has only ever been one
            # version; refuse rather than validate a document from a future
            # version against today's schema on a guess.
            raise ConfigError(
                f"{self.path}: config version {version} is not supported "
                f"(this server writes version {CONFIG_VERSION})"
            )
        if CREDENTIALS_KEY in raw:
            # Refuse rather than quietly honour it: a config that could hold
            # a secret would be one backup away from leaking.
            raise ConfigError(
                f"{self.path} must not contain {CREDENTIALS_KEY!r} — "
                f"credentials belong in {self.credentials_path}"
            )
        raw[CREDENTIALS_KEY] = self._read_credentials()
        config = self._validate_tolerating_unknown_fields(raw)
        if legacy_dirs:
            # Real filesystem work, kept out of `migrate()` (pure) and run
            # only once the merged document is known-valid — see
            # mivnav.config.dataset_layout.
            migrate_legacy_dataset_dirs(legacy_dirs, config.data_root)
        return config

    def _validate_tolerating_unknown_fields(self, raw: Mapping[str, Any]) -> Config:
        """Validate ``raw`` into a :class:`Config`, dropping any key the model
        no longer declares rather than refusing to start. Load-time fallback
        only — :meth:`patch` still rejects unknown keys on a live request."""
        doc: Mapping[str, Any] = raw
        for _ in range(_MAX_UNKNOWN_FIELD_PASSES):
            try:
                return Config.model_validate(doc)
            except ValidationError as e:
                extra = [err for err in e.errors() if err["type"] == "extra_forbidden"]
                if not extra:
                    raise ConfigError(f"{self.path} is not a valid config: {e}") from e
                for err in extra:
                    loc = ".".join(str(p) for p in err["loc"])
                    log.warning("%s: dropping unknown/stale key %r", self.path, loc)
                    doc = _drop_error_loc(doc, err["loc"])
        raise ConfigError(f"{self.path}: still invalid after dropping every unknown key")

    def _read_credentials(self) -> dict[str, Any]:
        if not self.credentials_path.exists():
            return {}
        raw = self._read_json(self.credentials_path)
        secrets = raw.get(CREDENTIALS_KEY, {})
        if not isinstance(secrets, dict):
            raise ConfigError(
                f"{self.credentials_path}: {CREDENTIALS_KEY!r} must be a JSON object"
            )
        return secrets

    def _seed(self) -> Config:
        """A fresh config, importing the legacy credentials file (if the
        caller supplied a reader and it finds one) once, into
        credentials.json — the old ocharts.env is left alone, untouched."""
        config = Config(datasets=first_start_datasets())
        legacy = self._legacy_credentials() if self._legacy_credentials else None
        if legacy is None:
            return config
        log.info("imported o-charts credentials from the legacy ocharts.env")
        data = config.to_storage()
        data["credentials"]["ocharts"] = {"user": legacy.user, "password": legacy.password}
        return Config.model_validate(data)

    def reload(self) -> Config:
        """Re-read the file — for an operator who hand-edited it while the
        server was running. Derived objects pick the change up on their
        next access (mivnav.config.derived)."""
        with self._lock:
            self._install(self._read())
            return self._config

    def replace(self, config: Config) -> Config:
        with self._lock:
            self._write(config, previous=self._config)
            self._install(config)
            return config

    def patch(self, patch: Mapping[str, Any], guard: Guard | None = None) -> Config:
        """Deep-merge ``patch`` into the config and persist the *merged
        whole* (validated first, so a bad patch never touches disk).
        ``guard`` runs under the lock so it can veto atomically, without
        racing a concurrent patch."""
        with self._lock:
            merged = deep_merge(self._config.to_storage(), _drop_null_secrets(patch))
            try:
                config = Config.model_validate(merged)
            except ValidationError as e:
                raise ConfigError(str(e)) from e
            if guard is not None:
                guard(self._config, config)
            self._write(config, previous=self._config)
            self._install(config)
            return config

    def _write(self, config: Config, previous: Config | None) -> None:
        """Persist to both files. Config first: if the credentials write then
        fails, the secret on disk is merely stale rather than lost."""
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        config_body, credentials_body = config.split_storage()
        self._write_json(self.path, config_body)
        if previous is None or previous.credentials != config.credentials:
            self._write_json(self.credentials_path, credentials_body)

    def _write_json(self, path: Path, body: dict[str, Any]) -> None:
        """Atomically, 0600 from birth (not chmod'd after) — a secret must
        never exist on disk world-readable, even briefly. Temp file lives
        in the destination dir so ``os.replace`` stays on one filesystem."""
        text = json.dumps(body, indent=2, sort_keys=True) + "\n"
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.stem}-", suffix=".json")
        try:
            with os.fdopen(fd, "w") as f:
                os.fchmod(f.fileno(), 0o600)
                f.write(text)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        except BaseException:
            os.unlink(tmp)
            raise
