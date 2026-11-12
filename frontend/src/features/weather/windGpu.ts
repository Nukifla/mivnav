// GPU wind-particle simulation, rendered INSIDE the map's own WebGL context as a
// MapLibre CustomLayerInterface. Ported from Vladimir Agafonkin's webgl-wind
// (github.com/mapbox/webgl-wind, ISC licence); adapted to keep particles
// GEO-ANCHORED (absolute mercator state, MVP-matrix draw, reprojected trails).
// See docs/architecture/wind-flow-gpu-model.md for the full model and why.
//
// Pure helpers (sizing, encode/decode, resample, bbox math) are unit-tested;
// the GL path (WindGpuLayer) is not — no WebGL in headless bun — and is
// validated on-device.

import type { Map as MLMap, CustomLayerInterface, CustomRenderMethodInput } from "maplibre-gl";

// ── Encoding / sizing (pure) ─────────────────────────────────────────────────

/** Full-scale wind magnitude, m/s, that the wind-texture RG channels map to.
 *  40 m/s (~78 kn) clears any plausible marine wind so the encoding never
 *  clips; the visual speed CAP is a separate shader uniform applied after decode. */
export const WIND_ENCODE_MAX = 40;

/** Wind-texture resolution per axis. The source grid is smooth at km scales,
 *  so 128² resolves it far finer than it varies; power-of-two for LINEAR filtering. */
export const WIND_TEX_RESOLUTION = 128;

/** Side length of the square particle-STATE texture holding `count` particles:
 *  `ceil(sqrt(count))`, so `side²` ≥ count (the tail few are harmless extras). */
export function particleStateSize(count: number): number {
  return Math.ceil(Math.sqrt(Math.max(1, count)));
}

/** Encode a signed value in [−max, max] to a [0,1] channel (webgl-wind's
 *  `mix` inverse), clamped so out-of-range saturates rather than wraps. */
export function encodeSignedUnit(value: number, max: number): number {
  const t = value / (2 * max) + 0.5;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Decode a [0,1] channel back to a signed value in [−max, max]. */
export function decodeSignedUnit(unit: number, max: number): number {
  return (unit - 0.5) * 2 * max;
}

/** Cell-grid resolution for the FLOAT_STATE position split (integer cell + float
 *  fraction, killing the high-zoom precision-grid bug) — see
 *  docs/architecture/wind-flow-gpu-model.md "Position precision". 2048 keeps the
 *  combined cell index exact in float32 (2048² « 2^24). */
export const POS_CELL = 2048;

/** Split an absolute mercator [0,1]² coordinate into the FLOAT_STATE texel payload
 *  (cell + fraction — see `POS_CELL`). `UPDATE_FS`'s `encodePosLife` must stay
 *  bit-for-bit in step with this. */
export function encodeFloatMerc(x: number, y: number): { fracX: number; fracY: number; cell: number } {
  const cellX = Math.floor(x * POS_CELL);
  const cellY = Math.floor(y * POS_CELL);
  return { fracX: x * POS_CELL - cellX, fracY: y * POS_CELL - cellY, cell: cellX * POS_CELL + cellY };
}

/** Inverse of `encodeFloatMerc`. */
export function decodeFloatMerc(fracX: number, fracY: number, cell: number): { x: number; y: number } {
  const cellX = Math.floor(cell / POS_CELL);
  const cellY = cell - cellX * POS_CELL;
  return { x: (cellX + fracX) / POS_CELL, y: (cellY + fracY) / POS_CELL };
}

/** A wind vector in m/s: `u` eastward, `v` northward (geographic). */
export interface WindVector {
  u: number;
  v: number;
}

/** Cap a wind vector's MAGNITUDE to `cap` m/s, preserving direction — the
 *  reference for the identical clamp the update shader applies after decode. */
export function capWindVector(u: number, v: number, cap: number): WindVector {
  const mag = Math.hypot(u, v);
  if (mag <= cap || mag === 0) return { u, v };
  const s = cap / mag;
  return { u: u * s, v: v * s };
}

/** Web-mercator [0,1]² for a lng/lat, matching `MercatorCoordinate.fromLngLat`
 *  (y = 0 at the NORTH edge; mercator y grows south). Latitude clamped to the
 *  mercator limit so the poles don't blow up. */
export function lngLatToMercator(lng: number, lat: number): { x: number; y: number } {
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat));
  const x = (lng + 180) / 360;
  const s = Math.sin((clamped * Math.PI) / 180);
  const y = 0.5 - (0.25 * Math.log((1 + s) / (1 - s))) / Math.PI;
  return { x, y };
}

/**
 * Intersect the current (overscanned) viewport bbox with the wind grid bbox —
 * the region the WIND TEXTURE is resampled over — returning `null` when they
 * don't overlap. Resampling over this small region rather than the whole
 * model grid gives a sailing-zoom viewport a full `WIND_TEX_RESOLUTION`² of detail.
 */
export function viewportParticleBounds(
  viewport: [number, number, number, number],
  grid: [number, number, number, number],
): [number, number, number, number] | null {
  const minLng = Math.max(viewport[0], grid[0]);
  const minLat = Math.max(viewport[1], grid[1]);
  const maxLng = Math.min(viewport[2], grid[2]);
  const maxLat = Math.min(viewport[3], grid[3]);
  if (minLng >= maxLng || minLat >= maxLat) return null;
  return [minLng, minLat, maxLng, maxLat];
}

/**
 * Pad a viewport bbox outward by `frac` of its own span, so the off-screen
 * margin has wind data to feed the incoming edge. Must stay in lock-step with
 * the layer's `overscan` opt (same fraction; windFlow owns both). */
export function overscanViewport(
  viewport: [number, number, number, number],
  frac: number,
): [number, number, number, number] {
  const [minLng, minLat, maxLng, maxLat] = viewport;
  const padLng = (maxLng - minLng) * frac;
  const padLat = (maxLat - minLat) * frac;
  return [minLng - padLng, minLat - padLat, maxLng + padLng, maxLat + padLat];
}

// ── Wind resample (pure) ─────────────────────────────────────────────────────

/** A geographic wind sampler: the vector at a lng/lat, or `null` off-grid / no data
 *  (that texel becomes a no-data hole). */
export type GeoWindSampler = (lng: number, lat: number) => WindVector | null;

/** The equirectangular wind texture. `data` is row-major `rows×cols`, row 0 at
 *  the SOUTH edge so texture v grows north, matching the particle field's
 *  normalized-y. RG = encoded u/v, A = data mask (0 → respawn hole). */
export interface WindTexture {
  data: Uint8Array;
  cols: number;
  rows: number;
  bounds: [number, number, number, number];
  encodeMax: number;
}

/**
 * Resample a geographic wind field into an equirectangular RGBA8 texture over
 * `bounds`, sampled once per source/viewport change so the hot update shader
 * only ever reads a plain lng/lat-linear texture. Off-grid nodes store A = 0.
 */
export function resampleWindToEquirect(
  sampler: GeoWindSampler,
  bounds: [number, number, number, number],
  cols: number,
  rows: number,
  encodeMax: number = WIND_ENCODE_MAX,
): WindTexture {
  const [minLng, minLat, maxLng, maxLat] = bounds;
  const data = new Uint8Array(cols * rows * 4);
  const spanLng = maxLng - minLng;
  const spanLat = maxLat - minLat;
  for (let j = 0; j < rows; j++) {
    // Row 0 = minLat (south) so texture v grows north; ny in [0,1].
    const lat = minLat + (rows === 1 ? 0 : (j / (rows - 1)) * spanLat);
    for (let i = 0; i < cols; i++) {
      const lng = minLng + (cols === 1 ? 0 : (i / (cols - 1)) * spanLng);
      const w = sampler(lng, lat);
      const k = (j * cols + i) * 4;
      if (w) {
        data[k] = Math.round(encodeSignedUnit(w.u, encodeMax) * 255);
        data[k + 1] = Math.round(encodeSignedUnit(w.v, encodeMax) * 255);
        data[k + 2] = 0;
        data[k + 3] = 255; // has data
      } else {
        data[k] = data[k + 1] = data[k + 2] = data[k + 3] = 0; // no-data hole
      }
    }
  }
  return { data, cols, rows, bounds, encodeMax };
}

