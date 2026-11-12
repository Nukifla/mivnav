# SPDX-License-Identifier: GPL-2.0-only
"""Color-scale lookup, ported from ``@openmeteo/weather-map-layer``.

See docs/architecture/weather-colorscale-port.md for the source mapping,
table-regeneration command, and the step-function algorithm.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Literal

import numpy as np

_DATA_PATH = Path(__file__).parent / "data" / "colorscales.json"


@dataclass(frozen=True)
class ColorScale:
    type: Literal["breakpoint", "rgba"]
    unit: str
    # (N, 4) RGBA; alpha is a float in [0, 1], multiplied by 255 at draw time
    # (matches JS's `color[3]`), not pre-scaled.
    colors: np.ndarray
    breakpoints: np.ndarray | None  # ascending, only when type == "breakpoint"
    min: float | None = None  # rgba-scale domain, only when type == "rgba"
    max: float | None = None


@lru_cache(maxsize=1)
def _load() -> dict[str, dict[str, ColorScale]]:
    raw = json.loads(_DATA_PATH.read_text())
    out: dict[str, dict[str, ColorScale]] = {}
    for variable, by_theme in raw.items():
        out[variable] = {}
        for theme, scale in by_theme.items():
            out[variable][theme] = ColorScale(
                type=scale["type"],
                unit=scale.get("unit", ""),
                colors=np.array(scale["colors"], dtype=np.float64),
                breakpoints=(
                    np.array(scale["breakpoints"], dtype=np.float64)
                    if scale.get("breakpoints") is not None
                    else None
                ),
                min=scale.get("min"),
                max=scale.get("max"),
            )
    return out


#: Canonical variable (``sources/base.py``) -> the generated table's key;
#: unmapped names pass through, unknown ones raise. ``wind`` -> ``wind_speed_10m``
#: because a decoded wind field is always a speed magnitude, not backing-specific.
CANONICAL_SCALE_KEY: dict[str, str] = {
    "wind": "wind_speed_10m",
    "gusts": "wind_gusts_10m",
    "pressure": "pressure_msl",
    "temperature": "temperature_2m",
    "waves": "wave_height",
}


def get_color_scale(variable: str, dark: bool) -> ColorScale:
    """Resolved (light/dark applied) scale for ``variable`` — canonical
    (``wind``) or upstream (``wind_speed_10m``), see
    :data:`CANONICAL_SCALE_KEY`. Raises ``KeyError`` for anything not in the
    generated table; unlike the JS original there is no runtime fallback."""
    table = _load()
    themes = table.get(CANONICAL_SCALE_KEY.get(variable, variable))
    if themes is None:
        raise KeyError(
            f"no color scale generated for variable {variable!r} — add it to "
            "mivnav/weather/gen/dump_colorscales.mjs's VARIABLES and "
            "regenerate mivnav/weather/data/colorscales.json"
        )
    return themes["dark" if dark else "light"]


def color_for(scale: ColorScale, px: np.ndarray) -> np.ndarray:
    """RGBA8 colour for each value in ``px`` (any shape), per ``scale``.
    Vectorized port of the bundle's ``getColor``. Non-finite input produces a
    fully transparent pixel (JS skips calling getColor for NaN; here it's
    simplest to always call it and mask the result)."""
    finite = np.isfinite(px)
    px_safe = np.where(finite, px, 0.0)

    if scale.type == "breakpoint":
        assert scale.breakpoints is not None
        # side="right" - 1 == index of the last breakpoint <= v (JS findLastIndexLE)
        idx = np.searchsorted(scale.breakpoints, px_safe, side="right") - 1
        idx = np.clip(idx, 0, len(scale.breakpoints) - 1)
    else:
        assert scale.min is not None and scale.max is not None
        n = len(scale.colors)
        delta = (scale.max - scale.min) / n
        idx = np.floor((px_safe - scale.min) / delta).astype(np.int64)
        idx = np.clip(idx, 0, n - 1)

    rgba = scale.colors[idx]
    out = np.empty(rgba.shape[:-1] + (4,), dtype=np.uint8)
    out[..., 0:3] = np.clip(rgba[..., 0:3], 0, 255).astype(np.uint8)
    out[..., 3] = np.where(
        finite, np.clip(rgba[..., 3] * 255, 0, 255), 0.0
    ).astype(np.uint8)
    return out
