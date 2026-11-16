# SPDX-License-Identifier: GPL-2.0-only
"""The server-side configuration object — the single source of truth.

One validated object persisted as JSON; **no configuration environment
variables**. Two files on disk: ``credentials`` goes to
``credentials.json``, everything else to ``config.json`` (see
:mod:`mivnav.config.store`). Full rationale: docs/architecture/config-model.md.

Shape::

    version: 1
    data_root:    # root of every provider's own dataset directory (M-DATA-3)
    ocharts:      # o-charts service tunables (budgets, rescan; no more sets_dir)
    signalk:      # SignalK connection (host/port/enabled)
    datasets:     # declared offline datasets (id, provider, region, ...)
    updates:      # software-update checks against GitHub releases
    credentials:  # EVERY secret lives under this key, and only here
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Literal

from pydantic import (
    Field,
    SecretStr,
    SerializationInfo,
    field_serializer,
    field_validator,
    model_validator,
)

from mivnav.config.base import REPO_DATA as _REPO_DATA
from mivnav.config.base import Frozen
from mivnav.feature import DatasetMode, IngestSchedule
from mivnav.features.notices.config import NoticesConfig, default_notices_dataset
from mivnav.features.ocharts.config import OchartsConfig
from mivnav.features.osm_world.config import OsmWorldConfig
from mivnav.features.poi.config import PoiConfig
from mivnav.features.poi.mivport.config import MivportConfig
from mivnav.collision.config import CollisionConfig
from mivnav.gnss.config import GnssConfig
from mivnav.shallow.config import ShallowConfig
from mivnav.features.route.config import NavConfig
from mivnav.features.satellite.config import SatelliteConfig
from mivnav.features.track.config import TrackConfig
from mivnav.geo import countries
from mivnav.plugins import plugin_dataset_providers

#: The built-in provider ids a :class:`DatasetConfig` may name. Hardcoded
#: (kernel may not import the feature registry, see ``backend/.importlinter``),
#: plus ``"charts"``. ``"osm"`` was retired; see docs/architecture/config-model.md.
#: A plugin adds its own (``Plugin.dataset_providers``): see
#: :func:`dataset_providers`.
CORE_DATASET_PROVIDERS: tuple[str, ...] = (
    "charts", "poi", "satellite", "ocharts", "osm_world", "notices"
)

#: Kept in step with ``mivnav.config.migrate.RETIRED_PROVIDERS``.
_RETIRED_DATASET_PROVIDERS = frozenset({"osm"})

#: A dataset provider id — a built-in one or a plugin's.
DatasetProvider = str


def dataset_providers() -> tuple[str, ...]:
    """Every provider id a dataset may be declared with: the built-in ones
    plus every installed plugin's."""
    return CORE_DATASET_PROVIDERS + tuple(
        p for p in plugin_dataset_providers() if p not in CORE_DATASET_PROVIDERS
    )

# Each per-feature config SLICE class lives in its own feature directory
# (allow-listed kernel->feature edges in backend/.importlinter); Config
# below only ASSEMBLES them — it is kernel, not itself a feature.

CONFIG_VERSION = 1

# Placeholder for a secret when serialising without the reveal context.
# Never a real value; see `redacted()` for what the API returns.
SECRET_MASK = "**********"

# Behavioural defaults are imported, not restated, so they can't drift from
# the module they tune. The *location* defaults below are the config's own.


def default_data_root() -> Path:
    """Every dataset-owning provider's own directory
    (``data_root/poi``, ``/satellite``, ``/ocharts``, ``/charts`` —
    see :func:`mivnav.config.base.provider_root`) sits under this one root.
    """
    return _REPO_DATA


def default_search_db_path() -> Path:
    # A derived, rebuildable index — XDG cache, like the weather proxy's
    # disk mirror, not `_REPO_DATA` or config_home() (hand-editable config).
    cache_home = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return cache_home / "mivnav" / "search" / "index.sqlite3"