// ── Wind TILE mosaic sampling ────────────────────────────────────────────────
// Server-rendered slippy tiles, wrapped as a `GeoWindSampler` so the existing
// `resampleWindToEquirect` above still builds the texture the shader expects.
// See "Projection correctness" in docs/architecture/wind-flow-gpu-model.md.

/** One decoded wind tile: raw RGBA8 pixels, standard top-down row order
 *  from a canvas/ImageBitmap decode. */
export interface WindTile {
  size: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** The `{z, x, y}` slippy-tile index containing `(lng, lat)`, via the same
 *  mercator projection a standard XYZ tile server uses. Clamped into
 *  `[0, 2^z − 1]` so a latitude at the mercator limit still resolves. */
export function tileIndex(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const { x: mx, y: my } = lngLatToMercator(lng, lat);
  const clamp = (v: number) => Math.max(0, Math.min(n - 1, v));
  return { x: clamp(Math.floor(mx * n)), y: clamp(Math.floor(my * n)) };
}

/**
 * Wrap a decoded tile MOSAIC as a `GeoWindSampler`: nearest-texel, no
 * interpolation (the tiles are already a coarse render). `null` for an
 * unfetched or no-data tile. Row-order CONTRACT with the backend PNG (row 0 =
 * south) — see docs/architecture/wind-flow-gpu-model.md "Wind tile row order".
 */
export function tileWindSampler(
  mosaic: ReadonlyMap<string, WindTile>,
  zoom: number,
  encodeMax: number = WIND_ENCODE_MAX,
): GeoWindSampler {
  const n = 2 ** zoom;
  return (lng, lat) => {
    const { x: mx, y: my } = lngLatToMercator(lng, lat);
    const txf = mx * n;
    const tyf = my * n;
    const tx = Math.floor(txf);
    const ty = Math.floor(tyf);
    const tile = mosaic.get(`${tx},${ty}`);
    if (!tile) return null;
    const { size, data } = tile;
    const fx = Math.min(1, Math.max(0, txf - tx));
    const fyNorthDown = Math.min(1, Math.max(0, tyf - ty)); // 0 at the tile's north edge
    const px = Math.min(size - 1, Math.floor(fx * size));
    // Row 0 = south (see doc above) ⇒ invert the north-down fraction.
    const py = Math.min(size - 1, Math.floor((1 - fyNorthDown) * size));
    const k = (py * size + px) * 4;
    const a = data[k + 3]!;
    if (a < 128) return null;
    return {
      u: decodeSignedUnit(data[k]! / 255, encodeMax),
      v: decodeSignedUnit(data[k + 1]! / 255, encodeMax),
    };
  };
}

// ── Shaders ──────────────────────────────────────────────────────────────────
// GLSL ES 1.00, ported/adapted from webgl-wind's quad/screen/update/draw shaders.
//
// VARYING PRECISION IS PINNED BY `VPREC`, INJECTED FROM JS (`precisionDefs`) —
// never replace it with a literal qualifier in one stage; a vertex/fragment
// precision mismatch can fail to LINK on a mobile driver with no error beyond
// "no particles". See docs/architecture/wind-flow-gpu-model.md "Shader precision".

/** Fullscreen-quad vertex shader (webgl-wind's quad.vert), used by the update and
 *  screen-copy passes. `a_pos` is a unit-square corner in [0,1]. */
const QUAD_VS = `
// mediump is fine (provably fp16-safe): a_pos ∈ [0,1] and gl_Position stays in
// [-1,1] — no packed-position reassembly here. Unlike DRAW_VS below. The
// VARYING is VPREC, not the default: it must match the fragment stage that
// reads it (see the note above the shaders).
precision mediump float;
attribute vec2 a_pos;
varying VPREC vec2 v_tex_pos;
void main() {
  v_tex_pos = a_pos;
  gl_Position = vec4(1.0 - 2.0 * a_pos, 0.0, 1.0);
}`;

/** Screen-copy fragment shader (webgl-wind's screen.frag, adapted with trail
 *  REPROJECTION): draws a screen texture scaled by `u_opacity`, sampling at a
 *  reprojected coord (`u_reproj_scale`/`offset`) so trails stay glued to the
 *  water as the camera moves; identity at rest. See "Trail reprojection" in
 *  docs/architecture/wind-flow-gpu-model.md. */
const SCREEN_FS = `
// highp in a FRAGMENT shader is optional per the GLSL ES / WebGL spec (unlike a
// vertex shader, where it's always guaranteed) — GL_FRAGMENT_PRECISION_HIGH is
// the standard feature-detect macro for it. Guarded defensively: current mobile
// Chrome/Android reports fragment highp support, so this is expected to be a
// no-op there, but an unconditional \`precision highp float\` risks a compile
// failure on hardware that lacks it, and \`link()\` throwing surfaces only as
// "particles don't render" (see windFlow.ts's placeLayer, which now at least
// logs it). mediump here just re-admits the pan-offset jitter the doc comment
// above describes — degraded, not broken. VPREC carries exactly that verdict,
// decided in JS (getShaderPrecisionFormat) so the VERTEX stage can be told it
// too — GL_FRAGMENT_PRECISION_HIGH cannot cross stages. See the note above.
precision VPREC float;
uniform sampler2D u_screen;
uniform float u_opacity;
uniform vec2 u_reproj_scale;
uniform vec2 u_reproj_offset;
varying VPREC vec2 v_tex_pos;
void main() {
  vec2 st = (1.0 - v_tex_pos) * u_reproj_scale + u_reproj_offset;
  // A pan/zoom can reproject part of the current viewport to a point outside
  // the previous frame's [0,1] extent — there is no trail data for area the
  // camera just revealed. u_screen is CLAMP_TO_EDGE (required for a NPOT
  // FBO texture), so an unguarded sample out here repeats the nearest edge
  // texel across the whole newly-exposed strip: a streak in the pan direction.
  // Treat out-of-bounds as no trail (transparent) instead of clamping.
  bool inBounds = st.x >= 0.0 && st.x <= 1.0 && st.y >= 0.0 && st.y <= 1.0;
  vec4 color = inBounds ? texture2D(u_screen, st) : vec4(0.0);
  // opacity a bit lower to avoid streak accumulation over time (webgl-wind trick):
  // floor keeps the fade from stalling at low alpha due to 8-bit rounding.
  gl_FragColor = vec4(floor(255.0 * color * u_opacity) / 255.0);
}`;

/** Particle-update fragment shader (webgl-wind's update.frag, adapted): decodes
 *  the absolute-mercator position (FLOAT cell+frac or RGBA8 fallback — see
 *  `POS_CELL`), samples wind, advects at a zoom-independent screen pace, and
 *  respawns via a fade (`life` goes negative, then teleports at zero alpha) —
 *  see docs/architecture/wind-flow-gpu-model.md "Position precision" / "Trail
 *  reprojection". */
const UPDATE_FS = `
// highp is REQUIRED for correctness: positions are absolute web-mercator and
// advection accumulates tiny per-frame steps; in the RGBA8 fallback they are
// 16-bit packed and reassembled here. fp16's ~11-bit mantissa would quantise the
// position enough to stair-step and stall. Do NOT drop to mediump on purpose.
//
// That said, highp is only OPTIONAL in a fragment shader per the GLSL ES / WebGL
// spec (GL_FRAGMENT_PRECISION_HIGH is the feature-detect macro) — an
// unconditional \`precision highp float\` can fail to COMPILE on hardware that
// doesn't support it, and link() throwing surfaces only as "particles don't
// render at all" (see windFlow.ts's placeLayer, which now at least logs it).
// A stalled-but-visible field beats an invisible one, so this falls back to
// mediump rather than dying, even though it reintroduces the stair-step above.
// VPREC is that verdict, decided in JS (getShaderPrecisionFormat) so the VERTEX
// stage sharing this program's varying can be given the SAME qualifier —
// GL_FRAGMENT_PRECISION_HIGH cannot cross stages. See the note above the shaders.
precision VPREC float;
uniform sampler2D u_particles;
uniform sampler2D u_wind;
uniform float u_rand_seed;
uniform vec2 u_pos_base;       // storage decode base  (FLOAT: 0)
uniform vec2 u_pos_scale;      // storage decode scale (FLOAT: 1)
uniform vec4 u_wind_bbox;      // wind-texture geo bbox: minLng, minLat, maxLng, maxLat
uniform vec2 u_wind_bbox_span; // maxLng-minLng, maxLat-minLat
uniform vec4 u_view_merc;      // viewport+margin in mercator: minX, minY, maxX, maxY
uniform float u_encode_max;    // m/s full-scale for RG decode
uniform float u_speed_cap;     // m/s advection cap
uniform float u_advect;        // mercator step per (m/s): advectScreenGain·dt·viewportMercHeight
uniform float u_drop_rate;
uniform float u_drop_rate_bump;
uniform float u_zoom_bump;     // extra respawn probability this frame from an active zoom-out
uniform float u_fade_rate;     // life delta per second (fade duration ≈ 1/u_fade_rate s)
uniform float u_dt;
varying VPREC vec2 v_tex_pos;
#define PI 3.141592653589793
const float POS_CELL = 2048.0; // must match windGpu.ts's POS_CELL

const vec3 rand_constants = vec3(12.9898, 78.233, 4375.85453);
float rand(const vec2 co) {
  float t = dot(rand_constants.xy, co);
  return fract(sin(t) * (rand_constants.z + t));
}

// Decode the stored texel ⇄ absolute web-mercator via base/scale (FLOAT mode uses
// base 0 / scale 1, so it is absolute; the RGBA8 fallback normalizes into the current
// viewport for 16-bit precision, which is what reintroduces the snap). FLOAT_STATE
// splits each axis into an integer CELL (combined into one float, z) plus a FRACTION
// within that cell (x, y) — see POS_CELL — so the mantissa is spent on the small
// fraction rather than the whole [0,1] world, buying a further POS_CELL× of position
// precision. The RGBA8 fallback has no spare channel, so life is always 1 there.
vec2 decodePos(vec4 t) {
#ifdef FLOAT_STATE
  float cellX = floor(t.z / POS_CELL);
  float cellY = t.z - cellX * POS_CELL;
  vec2 s = (vec2(cellX, cellY) + t.xy) / POS_CELL;
#else
  vec2 s = vec2(t.r / 255.0 + t.b, t.g / 255.0 + t.a);
#endif
  return u_pos_base + s * u_pos_scale;
}
float decodeLife(vec4 t) {
#ifdef FLOAT_STATE
  return t.w;
#else
  return 1.0;
#endif
}
vec4 encodePosLife(vec2 merc, float life) {
  vec2 s = (merc - u_pos_base) / u_pos_scale;
#ifdef FLOAT_STATE
  vec2 scaled = s * POS_CELL;
  vec2 cell = floor(scaled);
  vec2 frac = scaled - cell;
  return vec4(frac, cell.x * POS_CELL + cell.y, life);
#else
  return vec4(fract(s * 255.0), floor(s * 255.0) / 255.0);
#endif
}

void main() {
  vec4 stored = texture2D(u_particles, v_tex_pos);
#ifdef FLOAT_STATE
  // Keep cell + fraction SEPARATE for the advection step below — merging them into
  // merc (as decodePos does) and doing arithmetic on THAT is exactly what defeats
  // the split: merc is an ordinary highp (float32) variable once formed, so
  // "merc + dMerc" loses precision at merc's OWN magnitude (~2^-24, same cliff as
  // storing raw [0,1] directly), no matter how precisely it was decoded. Wind
  // sampling below doesn't need that precision, so it uses the coarse merged
  // merc — only the WRITE-BACK path (bottom of main) uses cell/frac directly.
  float cellX = floor(stored.z / POS_CELL);
  float cellY = stored.z - cellX * POS_CELL;
  vec2 cell = vec2(cellX, cellY);
  vec2 frac = stored.xy;
#endif
  vec2 merc = decodePos(stored); // coarse merged value — fine for sampling/bounds only
  float life = decodeLife(stored);

  // mercator → lng/lat → normalize into the wind-texture geo bbox (row 0 = south).
  float lng = merc.x * 360.0 - 180.0;
  float lat = degrees(2.0 * atan(exp((0.5 - merc.y) * 2.0 * PI)) - PI * 0.5);
  vec2 wpos = vec2((lng - u_wind_bbox.x) / u_wind_bbox_span.x,
                   (lat - u_wind_bbox.y) / u_wind_bbox_span.y);
  vec4 w = texture2D(u_wind, wpos);
  float hasData = step(0.5, w.a);
  vec2 vel = vec2((w.r - 0.5) * 2.0 * u_encode_max,
                  (w.g - 0.5) * 2.0 * u_encode_max);
  float mag = length(vel);
  if (mag > u_speed_cap && mag > 0.0) vel *= u_speed_cap / mag;
  float speed_t = mag / u_encode_max;

  vec2 seed = (merc + v_tex_pos) * u_rand_seed;

  // Sinusoidal jiggle: a small perpendicular wobble so straight-line advection
  // through a locally-uniform wind cell doesn't read as dead-straight parallel
  // streamlines. Low frequency (a handful of waves across the viewport) is
  // deliberate — a high multiplier here (this used to be 10000, ~1600 cycles across
  // the screen) bakes a FIXED, viewport-locked lattice into the velocity field
  // itself: every particle samples the same static high-frequency pattern as it
  // drifts through, which reads as particles snapping to a grid — worse at high
  // zoom, where particles move slowly enough (in screen-pace terms) to sit in one
  // lattice cell long enough to resolve it. That's a different bug from (and
  // unaffected by) the float32 position-precision fix in encodePosLife/decodePos.
  float phase = rand(v_tex_pos);
  float s = sin(length(wpos) * 20.0 + phase);

  vel = vel + vec2(-vel.y, vel.x) * s * 0.01;

  // advect in mercator, zoom-INDEPENDENT screen pace: u_advect already folds
  // advectScreenGain·dt·viewportMercHeight, so vel·u_advect is a fixed fraction of the
  // viewport per (m/s) regardless of zoom. NORTH (+v) is −mercator-y (mercator y grows
  // south). Mercator is conformal and ·worldSize is square pixels, so equal wind ⇒
  // equal screen px in x and y with NO aspect term.
  vec2 dMerc = (vec2(vel.x, -vel.y)) * u_advect;

  // Wants to respawn: random age-out (bumped in fast cells, and during an active
  // zoom-out via u_zoom_bump — see WindGpuLayer.updateStep — so density stays right
  // instead of clumping into the shrinking on-screen footprint of the old viewport), a
  // no-data hole, or drifted outside the viewport+margin.
  float drop_rate = u_drop_rate + speed_t * u_drop_rate_bump + u_zoom_bump;
  float dropRoll = step(1.0 - drop_rate, rand(seed));
  float inView = step(u_view_merc.x, merc.x) * step(merc.x, u_view_merc.z)
               * step(u_view_merc.y, merc.y) * step(merc.y, u_view_merc.w);
  float wantsDrop = max(dropRoll, max(1.0 - hasData, 1.0 - inView));
  vec2 respawn = mix(u_view_merc.xy, u_view_merc.zw, vec2(rand(seed + 1.3), rand(seed + 2.1)));

  // Fade state machine: life > 0 is stable/fading-in (alpha = life), life < 0 is
  // fading-out toward a respawn (alpha = -life). A drop request while stable/fading-in
  // reflects life negative to start the fade-out from whatever alpha it's currently at
  // (continuous — no pop), then each frame life steps toward 0 by u_fade_rate·u_dt
  // while the particle keeps ADVECTING normally. Only the frame life crosses zero
  // teleports it to the respawn point — alpha is ~0 there, so the jump is invisible —
  // and fading-in (life 0→1) begins from that frame.
  if (life > 0.0 && wantsDrop > 0.5) life = -life;
  float fadeStep = u_fade_rate * u_dt;
  float newLife;
  bool teleport = false;
  if (life < 0.0) {
    newLife = life + fadeStep;
    teleport = newLife >= 0.0;
  } else {
    newLife = min(1.0, life + fadeStep);
  }

#ifdef FLOAT_STATE
  // Advect the FRACTION directly (small + small = small, still precise) rather than
  // "merc + dMerc" then re-splitting — see the comment at the top of main(). floor()
  // carries a cell-boundary crossing into the (exact, small-integer) cell index. A
  // teleport re-derives cell/frac fresh from "respawn" — a brand-new random point,
  // so there's no prior precision to preserve.
  vec2 newCell;
  vec2 newFrac;
  if (teleport) {
    vec2 rs = clamp(respawn, 0.0, 1.0) * POS_CELL;
    newCell = floor(rs);
    newFrac = rs - newCell;
  } else {
    vec2 dFrac = dMerc * POS_CELL;
    vec2 rawFrac = frac + dFrac;
    vec2 cellStep = floor(rawFrac);
    newFrac = rawFrac - cellStep;
    newCell = cell + cellStep;
  }
  gl_FragColor = vec4(newFrac, newCell.x * POS_CELL + newCell.y, newLife);
#else
  vec2 newMerc = teleport ? respawn : merc + dMerc;
  gl_FragColor = encodePosLife(newMerc, newLife);
#endif
}`;

/** Particle-draw vertex shader. Projects the particle's absolute mercator
 *  position to clip space via a per-frame reference-cell trick (`u_ref_cell`/
 *  `u_ref_clip_offset`, computed CPU-side in `drawParticles`) rather than a
 *  plain `u_matrix·(merc·u_world_size)`, which would re-quantise at chart
 *  zooms — see "Draw-time precision" in docs/architecture/wind-flow-gpu-model.md. */
const DRAW_VS = `
// highp is REQUIRED, not stylistic: this shader multiplies web-mercator-scale
// coordinates by u_world_size (512·2^zoom, up to ~1e9 at high chart zooms). mediump on
// a real mobile GPU is fp16 (max 65504), so mx·worldSize overflows to Inf → gl_Position
// is Inf → every point is clipped → blank screen. (Desktop ANGLE/SwiftShader silently
// promote mediump→fp32 and hide this.) Do NOT "tidy" this back to mediump.
precision highp float;
attribute float a_index;
uniform sampler2D u_particles;
uniform float u_particles_res;
uniform vec2 u_pos_base;        // storage decode base  (FLOAT: 0) — fallback path only
uniform vec2 u_pos_scale;       // storage decode scale (FLOAT: 1) — fallback path only
uniform mat4 u_matrix;          // modelViewProjectionMatrix (mercator·worldSize → clip)
uniform float u_world_size;     // transform.worldSize = 512·2^zoom
uniform float u_point_size;
uniform vec2 u_ref_cell;        // FLOAT_STATE only: reference cell, see drawParticles
uniform vec4 u_ref_clip_offset; // FLOAT_STATE only: CPU (double-precision) clip offset of u_ref_cell
varying VPREC float v_life;     // VPREC, not the stage default — must match DRAW_FS
const float POS_CELL = 2048.0; // must match windGpu.ts's POS_CELL
float decodeLife(vec4 t) {
#ifdef FLOAT_STATE
  return t.w;
#else
  return 1.0;
#endif
}
void main() {
  vec4 color = texture2D(u_particles, vec2(
    fract(a_index / u_particles_res),
    floor(a_index / u_particles_res) / u_particles_res));
  // life is SIGNED (negative while fading out, see UPDATE_FS's state machine) —
  // alpha is its magnitude; using it unsigned would clip to 0 the instant a
  // respawn starts (fading out ⇒ negative ⇒ clamps invisible) instead of dimming.
  v_life = abs(decodeLife(color));
  gl_PointSize = u_point_size;
#ifdef FLOAT_STATE
  float cellX = floor(color.z / POS_CELL);
  float cellY = color.z - cellX * POS_CELL;
  vec2 deltaCell = vec2(cellX, cellY) - u_ref_cell; // small: on/near-screen particles share u_ref_cell's cell
  vec2 local = (deltaCell + color.xy) / POS_CELL;   // small delta, in world-normalized units
  gl_Position = u_matrix * vec4(local * u_world_size, 0.0, 0.0) + u_ref_clip_offset;
#else
  vec2 s = vec2(color.r / 255.0 + color.b, color.g / 255.0 + color.a);
  vec2 merc = u_pos_base + s * u_pos_scale;
  gl_Position = u_matrix * vec4(merc * u_world_size, 0.0, 1.0);
#endif
}`;

/** Particle-draw fragment shader: a soft round white dot, dimmed by `v_life`
 *  (fade in/out) and `u_alpha`. Output is premultiplied to match the layer's
 *  `ONE, ONE_MINUS_SRC_ALPHA` blend; the trail itself comes from the
 *  framebuffer fade, not geometry. */
const DRAW_FS = `
precision mediump float;
uniform float u_alpha;
varying VPREC float v_life; // VPREC, not the stage default — must match DRAW_VS
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float a = 1.0 - smoothstep(0.35, 0.5, length(d));
  gl_FragColor = vec4(1.0) * (a * v_life * u_alpha);
}`;

// ── GL helpers ───────────────────────────────────────────────────────────────

type GL = WebGLRenderingContext | WebGL2RenderingContext;

// ── Capability probe / diagnostics ───────────────────────────────────────────
// "Particles don't render on Android" with a clean console was unactionable —
// every mobile-GL failure mode here fails silently. Probe everything up front
// and report it once (also on `globalThis.__mivnavWindGpu` for remote
// debugging). See "Capability probing" in docs/architecture/wind-flow-gpu-model.md.

/** What the GL stack under this layer can actually do. Logged once per `onAdd`
 *  and retrievable via `windGpuCaps()` — this is the payload to ask a user for
 *  when particles don't render. */
export interface WindGpuCaps {
  webgl2: boolean;
  /** `WEBGL_debug_renderer_info` strings, when the browser exposes them (Chrome
   *  does on Android; Firefox may not — `null` is not itself a fault). */
  vendor: string | null;
  renderer: string | null;
  maxTextureSize: number;
  /** Vertex-stage texture units. **< 1 is fatal** — see the note above. */
  maxVertexTextureUnits: number;
  pointSizeRange: [number, number];
  /** `EXT_color_buffer_float` — makes RGBA32F color-renderable (the ping-pong
   *  target). Absent ⇒ the degraded RGBA8 path, not a failure. */
  colorBufferFloat: boolean;
  /** Mantissa bits of `highp` in the FRAGMENT stage; 0 ⇒ unsupported, so
   *  UPDATE_FS compiles at mediump and position accumulation stair-steps. */
  fragmentHighFloatPrecision: number;
  drawingBuffer: [number, number];
  /** Set after the RGBA32F framebuffer-completeness probe: what the layer
   *  actually ended up using. `null` before the probe runs. */
  floatState: boolean | null;
  /** Human-readable reasons the layer is degraded or dead, in order. Empty ⇒
   *  every capability it wants is present. */
  problems: string[];
}

let lastCaps: WindGpuCaps | null = null;

/** The last capability probe, or `null` if the layer was never added. Exposed
 *  so a bug report can carry it — also mirrored onto
 *  `globalThis.__mivnavWindGpu`. */
export function windGpuCaps(): WindGpuCaps | null {
  return lastCaps;
}

function probeCaps(gl: GL): WindGpuCaps {
  const webgl2 =
    typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
  const dbg = gl.getExtension("WEBGL_debug_renderer_info") as {
    UNMASKED_VENDOR_WEBGL: number;
    UNMASKED_RENDERER_WEBGL: number;
  } | null;
  const ptSize = (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) ?? [1, 1]) as
    | Float32Array
    | number[];
  const highp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  const caps: WindGpuCaps = {
    webgl2,
    vendor: dbg ? (gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) as string) : null,
    renderer: dbg ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string) : null,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxVertexTextureUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) as number,
    pointSizeRange: [ptSize[0] ?? 1, ptSize[1] ?? 1],
    // Only meaningful (and only queried) on WebGL2 — the WebGL1 name exists but
    // the extension that makes RGBA32F renderable there is a different one, and
    // this layer's float path is WebGL2-only regardless.
    colorBufferFloat: webgl2 && !!gl.getExtension("EXT_color_buffer_float"),
    fragmentHighFloatPrecision: highp ? highp.precision : 0,
    drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    floatState: null,
    problems: [],
  };
  caps.problems = capProblems(caps);
  return caps;
}

