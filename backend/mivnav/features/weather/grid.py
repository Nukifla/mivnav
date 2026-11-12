# SPDX-License-Identifier: GPL-2.0-only
"""Grid/projection math, ported from ``@openmeteo/weather-map-layer``
``dist/index.mjs`` so the SAME bilinear interpolation and Lambert/Gaussian
grid handling runs server-side without the JS/WASM decode stack.
See docs/architecture/weather-grid-port.md for the ported-class map, the
scalar/array polymorphism rationale, and the cross-check test.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Protocol, TypeVar

import numpy as np

Num = TypeVar("Num", float, np.ndarray)

# Ported from the bundle's top-level utility functions, ~L855-917.
PI = math.pi


def degrees_to_radians(degree: Num) -> Num:
    return degree * (PI / 180)


def radians_to_degrees(rad: Num) -> Num:
    return rad * (180 / PI)


def normalize_lon(lon: Num) -> Num:
    """``(lon + 540) % 360 - 180`` — wraps into [-180, 180)."""
    return np.mod(lon + 540, 360) - 180


def mod_positive(n: Num, m: Num) -> Num:
    """Always-non-negative modulo (JS's ``(n % m + m) % m``)."""
    return np.mod(np.mod(n, m) + m, m)


def round_with_precision(value: Num, precision: float = 1e6) -> Num:
    return np.round((value + np.finfo(np.float64).eps) * precision) / precision


def tile2lon(x: Num, z: Num) -> Num:
    """Slippy-map tile column (fractional) → longitude, degrees."""
    return np.mod(x / (2.0**z) * 360 + 360, 360) - 180


def tile2lat(y: Num, z: Num) -> Num:
    """Slippy-map tile row (fractional) → latitude, degrees."""
    n = PI - 2 * PI * y / (2.0**z)
    return radians_to_degrees(np.arctan(0.5 * (np.exp(n) - np.exp(-n))))


def _interpolate_linear(
    values: np.ndarray,
    x: Num,
    y: Num,
    x_fraction: Num,
    y_fraction: Num,
    nx: int,
    longitude_wrap: bool = False,
) -> Num:
    """Bilinear interpolation of a flat row-major ``(ny, nx)`` array at
    fractional cell ``(x + x_fraction, y + y_fraction)``. Ported from the
    bundle's ``interpolateLinear`` (~L2660), including its single-missing-
    neighbour rescue — see docs/architecture/weather-grid-port.md.
    """
    is_scalar = np.isscalar(x) or (isinstance(x, np.ndarray) and x.ndim == 0)
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    x_fraction = np.asarray(x_fraction, dtype=np.float64)
    y_fraction = np.asarray(y_fraction, dtype=np.float64)

    # NaN x/y (an out-of-grid point) must be sanitized before casting to
    # int64 (undefined behaviour otherwise); finiteness folds into
    # `in_bounds` so those points resolve to NaN instead of crashing.
    finite_pos = np.isfinite(x) & np.isfinite(y)
    x_safe = np.where(finite_pos, x, 0)
    y_safe = np.where(finite_pos, y, 0)

    index0 = (y_safe * nx + x_safe).astype(np.int64)
    if longitude_wrap:
        next_index = (y_safe * nx + np.mod(x_safe + 1, nx)).astype(np.int64)
        wrap_ok = np.ones_like(index0, dtype=bool)
    else:
        next_index = index0 + 1
        wrap_ok = np.mod(next_index, nx) != 0

    in_bounds = finite_pos & ((index0 + nx) < values.size) & (index0 >= 0)
    safe0 = np.where(in_bounds, index0, 0)
    safe_next = np.where(in_bounds & wrap_ok, next_index, 0)

    p0 = np.where(in_bounds, values[safe0], np.nan)
    p1 = np.where(in_bounds & wrap_ok, values[safe_next], np.nan)
    p2 = np.where(in_bounds, values[np.clip(safe0 + nx, 0, values.size - 1)], np.nan)
    p3 = np.where(
        in_bounds & wrap_ok, values[np.clip(safe_next + nx, 0, values.size - 1)], np.nan
    )

    w0 = (1 - x_fraction) * (1 - y_fraction)
    w1 = x_fraction * (1 - y_fraction)
    w2 = (1 - x_fraction) * y_fraction
    w3 = x_fraction * y_fraction

    n0, n1, n2, n3 = ~np.isfinite(p0), ~np.isfinite(p1), ~np.isfinite(p2), ~np.isfinite(p3)
    none_missing = ~(n0 | n1 | n2 | n3)

    all_case = p0 * w0 + p1 * w1 + p2 * w2 + p3 * w3

    # caseN: corner pN (0=bottom-left, 1=bottom-right, 2=top-left,
    # 3=top-right) missing; re-weight over the other three, valid only past
    # the diagonal the missing corner would have influenced.
    ws_0 = w1 + w2 + w3
    case0_ok = (x_fraction + y_fraction >= 1) & (~n1 & ~n2 & ~n3)
    case0 = (p1 * w1 + p2 * w2 + p3 * w3) / np.where(ws_0 == 0, 1, ws_0)

    ws_1 = w0 + w2 + w3
    case1_ok = (1 - x_fraction + y_fraction >= 1) & (~n0 & ~n2 & ~n3)
    case1 = (p0 * w0 + p2 * w2 + p3 * w3) / np.where(ws_1 == 0, 1, ws_1)

    ws_2 = w0 + w1 + w3
    case2_ok = (x_fraction + 1 - y_fraction >= 1) & (~n0 & ~n1 & ~n3)
    case2 = (p0 * w0 + p1 * w1 + p3 * w3) / np.where(ws_2 == 0, 1, ws_2)

    ws_3 = w0 + w1 + w2
    case3_ok = (1 - x_fraction + 1 - y_fraction >= 1) & (~n0 & ~n1 & ~n2)
    case3 = (p0 * w0 + p1 * w1 + p2 * w2) / np.where(ws_3 == 0, 1, ws_3)

    only_p0_missing = n0 & ~n1 & ~n2 & ~n3
    only_p1_missing = ~n0 & n1 & ~n2 & ~n3
    only_p2_missing = ~n0 & ~n1 & n2 & ~n3
    only_p3_missing = ~n0 & ~n1 & ~n2 & n3

    result = np.select(
        [
            none_missing,
            only_p0_missing & case0_ok,
            only_p1_missing & case1_ok,
            only_p2_missing & case2_ok,
            only_p3_missing & case3_ok,
        ],
        [all_case, case0, case1, case2, case3],
        default=np.nan,
    )
    result = np.where(in_bounds, round_with_precision(result), np.nan)
    return result.item() if is_scalar else result


class GridInterface(Protocol):
    def get_bounds(self) -> tuple[float, float, float, float]: ...
    def get_linear_interpolated_value(self, values: np.ndarray, lat: Num, lon: Num) -> Num: ...


class GaussianGrid:
    """Reduced-Gaussian grid (ECMWF/some global ensembles). Ported from
    the bundle's ``GaussianGrid`` (~L2454)."""

    def __init__(self, data: dict[str, Any], ranges: list[dict[str, int]] | None = None):
        if ranges is None:
            ranges = [{"start": 0, "end": data["ny"]}, {"start": 0, "end": data["nx"]}]
        self.nx = data["nx"]
        self.nx_start = ranges[1]["start"]
        self.ny = data["ny"]
        self.latitude_lines = data["gaussianGridLatitudeLines"]

    def get_bounds(self) -> tuple[float, float, float, float]:
        return (-180, -90, 180, 90)

    @property
    def count(self) -> int:
        return 4 * self.latitude_lines * (self.latitude_lines + 9)

    def _nx_of(self, y: Num) -> Num:
        ll = self.latitude_lines
        return np.where(y < ll, 20 + y * 4, (2 * ll - y - 1) * 4 + 20)

    def _integral(self, y: Num) -> Num:
        ll = self.latitude_lines
        below = 2 * y * y + 18 * y - self.nx_start
        above = self.count - (
            2 * (2 * ll - y) * (2 * ll - y) + 18 * (2 * ll - y)
        ) - self.nx_start
        return np.where(y < ll, below, above)

    def get_linear_interpolated_value(self, values: np.ndarray, lat: Num, lon: Num) -> Num:
        ll = self.latitude_lines
        dy = 180 / (2 * ll + 0.5)
        raw = ll - 1 - (lat - dy / 2) / dy
        y_lower = mod_positive(np.floor(raw), 2 * ll).astype(np.int64)
        y_fraction = mod_positive(raw, 1)
        y_upper = y_lower + 1

        nx_lower = self._nx_of(y_lower)
        nx_upper = self._nx_of(y_upper)
        dx_lower = 360 / nx_lower
        dx_upper = 360 / nx_upper
        x_lower0 = mod_positive(np.floor(lon / dx_lower), nx_lower).astype(np.int64)
        x_upper0 = mod_positive(np.floor(lon / dx_upper), nx_upper).astype(np.int64)
        integral_lower = self._integral(y_lower).astype(np.int64)
        integral_upper = self._integral(y_upper).astype(np.int64)
        x_fraction_lower = mod_positive(lon / dx_lower, 1)
        x_fraction_upper = mod_positive(lon / dx_upper, 1)

        p0 = values[integral_lower + x_lower0]
        p1 = values[integral_lower + np.mod(x_lower0 + 1, nx_lower).astype(np.int64)]
        p2 = values[integral_upper + x_upper0]
        p3 = values[integral_upper + np.mod(x_upper0 + 1, nx_upper).astype(np.int64)]

        w0 = (1 - x_fraction_lower) * (1 - y_fraction)
        w1 = x_fraction_lower * (1 - y_fraction)
        w2 = (1 - x_fraction_upper) * y_fraction
        w3 = x_fraction_upper * y_fraction

        n0, n1, n2, n3 = (~np.isfinite(p) for p in (p0, p1, p2, p3))
        none_missing = ~(n0 | n1 | n2 | n3)
        all_case = p0 * w0 + p1 * w1 + p2 * w2 + p3 * w3

        x_fraction = (1 - y_fraction) * x_fraction_lower + y_fraction * x_fraction_upper

        ws0 = w1 + w2 + w3
        case0_ok = ~(x_fraction_lower < x_fraction_upper) & ~((x_fraction + y_fraction) < 1)
        case0 = (p1 * w1 + p2 * w2 + p3 * w3) / np.where(ws0 == 0, 1, ws0)

        ws1 = w0 + w2 + w3
        case1_ok = ~(x_fraction_lower > x_fraction_upper) & ~((x_fraction + 1 - y_fraction) < 1)
        case1 = (p0 * w0 + p2 * w2 + p3 * w3) / np.where(ws1 == 0, 1, ws1)

        ws2 = w0 + w1 + w3
        case2_ok = ~(x_fraction_lower > x_fraction_upper) & ~((x_fraction + 1 - y_fraction) > 1)
        case2 = (p0 * w0 + p1 * w1 + p3 * w3) / np.where(ws2 == 0, 1, ws2)

        ws3 = w0 + w1 + w2
        case3_ok = ~(x_fraction_lower < x_fraction_upper) & ~((x_fraction + y_fraction) > 1)
        case3 = (p0 * w0 + p1 * w1 + p2 * w2) / np.where(ws3 == 0, 1, ws3)

        result = np.select(
            [
                none_missing,
                (n0 & ~n1 & ~n2 & ~n3) & case0_ok,
                (~n0 & n1 & ~n2 & ~n3) & case1_ok,
                (~n0 & ~n1 & n2 & ~n3) & case2_ok,
                (~n0 & ~n1 & ~n2 & n3) & case3_ok,
            ],
            [all_case, case0, case1, case2, case3],
            default=np.nan,
        )
        result = round_with_precision(result)
        return result.item() if np.isscalar(lat) else result


class LambertConformalConicProjection:
    """Ported from the bundle's ``LambertConformalConicProjection`` (~L2762)."""

    def __init__(self, projection_data: dict[str, Any]):
        lam0_dec = projection_data["λ0"]
        phi0_dec = projection_data["ϕ0"]
        phi1_dec = projection_data["ϕ1"]
        phi2_dec = projection_data["ϕ2"]
        self.R = projection_data.get("radius") or 6370.997
        self.lam0 = degrees_to_radians((lam0_dec + 180) % 360 - 180)
        phi0 = degrees_to_radians(phi0_dec)
        phi1 = degrees_to_radians(phi1_dec)
        phi2 = degrees_to_radians(phi2_dec)
        if phi1 == phi2:
            self.n = math.sin(phi1)
        else:
            self.n = math.log(math.cos(phi1) / math.cos(phi2)) / math.log(
                math.tan(PI / 4 + phi2 / 2) / math.tan(PI / 4 + phi1 / 2)
            )
        self.F = math.cos(phi1) * math.tan(PI / 4 + phi1 / 2) ** self.n / self.n
        self.rho0 = self.F / math.tan(PI / 4 + phi0 / 2) ** self.n

    def forward(self, latitude: Num, longitude: Num) -> tuple[Num, Num]:
        phi = degrees_to_radians(latitude)
        lam = degrees_to_radians(longitude)
        theta = self.n * (lam - self.lam0)
        p = self.F / np.tan(PI / 4 + phi / 2) ** self.n
        x = self.R * p * np.sin(theta)
        y = self.R * (self.rho0 - p * np.cos(theta))
        return x, y

    def reverse(self, x: Num, y: Num) -> tuple[Num, Num]:
        x_scaled = x / self.R
        y_scaled = y / self.R
        if self.n >= 0:
            theta = np.arctan2(x_scaled, self.rho0 - y_scaled)
        else:
            theta = np.arctan2(-x_scaled, y_scaled - self.rho0)
        sign = 1 if self.n > 0 else -1
        rho = sign * np.sqrt(x_scaled**2 + (self.rho0 - y_scaled) ** 2)
        phi_rad = 2 * np.arctan((self.F / rho) ** (1 / self.n)) - PI / 2
        lam_rad = self.lam0 + theta / self.n
        lam = radians_to_degrees(lam_rad)
        lat = radians_to_degrees(phi_rad)
        lon = np.where(lam > 180, lam - 360, lam)
        return lat, lon


class LambertAzimuthalEqualAreaProjection:
    """Ported from the bundle's ``LambertAzimuthalEqualAreaProjection`` (~L2812)."""

    def __init__(self, projection_data: dict[str, Any]):
        self.lam0 = degrees_to_radians(projection_data["λ0"])
        self.phi1 = degrees_to_radians(projection_data["ϕ1"])
        self.R = projection_data.get("radius") or 6371229

    def forward(self, latitude: Num, longitude: Num) -> tuple[Num, Num]:
        lam = degrees_to_radians(longitude)
        phi = degrees_to_radians(latitude)
        k = np.sqrt(
            2
            / (
                1
                + math.sin(self.phi1) * np.sin(phi)
                + math.cos(self.phi1) * np.cos(phi) * np.cos(lam - self.lam0)
            )
        )
        x = self.R * k * np.cos(phi) * np.sin(lam - self.lam0)
        y = self.R * k * (math.cos(self.phi1) * np.sin(phi) - math.sin(self.phi1) * np.cos(phi) * np.cos(lam - self.lam0))
        return x, y

    def reverse(self, x: Num, y: Num) -> tuple[Num, Num]:
        x = x / self.R
        y = y / self.R
        rho = np.sqrt(x * x + y * y)
        c = 2 * np.arcsin(0.5 * rho)
        phi = np.arcsin(
            np.cos(c) * math.sin(self.phi1) + y * np.sin(c) * math.cos(self.phi1) / rho
        )
        lam = self.lam0 + np.arctan(
            x * np.sin(c) / (rho * math.cos(self.phi1) * np.cos(c) - y * math.sin(self.phi1) * np.sin(c))
        )
        return radians_to_degrees(phi), radians_to_degrees(lam)


_PROJECTIONS = {
    "LambertConformalConicProjection": LambertConformalConicProjection,
    "LambertAzimuthalEqualAreaProjection": LambertAzimuthalEqualAreaProjection,
}


def create_projection(opts: dict[str, Any]):
    name = opts["name"]
    cls = _PROJECTIONS.get(name)
    if cls is None:
        raise ValueError(
            f"unsupported projection {name!r} — only Lambert conformal-conic/"
            "azimuthal are ported (see docs/architecture/weather-grid-port.md)"
        )
    return cls(opts)


class ProjectionGrid:
    """A grid defined in one of the projections above. Ported from the
    bundle's ``ProjectionGrid`` (~L2888)."""

    def __init__(self, data: dict[str, Any], ranges: list[dict[str, int]] | None = None):
        if ranges is None:
            ranges = [{"start": 0, "end": data["ny"]}, {"start": 0, "end": data["nx"]}]
        self.nx = ranges[1]["end"] - ranges[1]["start"]
        self.ny = ranges[0]["end"] - ranges[0]["start"]
        self._bounds: tuple[float, float, float, float] | None = None

        kind = data["type"]
        if kind == "projectedFromBounds":
            self.projection = create_projection(data["projection"])
            sw = self.projection.forward(data["latitudeBounds"][0], data["longitudeBounds"][0])
            ne = self.projection.forward(data["latitudeBounds"][1], data["longitudeBounds"][1])
            self.origin = (sw[0], sw[1])
            self.dx = (ne[0] - sw[0]) / (data["nx"] - 1)
            self.dy = (ne[1] - sw[1]) / (data["ny"] - 1)
        elif kind == "projectedFromGeographicOrigin":
            self.projection = create_projection(data["projection"])
            self.origin = self.projection.forward(data["latitude"], data["longitude"])
            self.dx = data["dx"]
            self.dy = data["dy"]
        elif kind == "projectedFromProjectedOrigin":
            self.projection = create_projection(data["projection"])
            self.origin = (data["projectedLongitudeOrigin"], data["projectedLatitudeOrigin"])
            self.dx = data["dx"]
            self.dy = data["dy"]
        else:
            raise ValueError(f"unknown grid type: {kind!r}")

        self.min_x = self.origin[0] + self.dx * ranges[1]["start"]
        self.min_y = self.origin[1] + self.dy * ranges[0]["start"]

    def get_linear_interpolated_value(self, values: np.ndarray, lat: Num, lon: Num) -> Num:
        idx = self._find_point_interpolated(lat, lon)
        return _interpolate_linear(
            values, idx["x"], idx["y"], idx["x_fraction"], idx["y_fraction"], self.nx
        )

    def _find_point_interpolated(self, lat: Num, lon: Num) -> dict[str, Num]:
        x_pos, y_pos = self.projection.forward(lat, lon)
        x = (x_pos - self.min_x) / self.dx
        y = (y_pos - self.min_y) / self.dy
        x_fraction = x - np.floor(x)
        y_fraction = y - np.floor(y)
        out_of_bounds = (x < 0) | (x >= self.nx) | (y < 0) | (y >= self.ny)
        fx = np.where(out_of_bounds, np.nan, np.floor(x))
        fy = np.where(out_of_bounds, np.nan, np.floor(y))
        xf = np.where(out_of_bounds, 0, x_fraction)
        yf = np.where(out_of_bounds, 0, y_fraction)
        return {"x": fx, "y": fy, "x_fraction": xf, "y_fraction": yf}

    def get_bounds(self) -> tuple[float, float, float, float]:
        if self._bounds is None:
            points = self._projected_border_points()
            self._bounds = self._calculate_geographic_bounds(points)
        return self._bounds

    def _projected_border_points(self) -> list[tuple[float, float]]:
        points: list[tuple[float, float]] = []
        for i in range(self.ny):
            points.append((self.min_x, self.min_y + i * self.dy))
        for i in range(self.nx):
            points.append((self.min_x + i * self.dx, self.min_y + self.ny * self.dy))
        for i in range(self.ny, -1, -1):
            points.append((self.min_x + self.nx * self.dx, self.min_y + i * self.dy))
        for i in range(self.nx, -1, -1):
            points.append((self.min_x + i * self.dx, self.min_y))
        return points

    def _calculate_geographic_bounds(
        self, border_points: list[tuple[float, float]]
    ) -> tuple[float, float, float, float]:
        min_lon, min_lat, max_lon, max_lat = 180.0, 90.0, -180.0, -90.0
        for px, py in border_points:
            lat, lon = self.projection.reverse(px, py)
            lon = (lon + 180) % 360 - 180
            min_lat, max_lat = min(min_lat, lat), max(max_lat, lat)
            min_lon, max_lon = min(min_lon, lon), max(max_lon, lon)
        return (min_lon, min_lat, max_lon, max_lat)


class RegularGrid:
    """A plain lat/lon grid (most global models: GFS, ICON, ...). Ported
    from the bundle's ``RegularGrid`` (~L3099)."""

    def __init__(self, data: dict[str, Any], ranges: list[dict[str, int]] | None = None):
        self.dx = data["dx"]
        self.dy = data["dy"]
        if ranges is None:
            ranges = [{"start": 0, "end": data["ny"]}, {"start": 0, "end": data["nx"]}]
        self.nx = ranges[1]["end"] - ranges[1]["start"]
        self.ny = ranges[0]["end"] - ranges[0]["start"]
        lon_min = data["lonMin"] + self.dx * ranges[1]["start"]
        lat_min = data["latMin"] + self.dy * ranges[0]["start"]
        lon_max = data["lonMin"] + self.dx * ranges[1]["end"]
        lat_max = data["latMin"] + self.dy * ranges[0]["end"]
        self.bounds = (lon_min, lat_min, lon_max, lat_max)
        self.longitude_wrap = bool((lon_max - lon_min) >= 359.875)

    def get_linear_interpolated_value(self, values: np.ndarray, lat: Num, lon: Num) -> Num:
        lon = np.asarray(lon, dtype=np.float64)
        lat = np.asarray(lat, dtype=np.float64)
        west, south, east, north = self.bounds
        out_lon = (not self.longitude_wrap) & ((lon < west) | (lon > east))
        out_lat = (lat < south) | (lat >= north)
        out = out_lon | out_lat

        y = np.floor((lat - south) / self.dy)
        y_fraction = np.mod(lat - south, self.dy) / self.dy
        x = np.minimum(np.floor((lon - west) / self.dx), self.nx - 1)
        dx = np.where(
            self.longitude_wrap & (lon >= east - self.dx), self.dx * 2, self.dx
        )
        x_fraction = np.mod(lon - west, dx) / dx

        result = _interpolate_linear(
            values,
            np.where(out, 0, x),
            np.where(out, 0, y),
            np.where(out, 0, x_fraction),
            np.where(out, 0, y_fraction),
            self.nx,
            self.longitude_wrap,
        )
        result = np.where(out, np.nan, result)
        return result.item() if np.isscalar(lat) or lat.ndim == 0 else result

    def get_bounds(self) -> tuple[float, float, float, float]:
        return self.bounds


@dataclass
class GridFactory:
    """Dispatch on the JSON grid-definition's ``type``. Ported from the
    bundle's ``GridFactory`` (~L3227)."""

    @staticmethod
    def create(data: dict[str, Any], ranges: list[dict[str, int]] | None = None):
        kind = data["type"]
        if kind == "gaussian":
            return GaussianGrid(data, ranges)
        if kind in (
            "projectedFromBounds",
            "projectedFromProjectedOrigin",
            "projectedFromGeographicOrigin",
        ):
            return ProjectionGrid(data, ranges)
        if kind == "regular":
            return RegularGrid(data, ranges)
        raise ValueError(f"unknown grid type: {kind!r}")