def default_log_dir() -> Path:
    """Where a feature's own persisted diagnostic log lives, if it wants
    one — same XDG cache anchor as :func:`default_search_db_path`, not
    `config_home()` (reserved for hand-editable config/credentials;
    CLAUDE.md ## Config) and not `_REPO_DATA` (installed chart/dataset
    bakes, not diagnostics). A plain function, not (yet) a config field:
    unlike `default_search_db_path` (the real, load-bearing location of an
    operational database), this backs a debugging aid nothing else reads —
    promote it to a config field if a caller ever needs the settings UI to
    move it."""
    cache_home = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return cache_home / "mivnav" / "logs"


def config_home() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "mivnav"


def default_config_path() -> Path:
    return config_home() / "config.json"


def default_credentials_path() -> Path:
    return config_home() / "credentials.json"


def default_profiles_path() -> Path:
    return config_home() / "profiles.json"


def default_layouts_path() -> Path:
    return config_home() / "layouts.json"


#: Shared by `Region.id` and `DatasetConfig.id` (see `_validate_safe_id`) —
#: both are safe single-path-component-shaped tokens. One regex, so
#: tightening/loosening the shape can't drift between the two call sites.
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


#: The id of the one built-in default region (name "Solent"). Named once so
#: `Config.regions`' default factory and `PoiIngestRunner`'s no-config
#: fallback can't drift apart on the literal.
DEFAULT_REGION_ID = "solent"


def _validate_safe_id(kind: str, value: str, shape: str = "a safe token") -> str:
    """Shared body of `Region._safe_id`/`DatasetConfig._safe_id`."""
    if not _SAFE_ID_RE.match(value):
        raise ValueError(f"invalid {kind} id {value!r}: must be {shape} ([A-Za-z0-9._-]+)")
    return value


class BBox(Frozen):
    """One rectangular bounding box, ``(min_lon, min_lat, max_lon, max_lat)``
    = (west, south, east, north), in degrees. The unit :class:`Region`'s
    ``bboxes`` list is built from."""

    min_lon: float = Field(ge=-180, le=180)
    min_lat: float = Field(ge=-90, le=90)
    max_lon: float = Field(ge=-180, le=180)
    max_lat: float = Field(ge=-90, le=90)

    @model_validator(mode="after")
    def _ordered(self) -> "BBox":
        if not self.min_lon < self.max_lon:
            raise ValueError("need min_lon < max_lon")
        if not self.min_lat < self.max_lat:
            raise ValueError("need min_lat < max_lat")
        return self

    def as_tuple(self) -> tuple[float, float, float, float]:
        return (self.min_lon, self.min_lat, self.max_lon, self.max_lat)