/** Turn a capability probe into the list of things that will make particles
 *  look wrong or absent, worst first ("FATAL" = won't work at all). Pure, so
 *  it is unit-tested against synthetic capability sets (no WebGL headless). */
export function capProblems(caps: WindGpuCaps): string[] {
  const out: string[] = [];
  if (caps.maxVertexTextureUnits < 1) {
    out.push(
      "FATAL: MAX_VERTEX_TEXTURE_IMAGE_UNITS is 0 — this GPU cannot sample a texture in " +
        "the VERTEX shader, which is how every particle reads its own position. Nothing " +
        "will render. (WebGL1's guaranteed minimum is 0; WebGL2 always gives at least 16.)",
    );
  }
  const [w, h] = caps.drawingBuffer;
  if (w > caps.maxTextureSize || h > caps.maxTextureSize) {
    out.push(
      `FATAL-unless-clamped: drawing buffer ${w}×${h} exceeds MAX_TEXTURE_SIZE ` +
        `${caps.maxTextureSize} — the screen-sized trail framebuffer cannot be allocated ` +
        "at full size (trails are rendered at reduced resolution instead).",
    );
  }
  if (!caps.webgl2) {
    out.push(
      "degraded: no WebGL2 context — particle positions fall back to 16-bit packed, " +
        "viewport-relative storage (expect a high-zoom precision grid and a gesture-end snap).",
    );
  } else if (!caps.colorBufferFloat) {
    out.push(
      "degraded: EXT_color_buffer_float missing — RGBA32F is not color-renderable, so the " +
        "same 16-bit packed fallback applies.",
    );
  }
  if (caps.fragmentHighFloatPrecision === 0) {
    out.push(
      "degraded: no highp in the fragment stage — the update shader runs at mediump, so " +
        "particle positions accumulate in fp16 and the flow stair-steps or stalls.",
    );
  }
  return out;
}

/** Log the probe once per `onAdd` and stash it where a phone's console can read
 *  it back. Problems go out at `error`/`warn` level so they survive a filtered
 *  console; the full capability set goes out at `info` so a bug report can carry
 *  it wholesale. */
function reportCaps(caps: WindGpuCaps): void {
  lastCaps = caps;
  (globalThis as { __mivnavWindGpu?: WindGpuCaps }).__mivnavWindGpu = caps;
  console.info("windGpu: GL capabilities (paste this into a bug report)", caps);
  for (const p of caps.problems) {
    if (p.startsWith("FATAL:")) console.error(`windGpu: ${p}`);
    else console.warn(`windGpu: ${p}`);
  }
}

/** The `#define VPREC …` prefix prepended to every shader stage of every
 *  program, so a vertex/fragment pair can never disagree on a varying's
 *  precision (see the note above the shaders). `highp` iff the fragment
 *  stage supports it — the vertex stage always supports both. */
export function precisionDefs(fragmentHighFloatPrecision: number): string {
  return `#define VPREC ${fragmentHighFloatPrecision > 0 ? "highp" : "mediump"}\n`;
}

/** Clamp a drawing-buffer size to MAX_TEXTURE_SIZE: an over-size trail FBO
 *  texture is INCOMPLETE and kills every pass, so clamping trades trail
 *  resolution (the final blit still lands 1:1) for the layer working at all. */