class Region(Frozen):
    """One named, boat-wide area of interest — EITHER a whole country (ISO
    3166-1 alpha-2) OR one or more explicit bounding boxes (``bboxes``).

    Top-level (``Config.regions``): both POI and satellite bake pickers read
    this list. ``id`` is the stable reference; ``name`` is just a label. Full
    design notes: docs/architecture/config-model.md.
    """

    # Deliberately NO default (same posture as `DatasetConfig.id`): a static
    # default would be silently WRONG for any region other than the one it
    # names. Every caller supplies one explicitly.
    id: str = Field(min_length=1)
    name: str = Field(default="Solent", min_length=1)
    # ISO 3166-1 alpha-2 country code. Set → country variant; None → bbox
    # variant. Normalised to uppercase; validated against the bundled data.
    country: str | None = None
    # The pre-kolmnrsk single-box representation. Meaningless leftovers once
    # `bboxes` holds more than one entry; kept for old-config compatibility.
    min_lon: float = Field(default=-1.65, ge=-180, le=180)
    min_lat: float = Field(default=50.68, ge=-90, le=90)
    max_lon: float = Field(default=-1.05, ge=-180, le=180)
    max_lat: float = Field(default=50.82, ge=-90, le=90)
    # The current representation. Populated from the flat fields above by
    # `_country_xor_bbox` when left empty, so this is NEVER empty for a
    # non-country region once validation has run.
    bboxes: tuple[BBox, ...] = Field(default_factory=tuple)

    @field_validator("id")
    @classmethod
    def _safe_id(cls, value: str) -> str:
        return _validate_safe_id("region", value)

    @field_validator("country")
    @classmethod
    def _normalise_country(cls, value: str | None) -> str | None:
        if value is None:
            return None
        code = value.strip().upper()
        if not code:
            raise ValueError("country must be a non-empty ISO 3166-1 alpha-2 code")
        return code

    @model_validator(mode="after")
    def _country_xor_bbox(self) -> "Region":
        """Arbitrate the three representations **by VALUE, never by which
        fields the caller set** (a `model_fields_set`-gated version broke
        round-tripping — see docs/architecture/config-model.md). Precedence:
        country wins, else non-empty `bboxes`, else the flat fields.
        """
        if self.country is not None:
            if not countries.is_country(self.country):
                raise ValueError(f"unknown country code {self.country!r}")
            return self
        if self.bboxes:
            return self
        # Pre-kolmnrsk single-box shape: validate the flat fields, then
        # normalise into `bboxes` so readers never see two representations.
        if not self.min_lon < self.max_lon:
            raise ValueError("need min_lon < max_lon")
        if not self.min_lat < self.max_lat:
            raise ValueError("need min_lat < max_lat")
        box = BBox(
            min_lon=self.min_lon,
            min_lat=self.min_lat,
            max_lon=self.max_lon,
            max_lat=self.max_lat,
        )
        object.__setattr__(self, "bboxes", (box,))
        return self

    @property
    def iso(self) -> str | None:
        """The country's ISO 3166-1 alpha-2 code if this is a country region,
        else ``None``. POI's fetcher uses this to choose the Overpass ``area``
        filter over a bbox filter."""
        return self.country

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        """The ONE ``(min_lon, min_lat, max_lon, max_lat)`` tuple a bake still
        consumes: country's enclosing box, else the box ENCLOSING every entry
        in ``bboxes``. A consumer wanting the boxes individually reads
        ``.bboxes`` instead.
        """
        if self.country is not None:
            return countries.country_bbox(self.country)
        lons = [b.min_lon for b in self.bboxes] + [b.max_lon for b in self.bboxes]
        lats = [b.min_lat for b in self.bboxes] + [b.max_lat for b in self.bboxes]
        return (min(lons), min(lats), max(lons), max(lats))


def fold_legacy_dataset_schedule(data: object) -> object:
    """Fold the retired ``schedule: "on-demand"`` spelling into the
    ``mode``/``schedule`` pair that replaced it. PERMANENT read-compat (not
    a :mod:`mivnav.config.migrate` entry) — see docs/architecture/config-model.md.
    """
    if not isinstance(data, dict) or data.get("schedule") != "on-demand":
        return data
    data = dict(data)
    data["schedule"] = "manual"
    data.setdefault("mode", "live-cache")
    return data


class DatasetConfig(Frozen):
    """One declared offline dataset — a name for a folder
    (``data_root/<provider>/<id>``) plus what should be baked into it.
    ``Config.datasets`` starts empty; nothing backfills it from disk.
    Full field-by-field rationale: docs/architecture/config-model.md.
    """

    id: str = Field(min_length=1)
    #: A built-in provider or a plugin's. Not checked against the installed
    #: plugins here: a dataset of a plugin that has since been removed (or is
    #: switched off) must still load, inert, rather than break the config.
    provider: DatasetProvider = Field(min_length=1)
    name: str = Field(min_length=1)
    region_id: str | None = None
    mode: DatasetMode = "bake"
    implementation: str | None = None
    schedule: IngestSchedule = "manual"
    ttl_s: float | None = Field(default=None, gt=0)
    params: dict = Field(default_factory=dict)
    enabled: bool = True

    @model_validator(mode="before")
    @classmethod
    def _legacy_on_demand_schedule(cls, data: object) -> object:
        return fold_legacy_dataset_schedule(data)

    @field_validator("id")
    @classmethod
    def _safe_id(cls, value: str) -> str:
        return _validate_safe_id("dataset", value, shape="a safe single path component")

    @field_validator("provider")
    @classmethod
    def _safe_provider(cls, value: str) -> str:
        # A path component too (``data_root/<provider>/<id>``).
        value = _validate_safe_id("dataset provider", value, shape="a safe single path component")
        if value in _RETIRED_DATASET_PROVIDERS:
            # Dropped on READ (mivnav.config.migrate); a PATCH still naming
            # one is a stale client.
            raise ValueError(f"dataset provider {value!r} was retired")
        return value