export function clampScreenSize(w: number, h: number, maxTextureSize: number): [number, number] {
  const max = maxTextureSize > 0 ? maxTextureSize : Math.max(w, h);
  return [Math.max(1, Math.min(w, max)), Math.max(1, Math.min(h, max))];
}

function compile(gl: GL, type: number, src: string, label: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  // Check COMPILE_STATUS and surface the info log: a rejected shader otherwise
  // links to a silently inert program (a blank layer with no error) — which is
  // exactly how the mediump-DRAW_VS precision bug shipped unnoticed.
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`windGpu: ${label} shader failed to compile: ${log}`);
  }
  return sh;
}

function link(gl: GL, vs: string, fs: string, label: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs, `${label}.vert`));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs, `${label}.frag`));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`windGpu: ${label} program failed to link: ${log}`);
  }
  return p;
}

function emptyTexture(gl: GL, w: number, h: number, filter: number): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return tex;
}

function dataTexture(gl: GL, w: number, h: number, data: Uint8Array, filter: number): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return tex;
}

/** The particle-STATE texture: RGBA32F ping-pong target when `float`, else
 *  the RGBA8 16-bit-packed fallback. Always NEAREST (no state interpolation). */
function stateTexture(
  gl: GL,
  side: number,
  data: Float32Array | Uint8Array,
  float: boolean,
): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  if (float) {
    const gl2 = gl as WebGL2RenderingContext;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl2.RGBA32F, side, side, 0, gl.RGBA, gl.FLOAT, data as Float32Array);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, side, side, 0, gl.RGBA, gl.UNSIGNED_BYTE, data as Uint8Array);
  }
  return tex;
}

// ── The custom layer ─────────────────────────────────────────────────────────

/** FLOAT_STATE's `posEncoding()` is always this exact (identity) value — a single
 *  shared constant instead of a fresh `{base,scale}` object (with two fresh arrays)
 *  allocated on every call (twice a frame). See `WindGpuLayer.posEncoding`. */
const IDENTITY_POS_ENCODING: { base: [number, number]; scale: [number, number] } = {
  base: [0, 0],
  scale: [1, 1],
};

export interface WindGpuOptions {
  id: string;
  particleCount: number;
  /** Overlay opacity — `u_alpha` in DRAW_FS. */
  alpha: number;
  fade: number;
  pointSize: number;
  speedCap: number;
  /** Fraction of viewport HEIGHT a particle advances per (m/s) per second,
   *  zoom-independent (scaled by viewport mercator height in the shader). */
  advectScreenGain: number;
  /** Seed/respawn margin as a fraction of viewport size; must stay in
   *  lock-step with windFlow's wind-resample padding (same fraction). */
  overscan: number;
  dropRate: number;
  dropRateBump: number;
  /** Gain on the continuous zoom-out density correction — see "Trail
   *  reprojection" in docs/architecture/wind-flow-gpu-model.md. 0 disables it. */
  zoomBumpGain: number;
  /** Fade rate, life units/second, for the respawn fade in UPDATE_FS. Only
   *  takes effect in FLOAT_STATE mode (RGBA8 fallback teleports instantly). */
  fadeRate: number;
  /** Pause predicate: while true, `render` early-outs and does NOT request the
   *  next frame, so the map goes idle at zero cost (reduced-motion, hidden tab). */
  paused: () => boolean;
}

/**
 * The GPU wind sim as a MapLibre custom layer. GL resources are created in
 * `onAdd` and destroyed in `onRemove`. `setWind` hands it a resampled texture
 * (uploaded lazily on next `render`); with no wind set, or while `paused`,
 * `render` draws nothing and does not re-arm. See
 * docs/architecture/wind-flow-gpu-model.md for the geo-anchored particle model.
 */
export class WindGpuLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private readonly opts: WindGpuOptions;
  private map: MLMap | null = null;
  /** Whether particle state is a WebGL2 FLOAT texture, vs the RGBA8 fallback. Set in `onAdd`. */
  private floatMode = false;
  private caps: WindGpuCaps | null = null;
  /** One-shot latch so an incomplete trail framebuffer is reported once, not every frame. */
  private screenFboReported = false;

  private updateProgram: WebGLProgram | null = null;
  private drawProgram: WebGLProgram | null = null;
  private screenProgram: WebGLProgram | null = null;

  private quadBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private framebuffer: WebGLFramebuffer | null = null;

  private particleTex0: WebGLTexture | null = null;
  private particleTex1: WebGLTexture | null = null;
  private windTex: WebGLTexture | null = null;
  private screenTex0: WebGLTexture | null = null;
  private screenTex1: WebGLTexture | null = null;

  private stateSize = 0;
  private particleCount = 0;
  private screenW = 0;
  private screenH = 0;

  private pendingWind: WindTexture | null = null;
  /** The active wind field's bbox + encode scale. `null` ⇒ no field, so `render`
   *  draws nothing; presence also gates the seed-once-on-activation reseed (`setWind`). */
  private wind: { bounds: [number, number, number, number]; encodeMax: number } | null = null;
  /** RGBA8-fallback `posEncoding()` result, cached and only recomputed when
   *  `wind` changes. Unused in FLOAT_STATE mode. */
  private cachedPosEncoding: { base: [number, number]; scale: [number, number] } | null = null;
  /** Set when the field (re)activates: the next `render` re-seeds the state
   *  texture so particles repopulate the current viewport uniformly. */
  private pendingReseed = false;
  /** Previous frame's mercator→texcoord affine, for trail reprojection (`null` = identity). */
  private prevProj: { ax: number; ay: number; bx: number; by: number } | null = null;
  private lastTime = 0;
  /** Previous frame's viewport mercator height, for the zoom-out density bump
   *  in `updateStep` (frame-over-frame, not a moveend event — see
   *  docs/architecture/wind-flow-gpu-model.md). 0 until the first real viewport. */
  private prevViewMercH = 0;
  /** Per-program uniform-location cache — `getUniformLocation` allocates a
   *  fresh object per call, and ~35 lookups/frame at 60fps was a periodic GC
   *  pause. WeakMap so it self-cleans on `onRemove`'s `deleteProgram`. */
  private readonly uniformLocs = new WeakMap<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  /** Reused scratch buffer for the matrix upload, to avoid per-frame garbage. */
  private readonly matrixBuf = new Float32Array(16);

  constructor(opts: WindGpuOptions) {
    this.opts = opts;
    this.id = opts.id;
  }

  /** Cached `gl.getUniformLocation` — see `uniformLocs`. */
  private uloc(gl: GL, program: WebGLProgram, name: string): WebGLUniformLocation | null {
    let cache = this.uniformLocs.get(program);
    if (!cache) {
      cache = new Map();
      this.uniformLocs.set(program, cache);
    }
    let loc = cache.get(name);
    if (loc === undefined) {
      loc = gl.getUniformLocation(program, name);
      cache.set(name, loc);
    }
    return loc;
  }

  /** Queue a resampled wind texture, uploaded on the next `render`. `null`
   *  clears the field. Reseeds particles only on absent→present transitions
   *  (not on every `moveend` re-resample) — age-out + drift respawn already
   *  keep the field fresh, so reseeding every update would re-randomise it
   *  every few seconds even on a static view. */
  setWind(tex: WindTexture | null): void {
    if (tex && !this.wind) this.pendingReseed = true; // absent → present: seed once
    this.pendingWind = tex;
    if (!tex) this.wind = null;
    this.map?.triggerRepaint();
  }

  /** Nudge the render loop (e.g. after a pause predicate flips to false). */
  wake(): void {
    this.lastTime = 0;
    this.map?.triggerRepaint();
  }

  onAdd(map: MLMap, gl: GL): void {
    this.map = map;
    const caps = probeCaps(gl);
    this.caps = caps;

    // colorBufferFloat is the standard signal for a float-renderable ping-pong
    // target, but not proof — verified against a real framebuffer below.
    this.floatMode = caps.webgl2 && caps.colorBufferFloat;

    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);

    this.framebuffer = gl.createFramebuffer();
    this.initParticles(gl, this.opts.particleCount);

    // Some mobile drivers advertise the extension and then refuse the
    // attachment, leaving the update pass silently writing nothing — verify
    // against a real framebuffer and fall back to RGBA8 if incomplete.
    if (this.floatMode && !this.stateFboComplete(gl)) {
      caps.problems.unshift(
        "degraded: EXT_color_buffer_float is advertised but an RGBA32F framebuffer is " +
          "INCOMPLETE on this device — fell back to 16-bit packed positions.",
      );
      this.floatMode = false;
      for (const t of [this.particleTex0, this.particleTex1]) if (t) gl.deleteTexture(t);
      if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
      this.particleTex0 = this.particleTex1 = null;
      this.indexBuffer = null;
      this.initParticles(gl, this.opts.particleCount);
    }
    caps.floatState = this.floatMode;
    reportCaps(caps);
    // Thrown, not limped past: surfaces through windFlow's placeLayer as a
    // console.error naming the device, instead of a silent blank layer.
    const fatal = caps.problems.find((p) => p.startsWith("FATAL:"));
    if (fatal) throw new Error(`windGpu: ${fatal}`);

    const prec = precisionDefs(caps.fragmentHighFloatPrecision);
    const defs = prec + (this.floatMode ? "#define FLOAT_STATE\n" : "");
    this.updateProgram = link(gl, defs + QUAD_VS, defs + UPDATE_FS, "update");
    this.drawProgram = link(gl, defs + DRAW_VS, defs + DRAW_FS, "draw");
    this.screenProgram = link(gl, prec + QUAD_VS, prec + SCREEN_FS, "screen");
  }

  /** Is the ping-pong state texture actually attachable as a color target?
   *  Restores whatever framebuffer was bound, so safe to run at any point. */
  private stateFboComplete(gl: GL): boolean {
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.particleTex1, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    return status === gl.FRAMEBUFFER_COMPLETE;
  }

  private initParticles(gl: GL, count: number): void {
    const side = particleStateSize(count);
    this.stateSize = side;
    this.particleCount = side * side;
    const state = this.seedState();
    this.particleTex0 = stateTexture(gl, side, state, this.floatMode);
    this.particleTex1 = stateTexture(gl, side, this.seedState(), this.floatMode);
    // Particle index buffer 0..N-1.
    const idx = new Float32Array(this.particleCount);
    for (let i = 0; i < this.particleCount; i++) idx[i] = i;
    this.indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  }

  /** Re-seed the live state texture so particles repopulate the current
   *  viewport (+margin) — a plain sub-image upload, no reallocation. */
  private reseedParticles(gl: GL): void {
    if (!this.particleTex0) return;
    const state = this.seedState();
    gl.bindTexture(gl.TEXTURE_2D, this.particleTex0);
    if (this.floatMode) {
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0, this.stateSize, this.stateSize, gl.RGBA, gl.FLOAT, state as Float32Array,
      );
    } else {
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0, this.stateSize, this.stateSize, gl.RGBA, gl.UNSIGNED_BYTE, state as Uint8Array,
      );
    }
  }

  /** Build a state-texture data array: each particle a uniform-random absolute
   *  mercator position within the current viewport+margin (or all of [0,1]²
   *  before a camera exists). `life` seeds at 1 — a reseed is a hard reset, not
   *  a respawn, so it skips the fade-in. */
  private seedState(): Float32Array | Uint8Array {
    const n = this.particleCount;
    const view = this.viewportMercRaw();
    const [minX, minY, maxX, maxY] = view
      ? this.expandMerc(view, this.opts.overscan)
      : [0, 0, 1, 1];
    const enc = this.posEncoding();
    if (this.floatMode) {
      const a = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        const k = i * 4;
        const mx = minX + Math.random() * (maxX - minX);
        const my = minY + Math.random() * (maxY - minY);
        const { fracX, fracY, cell } = encodeFloatMerc(mx, my);
        a[k] = fracX;
        a[k + 1] = fracY;
        a[k + 2] = cell;
        a[k + 3] = 1; // life
      }
      return a;
    }
    const a = new Uint8Array(n * 4);
    const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      const mx = minX + Math.random() * (maxX - minX);
      const my = minY + Math.random() * (maxY - minY);
      // Clamp into the encodable [0,1] range — the packed base/scale spans the wind
      // bbox, which the viewport+margin can slightly exceed; float mode has no clamp.
      const sx = clamp01((mx - enc.base[0]) / enc.scale[0]);
      const sy = clamp01((my - enc.base[1]) / enc.scale[1]);
      const sx255 = sx * 255;
      const sy255 = sy * 255;
      const hx = Math.floor(sx255);
      const hy = Math.floor(sy255);
      a[k] = Math.round((sx255 - hx) * 255); // R = low byte x
      a[k + 1] = Math.round((sy255 - hy) * 255); // G = low byte y
      a[k + 2] = hx; // B = high byte x
      a[k + 3] = hy; // A = high byte y
    }
    return a;
  }

  /** The position storage encoding (mirrors `u_pos_base`/`u_pos_scale`): FLOAT
   *  mode is always identity; the packed fallback normalizes into the wind
   *  bbox, cached in `uploadPendingWind` since it's read twice a frame. */
  private posEncoding(): { base: [number, number]; scale: [number, number] } {
    if (this.floatMode || !this.wind) return IDENTITY_POS_ENCODING;
    return this.cachedPosEncoding!;
  }

  /** Current viewport in absolute mercator `[minX, minY, maxX, maxY]` (minY =
   *  north, mercator y grows south), or `null` for a map with no `getBounds` (test double). */
  private viewportMercRaw(): [number, number, number, number] | null {
    const map = this.map;
    if (!map || typeof map.getBounds !== "function") return null;
    const b = map.getBounds();
    const nw = lngLatToMercator(b.getWest(), b.getNorth());
    const se = lngLatToMercator(b.getEast(), b.getSouth());
    return [nw.x, nw.y, se.x, se.y];
  }

  /** Expand a mercator bbox outward by `frac` of its own span on each side. */
  private expandMerc(
    v: [number, number, number, number],
    frac: number,
  ): [number, number, number, number] {
    const mx = (v[2] - v[0]) * frac;
    const my = (v[3] - v[1]) * frac;
    return [v[0] - mx, v[1] - my, v[2] + mx, v[3] + my];
  }

  /** (Re)allocate the screen-sized trail textures, clamped to MAX_TEXTURE_SIZE
   *  (`screenW`/`screenH` are the TEXTURE size, not necessarily the viewport). */
  private ensureScreen(gl: GL, w: number, h: number): void {
    const [tw, th] = clampScreenSize(w, h, this.caps?.maxTextureSize ?? 0);
    if (this.screenW === tw && this.screenH === th && this.screenTex0) return;
    if (this.screenTex0) gl.deleteTexture(this.screenTex0);
    if (this.screenTex1) gl.deleteTexture(this.screenTex1);
    // Blank screen textures — dropping the old trails on a resize is correct.
    this.screenTex0 = emptyTexture(gl, tw, th, gl.NEAREST);
    this.screenTex1 = emptyTexture(gl, tw, th, gl.NEAREST);
    this.screenW = tw;
    this.screenH = th;
    if (!this.screenFboReported) {
      this.screenFboReported = true;
      const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.screenTex1, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        // Nothing this layer draws can reach the screen from here; say so loudly
        // rather than presenting as "particles don't render".
        console.error(
          `windGpu: the ${tw}×${th} trail framebuffer is INCOMPLETE (status 0x${status.toString(16)}) — ` +
            "no particles can be drawn on this device. Capabilities:",
          this.caps,
        );
      }
    }
  }

  onRemove(_map: MLMap, gl: GL): void {
    for (const p of [this.updateProgram, this.drawProgram, this.screenProgram]) {
      if (p) gl.deleteProgram(p);
    }
    for (const b of [this.quadBuffer, this.indexBuffer]) if (b) gl.deleteBuffer(b);
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
    for (const t of [
      this.particleTex0,
      this.particleTex1,
      this.windTex,
      this.screenTex0,
      this.screenTex1,
    ]) {
      if (t) gl.deleteTexture(t);
    }
    this.updateProgram = this.drawProgram = this.screenProgram = null;
    this.quadBuffer = this.indexBuffer = null;
    this.framebuffer = null;
    this.particleTex0 = this.particleTex1 = this.windTex = null;
    this.screenTex0 = this.screenTex1 = null;
    this.wind = null;
    this.cachedPosEncoding = null;
    this.pendingWind = null;
    this.pendingReseed = false;
    this.prevProj = null;
    this.screenW = this.screenH = 0;
    this.screenFboReported = false;
    this.map = null;
  }

  private uploadPendingWind(gl: GL): void {
    const t = this.pendingWind;
    if (!t) return;
    this.pendingWind = null;
    if (this.windTex) gl.deleteTexture(this.windTex);
    this.windTex = dataTexture(gl, t.cols, t.rows, t.data, gl.LINEAR);
    this.wind = { bounds: t.bounds, encodeMax: t.encodeMax };
    if (!this.floatMode) {
      const wb = t.bounds;
      const nw = lngLatToMercator(wb[0], wb[3]); // west, north → minX, minY (top)
      const se = lngLatToMercator(wb[2], wb[1]); // east, south → maxX, maxY (bottom)
      this.cachedPosEncoding = { base: [nw.x, nw.y], scale: [se.x - nw.x, se.y - nw.y] };
    }
  }

  render(gl: GL, args: CustomRenderMethodInput): void {
    const map = this.map;
    if (!map) return;
    if (this.opts.paused()) return; // idle: no draw, no triggerRepaint
    this.uploadPendingWind(gl);
    // No field (not enabled / off-grid / cleared) ⇒ nothing to draw. Halt the loop
    // (no triggerRepaint): `setWind` re-arms it when a pan/zoom brings a field back.
    if (!this.wind || !this.windTex) return;
    if (this.pendingReseed) {
      this.reseedParticles(gl);
      this.pendingReseed = false;
    }

    const now = performance.now();
    const dt = this.lastTime ? Math.min(0.1, (now - this.lastTime) / 1000) : 1 / 60;
    this.lastTime = now;

    // Save the GL state we clobber (framebuffer + viewport) so MapLibre's next
    // layer renders into the right target. The layer contract lets us assume
    // blending/depth are set for us on entry, but not that we may leave them.
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;

    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    this.ensureScreen(gl, w, h);

    const worldSize =
      (map as unknown as { transform?: { worldSize?: number } }).transform?.worldSize ??
      512 * Math.pow(2, map.getZoom());
    const view = this.viewportMercRaw();
    const cur = view ? this.projAffine(view) : null;
    const reproj = this.trailReproj(this.prevProj, cur);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);

    this.updateStep(gl, dt, view);
    this.drawTrails(gl, args, prevFb, w, h, worldSize, reproj, view);

    // Restore for MapLibre.
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this.prevProj = cur; // for next frame's reprojection
    map.triggerRepaint();
  }

  /** The mercator→framebuffer-texcoord affine for a viewport (`tc = a·merc +
   *  b`; tc.x=0 west, tc.y=0 south), composed against the previous frame's
   *  affine to reproject the trail buffer. */
  private projAffine(v: [number, number, number, number]): {
    ax: number;
    ay: number;
    bx: number;
    by: number;
  } {
    const spanX = v[2] - v[0];
    const spanY = v[3] - v[1]; // maxY (south) − minY (north) > 0
    return { ax: 1 / spanX, bx: -v[0] / spanX, ay: -1 / spanY, by: v[3] / spanY };
  }

  /** Where in the PREVIOUS frame was the water point now at texcoord `st`?
   *  `st_prev = scale·st + offset`. Identity at rest (prev == cur) or with no
   *  prior frame. */
  private trailReproj(
    prev: { ax: number; ay: number; bx: number; by: number } | null,
    cur: { ax: number; ay: number; bx: number; by: number } | null,
  ): { scale: [number, number]; offset: [number, number] } {
    if (!prev || !cur) return { scale: [1, 1], offset: [0, 0] };
    const sx = prev.ax / cur.ax;
    const sy = prev.ay / cur.ay;
    return { scale: [sx, sy], offset: [prev.bx - sx * cur.bx, prev.by - sy * cur.by] };
  }

  /** Advance the sim: ping-pong the state texture through the update shader. `view` is
   *  the current viewport mercator bbox (unpadded) for the advect scale + respawn, and
   *  (via `prevViewMercH`) for the continuous zoom-out density bump. */
  private updateStep(
    gl: GL,
    dt: number,
    view: [number, number, number, number] | null,
  ): void {
    const wind = this.wind!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.particleTex1, 0);
    gl.viewport(0, 0, this.stateSize, this.stateSize);
    gl.disable(gl.BLEND);

    const p = this.updateProgram!;
    gl.useProgram(p);
    this.bindQuad(gl, p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.particleTex0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.windTex);
    gl.uniform1i(this.uloc(gl, p, "u_particles"), 0);
    gl.uniform1i(this.uloc(gl, p, "u_wind"), 1);
    gl.uniform1f(this.uloc(gl, p, "u_rand_seed"), Math.random());
    // Position storage encoding (absolute in float mode; viewport-relative in packed).
    const enc = this.posEncoding();
    gl.uniform2f(this.uloc(gl, p, "u_pos_base"), enc.base[0], enc.base[1]);
    gl.uniform2f(this.uloc(gl, p, "u_pos_scale"), enc.scale[0], enc.scale[1]);
    // Wind-texture geo bbox: a particle's mercator → lng/lat → normalize into this to
    // sample the field (resampled over the viewport∩grid; row 0 = south).
    const wb = wind.bounds;
    gl.uniform4f(this.uloc(gl, p, "u_wind_bbox"), wb[0], wb[1], wb[2], wb[3]);
    gl.uniform2f(this.uloc(gl, p, "u_wind_bbox_span"), wb[2] - wb[0], wb[3] - wb[1]);
    const vm = view ? this.expandMerc(view, this.opts.overscan) : [0, 0, 1, 1];
    gl.uniform4f(this.uloc(gl, p, "u_view_merc"), vm[0], vm[1], vm[2], vm[3]);
    gl.uniform1f(this.uloc(gl, p, "u_encode_max"), wind.encodeMax);
    gl.uniform1f(this.uloc(gl, p, "u_speed_cap"), this.opts.speedCap);
    // Zoom-independent screen pace: viewportMercHeight ≡ 1/worldSize, so
    // vel·u_advect·worldSize is a fixed px/s at any zoom (isotropic — mercator
    // is conformal & square-pixel).
    const viewMercH = view ? view[3] - view[1] : 0;
    gl.uniform1f(this.uloc(gl, p, "u_advect"), this.opts.advectScreenGain * dt * viewMercH);
    gl.uniform1f(this.uloc(gl, p, "u_drop_rate"), this.opts.dropRate);
    gl.uniform1f(this.uloc(gl, p, "u_drop_rate_bump"), this.opts.dropRateBump);
    // Zoom-out density bump: how much the viewport's mercator height grew this
    // frame vs last — the existing field now covers a shrinking fraction of a
    // larger viewport, so bump respawn probability by that shortfall (spread
    // over the gesture, not a pop at moveend). Zooming in needs no correction.
    let zoomBump = 0;
    if (this.prevViewMercH > 0 && viewMercH > 0) {
      const ratio = viewMercH / this.prevViewMercH;
      if (ratio > 1) {
        const areaRatio = ratio * ratio;
        zoomBump = Math.min(1, this.opts.zoomBumpGain * (1 - 1 / areaRatio));
      }
    }
    this.prevViewMercH = viewMercH;
    gl.uniform1f(this.uloc(gl, p, "u_zoom_bump"), zoomBump);
    gl.uniform1f(this.uloc(gl, p, "u_fade_rate"), this.opts.fadeRate);
    gl.uniform1f(this.uloc(gl, p, "u_dt"), dt);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // swap state textures
    const tmp = this.particleTex0;
    this.particleTex0 = this.particleTex1;
    this.particleTex1 = tmp;
  }

  /** Fade+reproject the previous trail frame, draw particles on top into the
   *  screen FBO, then blit the accumulated trails onto the map framebuffer. */
  private drawTrails(
    gl: GL,
    args: CustomRenderMethodInput,
    mapFb: WebGLFramebuffer | null,
    w: number,
    h: number,
    worldSize: number,
    reproj: { scale: [number, number]; offset: [number, number] },
    view: [number, number, number, number] | null,
  ): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.screenTex1, 0);
    // Texture size (possibly clamped below the drawing buffer — see
    // `clampScreenSize`); clip space is resolution-independent so only trail
    // resolution is affected, not the particle projection.
    gl.viewport(0, 0, this.screenW, this.screenH);

    // 1. previous trails, faded and reprojected onto the moved camera.
    gl.disable(gl.BLEND);
    this.drawScreenTexture(gl, this.screenTex0, this.opts.fade, reproj.scale, reproj.offset);

    // 2. new particles on top.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.drawParticles(gl, args, worldSize, view);

    // 3. blit the accumulated screen texture onto the map (identity reprojection).
    gl.bindFramebuffer(gl.FRAMEBUFFER, mapFb);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.drawScreenTexture(gl, this.screenTex1, 1.0, [1, 1], [0, 0]);

    // swap screen textures
    const tmp = this.screenTex0;
    this.screenTex0 = this.screenTex1;
    this.screenTex1 = tmp;
  }

  private drawScreenTexture(
    gl: GL,
    tex: WebGLTexture | null,
    opacity: number,
    reprojScale: [number, number],
    reprojOffset: [number, number],
  ): void {
    const p = this.screenProgram!;
    gl.useProgram(p);
    this.bindQuad(gl, p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.uloc(gl, p, "u_screen"), 0);
    gl.uniform1f(this.uloc(gl, p, "u_opacity"), opacity);
    gl.uniform2f(this.uloc(gl, p, "u_reproj_scale"), reprojScale[0], reprojScale[1]);
    gl.uniform2f(this.uloc(gl, p, "u_reproj_offset"), reprojOffset[0], reprojOffset[1]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private drawParticles(
    gl: GL,
    args: CustomRenderMethodInput,
    worldSize: number,
    view: [number, number, number, number] | null,
  ): void {
    const p = this.drawProgram!;
    gl.useProgram(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuffer);
    const aIndex = gl.getAttribLocation(p, "a_index");
    gl.enableVertexAttribArray(aIndex);
    gl.vertexAttribPointer(aIndex, 1, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.particleTex0);
    gl.uniform1i(this.uloc(gl, p, "u_particles"), 0);
    gl.uniform1f(this.uloc(gl, p, "u_particles_res"), this.stateSize);
    // modelViewProjectionMatrix is a Float64Array; copy into the reused fp32
    // scratch buffer rather than allocating a fresh one every frame.
    const m = args.modelViewProjectionMatrix;
    this.matrixBuf.set(m);
    gl.uniformMatrix4fv(this.uloc(gl, p, "u_matrix"), false, this.matrixBuf);
    gl.uniform1f(this.uloc(gl, p, "u_world_size"), worldSize);
    const enc = this.posEncoding();
    gl.uniform2f(this.uloc(gl, p, "u_pos_base"), enc.base[0], enc.base[1]);
    gl.uniform2f(this.uloc(gl, p, "u_pos_scale"), enc.scale[0], enc.scale[1]);
    // Reference-cell trick (FLOAT_STATE only) — see "Draw-time precision" in
    // docs/architecture/wind-flow-gpu-model.md. `view` reuses the viewport
    // `render()` already computed this frame, avoiding a second unproject pass.
    const refX = view ? (view[0] + view[2]) / 2 : 0.5;
    const refY = view ? (view[1] + view[3]) / 2 : 0.5;
    const refCellX = Math.floor(refX * POS_CELL);
    const refCellY = Math.floor(refY * POS_CELL);
    const vx = (refCellX / POS_CELL) * worldSize;
    const vy = (refCellY / POS_CELL) * worldSize;
    gl.uniform2f(this.uloc(gl, p, "u_ref_cell"), refCellX, refCellY);
    gl.uniform4f(
      this.uloc(gl, p, "u_ref_clip_offset"),
      m[0]! * vx + m[4]! * vy + m[12]!,
      m[1]! * vx + m[5]! * vy + m[13]!,
      m[2]! * vx + m[6]! * vy + m[14]!,
      m[3]! * vx + m[7]! * vy + m[15]!,
    );
    gl.uniform1f(this.uloc(gl, p, "u_point_size"), this.opts.pointSize);
    gl.uniform1f(this.uloc(gl, p, "u_alpha"), this.opts.alpha);
    gl.drawArrays(gl.POINTS, 0, this.particleCount);
  }

  private bindQuad(gl: GL, program: WebGLProgram): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const a = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  }
}