def first_start_datasets() -> tuple[DatasetConfig, ...]:
    """The datasets a brand-new config starts with (``ConfigStore._seed``),
    not ``Config.datasets``' default — a ``Config()`` built in code stays
    empty. Only notices to mariners: safety data that should work out of
    the box (on a ttl schedule), where every other dataset is a deliberate
    download the sailor sizes and places. A config that predates notices
    datasets gets the same one by migration
    (:func:`mivnav.config.migrate.migrate_notices_datasets`)."""
    return (DatasetConfig.model_validate(default_notices_dataset()),)


class SearchConfig(Frozen):
    """The shared search index's config slice: where the one SQLite database
    every ingest source bakes searchable records into lives. Independent of
    any one source's own config slice, since the index outlives all of them.
    """

    db_path: Path = Field(default_factory=default_search_db_path)


class UpdatesConfig(Frozen):
    """How this server looks for new mivnav releases (``/system/update``).

    Kernel, not a feature slice: the updater is the server itself, not a
    data provider. ``check`` gates only the *automatic* lookup a plain
    ``GET /system/update`` would make — an explicit "Check now"
    (``?refresh=1``) still asks GitHub, because the user asked. The boat is
    usually offline, so turning this off just stops pointless attempts.
    """

    #: Look up the latest release on GitHub when the Software panel opens
    #: (at most once per cache period). ``False`` = only on "Check now".
    check: bool = True
    #: Offer pre-releases (``v0.2.0-rc.1``) as "latest" too.
    include_prereleases: bool = False


class SignalKConfig(Frozen):
    """Where SignalK lives.

    The server holds the boat's one connection and proxies it to every
    device — configured once per boat, not per device. ``enabled = False``
    is a live state (status ``off``), not an error.
    """

    enabled: bool = True
    host: str = "localhost"
    port: int = Field(default=3000, ge=1, le=65535)
    tls: bool = False
    #: BOAT-WIDE list of extra SignalK paths to subscribe to and pass through
    #: raw. Never ``*`` (Pi CPU grounds — hard validation error). See
    #: docs/architecture/config-model.md.
    extra_paths: list[str] = Field(default_factory=list)

    @field_validator("extra_paths")
    @classmethod
    def _reject_wildcard_extra_paths(cls, paths: list[str]) -> list[str]:
        cleaned: list[str] = []
        seen: set[str] = set()
        for raw in paths:
            path = raw.strip()
            if not path:
                continue  # an empty path is not a subscription; drop it
            if "*" in path:
                # Enforced structurally, not trusted: a wildcard would pull
                # the whole bus. Extra paths are named, chosen leaves only.
                raise ValueError(
                    f"extra SignalK path {path!r} may not contain a wildcard; "
                    "subscribe to chosen paths by name, never '*'"
                )
            if path not in seen:
                seen.add(path)
                cleaned.append(path)
        return cleaned

    @property
    def ws_url(self) -> str:
        """Canonical v1 delta-stream URL. ``subscribe=none`` because the
        stream's own option offers only "self" or "all"; the service sends
        an explicit ``vessels.*`` subscription instead, the only way to get
        AIS targets *and* choose the paths.
        """
        scheme = "wss" if self.tls else "ws"
        return f"{scheme}://{self.host}:{self.port}/signalk/v1/stream?subscribe=none"

    @property
    def _v2_api_base(self) -> str:
        """Base of the v2 REST API root — ``…/signalk/v2/api``.

        One derivation of scheme/host/port shared by every v2 write surface,
        so a second hand-rolled ``https if tls`` can't let two of them drift.
        """
        scheme = "https" if self.tls else "http"
        return f"{scheme}://{self.host}:{self.port}/signalk/v2/api"

    @property
    def _v2_self_base(self) -> str:
        """Base of the v2 REST API for this vessel — ``…/vessels/self``."""
        return f"{self._v2_api_base}/vessels/self"

    @property
    def resources_url(self) -> str:
        """Base of the v2 Resources API — where a followed route is
        registered before activation. Sibling of :attr:`_v2_self_base`, not
        a child: ``resources/routes/<id>`` is boat data, not vessel state.
        """
        return f"{self._v2_api_base}/resources"

    @property
    def autopilot_url(self) -> str:
        """Base of the v2 Autopilot API — commands only. Read-only state
        rides the delta stream instead (see mivnav.autopilot.model).
        """
        return f"{self._v2_self_base}/autopilots"

    @property
    def course_url(self) -> str:
        """Base of the v2 Course API — the destination the autopilot steers
        to in track/nav mode.
        """
        return f"{self._v2_self_base}/navigation/course"

    @property
    def notifications_url(self) -> str:
        """Base of the v2 Notifications API — acknowledging an alarm here
        acknowledges it for every display on the boat (anchor.md Q5)."""
        return f"{self._v2_api_base}/notifications"

    @property
    def v1_self_url(self) -> str:
        """``…/signalk/v1/api/vessels/self`` — where a plain SignalK PUT on
        a path goes (the anchoralarm plugin's ``navigation.anchor.*``
        handlers)."""
        scheme = "https" if self.tls else "http"
        return f"{scheme}://{self.host}:{self.port}/signalk/v1/api/vessels/self"

    @property
    def history_url(self) -> str:
        """Base of the v2 History API. Sibling of :attr:`resources_url`, not
        a child — History is boat-wide and takes the vessel as a ``context``
        param. Deliberately not the short-lived ``/signalk/v2/history`` of
        releases ~2.20-2.24 (see mivnav.features.track.client).
        """
        return f"{self._v2_api_base}/history"


def _reveal_or_mask(value: SecretStr, info: SerializationInfo) -> str:
    """Fail-safe: the *default* is to mask. Only the persistence path opts
    in, so no new caller can leak a secret by forgetting to opt out."""
    if (info.context or {}).get("reveal_secrets"):
        return value.get_secret_value()
    return SECRET_MASK


class OchartsCredentials(Frozen):
    """o-charts.org account login (*account* password only — buys a shop
    session key, doesn't decrypt anything). Stored plaintext in its own
    0600 file (private-network deployment).
    """

    user: str = ""
    password: SecretStr = SecretStr("")

    @field_serializer("password", when_used="json")
    def _serialise_password(self, value: SecretStr, info: SerializationInfo) -> str:
        return _reveal_or_mask(value, info)


class SignalKCredentials(Frozen):
    """The SignalK server's write token, and nothing else.

    Reads need no credential; only commanding the autopilot does. Empty is a
    live "no token configured" state, not an error — doubles as off-switch.
    """

    token: SecretStr = SecretStr("")

    @field_serializer("token", when_used="json")
    def _serialise_token(self, value: SecretStr, info: SerializationInfo) -> str:
        return _reveal_or_mask(value, info)


class RouteIQCredentials(Frozen):
    """The write token for a signalk-routeiq plugin's own HTTP API
    (``/plugins/signalk-routeiq/router/...``) — the alternative routing
    ALGORITHM (the autorouting plugin's ``algorithm == "routeiq"``,
    ``plugins/autorouting/backend/config.py``), not the boat's own SignalK
    connection. Kept in core so the credentials file stays core-only.

    A SEPARATE credential from :class:`SignalKCredentials` above, on
    purpose, even though both are obtained from — and typically point at —
    the same physical SignalK box: this one's own access-request grant is
    independently revocable in the SignalK admin, and its own
    ``routeiq_client_id`` (``Config``, top-level, same reasoning as
    ``signalk_client_id``) is a genuinely different device identity to
    SignalK, since a re-request has to reference the same id the earlier
    grant was tied to. Confirmed by probing a real signalk-routeiq install
    directly: every one of its routes (including the main ``POST /route``)
    answers `401 — Please Login` unauthenticated, even though the plain
    SignalK REST API right beside it is open for reads.

    Stored in plaintext in its own 0600 file, same posture as the o-charts
    password and the SignalK write token beside it — private-network
    deployment.
    """

    token: SecretStr = SecretStr("")

    @field_serializer("token", when_used="json")
    def _serialise_token(self, value: SecretStr, info: SerializationInfo) -> str:
        return _reveal_or_mask(value, info)


class CredentialsConfig(Frozen):
    ocharts: OchartsCredentials = Field(default_factory=OchartsCredentials)
    signalk: SignalKCredentials = Field(default_factory=SignalKCredentials)
    routeiq: RouteIQCredentials = Field(default_factory=RouteIQCredentials)


CREDENTIALS_KEY = "credentials"

#: Every secret leaf, named once — :func:`redacted` nulls these on the way
#: out, ``mivnav.config.store._drop_null_secrets`` treats a null as "leave
#: unchanged" coming back in. Adding a secret means adding it here.
SECRET_FIELDS: tuple[tuple[str, ...], ...] = (
    (CREDENTIALS_KEY, "ocharts", "password"),
    (CREDENTIALS_KEY, "signalk", "token"),
    (CREDENTIALS_KEY, "routeiq", "token"),
)


class Config(Frozen):
    version: int = CONFIG_VERSION
    ocharts: OchartsConfig = Field(default_factory=OchartsConfig)
    # The one boat-wide root every dataset-owning provider's directory sits
    # under (M-DATA-3). A fetch-through cache (osm_world's live cache, a
    # plugin's) is not folded in — not a dataset.
    data_root: Path = Field(default_factory=default_data_root)
    poi: PoiConfig = Field(default_factory=PoiConfig)
    #: The mivport server a ``mivport`` POI dataset bakes from.
    mivport: MivportConfig = Field(default_factory=MivportConfig)
    osm_world: OsmWorldConfig = Field(default_factory=OsmWorldConfig)
    satellite: SatelliteConfig = Field(default_factory=SatelliteConfig)
    search: SearchConfig = Field(default_factory=SearchConfig)
    signalk: SignalKConfig = Field(default_factory=SignalKConfig)
    nav: NavConfig = Field(default_factory=NavConfig)
    #: The collision alarm's thresholds (boat-wide since the alarm moved
    #: server-side) — see :mod:`mivnav.collision`.
    collision: CollisionConfig = Field(default_factory=CollisionConfig)
    #: The GNSS-lost and connection alarms (delay, off/show/tell, sound) —
    #: see :mod:`mivnav.gnss`.
    gnss: GnssConfig = Field(default_factory=GnssConfig)
    #: The shallow-water alarm (server-side, published to SignalK like the
    #: collision alarm) — see :mod:`mivnav.shallow`.
    shallow: ShallowConfig = Field(default_factory=ShallowConfig)
    track: TrackConfig = Field(default_factory=TrackConfig)
    notices: NoticesConfig = Field(default_factory=NoticesConfig)
    updates: UpdatesConfig = Field(default_factory=UpdatesConfig)
    # This device's stable identity to the SignalK server, minted once and
    # never changed after (SignalK ties a granted device token to it).
    # Top-level, not inside `signalk`: not a connection setting, so minting
    # it doesn't tear down and re-dial the boat's SignalKService.
    signalk_client_id: str = ""
    # `signalk_client_id`'s twin for the RouteIQ access-request grant
    # (`RouteIQCredentials`; used by the autorouting plugin's `routeiq.py`) — a
    # SEPARATE device identity, minted independently the first time THAT
    # flow runs, so the two grants stay independently revocable in the
    # SignalK admin even though both typically point at the same box. Same
    # "top-level, not a secret, changing it re-dials nothing" reasoning as
    # `signalk_client_id`.
    routeiq_client_id: str = ""
    # Boat-wide named areas of interest (see :class:`Region`), shared by
    # every bake picker. A bare `POST /ingest/poi` bakes the FIRST region.
    # Non-empty so there is always a default (Solent).
    regions: tuple[Region, ...] = Field(
        default_factory=lambda: (Region(id=DEFAULT_REGION_ID),), min_length=1
    )
    # Declared offline datasets (see :class:`DatasetConfig`). Empty by
    # default — a boat's existing baked sets keep serving disk-scan
    # -discovered regardless of whether any is ever declared here.
    datasets: tuple[DatasetConfig, ...] = Field(default_factory=tuple)
    credentials: CredentialsConfig = Field(default_factory=CredentialsConfig)
    #: Each out-of-tree plugin's own settings (``mivnav.plugins``), keyed by
    #: plugin id. Opaque here: the plugin validates its own block, so a
    #: config written while a plugin was installed still loads without it.
    plugins: dict[str, dict[str, Any]] = Field(default_factory=dict)
    #: Installed plugins switched off (by id) — Settings → Plugins. A plugin
    #: listed here stays installed but serves nothing (``mivnav.plugins``).
    plugins_disabled: tuple[str, ...] = Field(default_factory=tuple)

    @model_validator(mode="after")
    def _datasets_are_well_formed(self) -> "Config":
        ids = [d.id for d in self.datasets]
        if len(ids) != len(set(ids)):
            raise ValueError("dataset ids must be unique")
        # Blanket boat-wide uniqueness (unlike the old by-name check): `id`
        # is the one thing a `region_id` can mean, so two regions sharing
        # one would make every reference to it inherently ambiguous.
        region_ids = [r.id for r in self.regions]
        if len(region_ids) != len(set(region_ids)):
            raise ValueError("region ids must be unique")
        region_id_set = set(region_ids)
        referenced = {d.region_id for d in self.datasets if d.region_id is not None}
        for region_id in referenced:
            if region_id not in region_id_set:
                raise ValueError(f"dataset references unknown region {region_id!r}")
        # A "live-cache" dataset names a provider's ONE live fetch-through
        # cache; a second would double-count the same bytes under a second
        # id in any per-provider size total.
        live_providers = [d.provider for d in self.datasets if d.mode == "live-cache"]
        if len(live_providers) != len(set(live_providers)):
            raise ValueError(
                "a provider may have at most one live-cache dataset "
                "(there is exactly one live cache to describe)"
            )
        return self

    def to_storage(self) -> dict[str, Any]:
        """JSON-able dict **with secrets in the clear** — the whole object,
        for PATCH merging. Reveals; handle accordingly."""
        return self.model_dump(mode="json", context={"reveal_secrets": True})

    def split_storage(self) -> tuple[dict[str, Any], dict[str, Any]]:
        """``(config.json body, credentials.json body)``.

        The single place the two files are divided, so "no secrets in the
        primary config" is enforced by construction, not convention.
        """
        whole = self.to_storage()
        secrets = whole.pop(CREDENTIALS_KEY)
        return whole, {"version": self.version, CREDENTIALS_KEY: secrets}


def redacted(config: Config) -> dict[str, Any]:
    """The config as the API returns it: secrets replaced by ``null``.

    ``null`` rather than the mask, because a PATCH treats a null secret as
    "leave unchanged" — a client can GET, edit, PATCH back without wiping a
    secret. See :data:`SECRET_FIELDS` for the other half.
    """
    data = config.model_dump(mode="json")  # masks by default
    for path in SECRET_FIELDS:
        node: Any = data
        for key in path[:-1]:
            node = node[key]
        node[path[-1]] = None
    return data
