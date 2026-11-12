// Two S-52 light annotations as one MapLibre custom (WebGL) layer: a real
// sector's wedge/outline/colour arc/leg lines, and a VALNMR-only light's ring
// (tlpktvqv). A light with its own S-52 icon (chartcore's `sym`) is skipped
// entirely here (`lightHasOwnSymbol`) — a separate rendering path (yqxkluqv).
// See docs/architecture/sector-lights-overlay.md for the S-52 reference this
// ports from, the constant-screen-size rationale, and per-shape dimensions.
//
// Geometry is tessellated in pixel-offset space once per refresh; per frame
// the shader only re-anchors each light at its screen position. Which lights
// draw at all is decided in ../style/sectorGate.ts (the style's own SCAMIN
// filter), so this layer can't disagree with a light's other symbols about
// whether it exists at this scale; `lightHasOwnSymbol` lights are filtered
// out in `refresh`, not the query, since the marker layer still needs every
// light for the info panel's tap target (aidsHazards.ts).

import type { CustomLayerInterface, CustomRenderMethodInput, Map as MLMap } from "maplibre-gl";
import { paletteColors, s52ColourToRgb, type Palette, type S52Table } from "../../core/style/colors";
import { currentPalette } from "../../core/style/palette";
import { THEME_BY_ID } from "../../core/style/themes";
import {
  ARC_RADIUS_REF,
  fadeOpacity,
  lightHasOwnSymbol,
  lightsOverlayOpacity,
  lightsOverlayVisible,
  RADIUS_MAX,
  radiusForRange,
  sectorAngles,
  sectorQueries,
} from "../../core/style/sectorGate";
import { scaminBias as currentScaminBias } from "../../core/serverConfig";
import type { ScaminBias } from "../../core/style/expr";
import { Z, type Overlay } from "../../core/layers/overlay";

export const SECTOR_LIGHTS_LAYER_ID = "sector-lights";

// Reference's fixed leg-radius/arc-radius ratio (25 mm / 20 mm — S52CondRules.cpp:1122,1127).
const LEG_RADIUS_FACTOR = 94.48 / ARC_RADIUS_REF;
const FOG_INSET = 8; // EXCLIT=3 fog detector (S52CondRules.cpp:1124-1126)
// Reference S52CondRules.cpp half-widths, scaled per theme by `arcWidths`
// below. Untested on real data: fixture cell US5OAKIQ.000 has no sectored lights.
const OUTLINE_HALF_REF = 2;
const ARC_HALF_REF = 1;
const FAINT_ARC_HALF_REF = 0.5;
const LEG_DASH = 8; // RenderHelper.cpp:94-96
const LEG_GAP = 2;
const LEG_HALF = 0.5;
// Legs tint at the sector's own arc colour rather than flat CHBLK, so a leg
// reads as part of its sector (see `tint`).
const LEG_ALPHA = 0.4;
// Same 0.15 low-alpha-wash convention as region-draw's selection fill and
// chartStyle.ts's CHBRN fill. ONE constant for both the arc's wedge and the
// VALNMR ring's disc (tlpktvqv) — don't split it, or the two will drift apart.
const WEDGE_ALPHA = 0.15;
const SEG_DEG = 4; // arc tessellation step, at ARC_RADIUS (75.59 px, ~5.3 px/segment)
// Coarsens the degree step so a shape gets ~1 px of arc length per segment.
// A no-op today; kept as a defensive floor — it WAS load-bearing pre-slsynkln
// when a non-sectored light drew a 3 px dot here.
const PX_PER_SEG = 1;
function tessStep(radius: number): number {
  return Math.max(SEG_DEG, (180 * PX_PER_SEG) / (Math.PI * Math.max(radius, 1)));
}
const REFRESH_THROTTLE_MS = 50;

type RGBA = [number, number, number, number];

/**
 * One S-52 table value as a normalized vertex colour, via `colors.ts`'s
 * `s52ColourToRgb` (not a second regex — an old `rgb()`-only one fell through
 * to opaque black once themes became `#rrggbb`; pinned by
 * `themeColourParsers.test.ts`). Alpha is always 1 here; translucency is
 * applied downstream by `tint`, which premultiplies.
 */
function rgba(token: string): RGBA {
  const c = s52ColourToRgb(token);
  return c ? [c[0] / 255, c[1] / 255, c[2] / 255, 1] : [0, 0, 0, 1];
}

// Shader premultiplies by alpha, so [0,0,0,0] is a true no-op — a theme with
// `sectorOutline: false` gets the outline pass skipped with no branch.
const TRANSPARENT: RGBA = [0, 0, 0, 0];

/**
 * A translucent variant of `color`, premultiplied for this layer's blend
 * (ONE, ONE_MINUS_SRC_ALPHA). Every other vertex colour is opaque alpha=1,
 * which is what makes the shader's `v_color * u_alpha` fade a correct
 * premultiply; an unpremultiplied alpha arriving here would blend too bright.
 */
function tint(color: RGBA, alpha: number): RGBA {
  return [color[0] * alpha, color[1] * alpha, color[2] * alpha, alpha];
}

/**
 * The arc's colours for one palette, built per refresh — these used to be
 * module-level consts resolved against the day table once, at import, so a
 * night-palette switch never reached them and arcs kept painting day colours
 * over a near-black chart.
 */
interface ArcColors {
  outline: RGBA;
  chblk: RGBA;
  chbrn: RGBA;
  byToken: Record<string, RGBA>;
  outlineHalf: number;
  arcHalf: number;
  faintArcHalf: number;
}

/** Reference half-widths (`*_REF` consts) scaled by the theme's
 * `sectorArcScale` (absent → 1, i.e. the reference proportions unchanged). */
function arcWidths(scale: number): Pick<ArcColors, "outlineHalf" | "arcHalf" | "faintArcHalf"> {
  return {
    outlineHalf: OUTLINE_HALF_REF * scale,
    arcHalf: ARC_HALF_REF * scale,
    faintArcHalf: FAINT_ARC_HALF_REF * scale,
  };
}

function arcColors(palette: Palette, C: S52Table): ArcColors {
  const theme = THEME_BY_ID[palette];
  const showOutline = theme?.sectorOutline !== false;
  return {
    outline: showOutline ? rgba(C.OUTLW) : TRANSPARENT,
    chblk: rgba(C.CHBLK),
    chbrn: rgba(C.CHBRN),
    ...arcWidths(theme?.sectorArcScale ?? 1),
    byToken: {
      LITRD: rgba(C.LITRD),
      LITGN: rgba(C.LITGN),
      LITYW: rgba(C.LITYW),
      CHMGD: rgba(C.CHMGD),
    },
  };
}

interface Sector {
  lng: number;
  lat: number;
  /** Draw range: compass degrees after the seaward flip, a2 > a1. `0..360`
   * (the full circle) for a light with no SECTR1/SECTR2 — see `hasSector`. */
  a1: number;
  a2: number;
  radius: number;
  /** Leg-line length — `radius * LEG_RADIUS_FACTOR`. Only meaningful when
   * `hasSector` (the VALNMR ring draws no legs). */
  legRadius: number;
  outline: RGBA;
  arc: RGBA;
  arcHalf: number;
  /** Server SCAMIN, drives the uniform fade band. Absent → 0, "never fades". */
  scamin: number;
  /** False for a light with no charted SECTR1/SECTR2: `a1`/`a2` are then the
   * degenerate full circle `0..360` of the VALNMR ring, which draws no legs
   * (`dir(0) === dir(360)` would draw a spurious north leg). */
  hasSector: boolean;
}

/** One light's slice of the shared vertex buffer. */
interface Range {
  lng: number;
  lat: number;
  first: number;
  count: number;
  /** Server SCAMIN for this light's uniform fade (`fadeOpacity`). */
  scamin: number;
}

// offsetX, offsetY, r, g, b, a, then the anti-aliasing triple `aa` (below).
const VERTEX_SIZE = 9;

// # Anti-aliasing
//
// MapLibre's canvas has no MSAA, so the triangles this layer draws had hard,
// stair-stepped edges — at 1-2 px ring widths and 1 px legs that read as
// "pixelated" (user report). Each vertex therefore carries an `aa` triple
// (mode, p, q) and the fragment shader computes the pixel's coverage of the
// TRUE shape analytically, fading it over one device pixel:
//
//   AA_NONE (0) — wedge fill: coverage 1 (a 0.15-alpha wash; its outer edge
//                 sits under the arc anyway).
//   AA_RING (1) — annulus: p/q are the true inner/outer radii (px), coverage
//                 from length(offset) against both. The geometry is padded by
//                 AA_PAD px each side so the fade has fragments to land on.
//   AA_LINE (2) — leg dash: p is the signed across-line distance (px,
//                 interpolated between the padded long edges), q the true
//                 half-width. The dash's short ends stay hard — they are
//                 perpendicular, sub-10px and read fine.
//
// Coverage is measured in CSS px against `u_aa` = 1/devicePixelRatio, so the
// fade is one DEVICE pixel wide at any DPR — no softer than it must be on a
// retina tablet, and enough to kill the steps at DPR 1.
const AA_NONE = 0;
const AA_RING = 1;
const AA_LINE = 2;
const AA_PAD = 1;

/** Compass degrees → screen-pixel unit vector (y down). */
function dir(deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [Math.sin(rad), -Math.cos(rad)];
}

const VS = `
attribute vec2 a_offset;
attribute vec4 a_color;
attribute vec3 a_aa;
uniform vec2 u_center;   // NDC
uniform vec2 u_scale;    // px -> NDC
varying vec4 v_color;
varying vec2 v_offset;
varying vec3 v_aa;
void main() {
  gl_Position = vec4(u_center + a_offset * u_scale, 0.0, 1.0);
  v_color = a_color;
  v_offset = a_offset;
  v_aa = a_aa;
}`;

const FS = `
precision mediump float;
uniform float u_alpha;
uniform float u_aa;      // one device pixel, in CSS px
varying vec4 v_color;
varying vec2 v_offset;
varying vec3 v_aa;
// Coverage of an edge at signed distance d (px, positive = inside).
float edge(float d) { return clamp(d / u_aa + 0.5, 0.0, 1.0); }
// Colours are opaque and the blend is premultiplied (ONE, ONE_MINUS_SRC_ALPHA),
// so scaling the whole vec4 — rgb with a — is the correct fade, and coverage
// is just one more factor of it (see "Anti-aliasing" above).
void main() {
  float cov = 1.0;
  if (v_aa.x > 1.5) {
    cov = edge(v_aa.z - abs(v_aa.y));
  } else if (v_aa.x > 0.5) {
    float r = length(v_offset);
    cov = (v_aa.y > 0.0 ? edge(r - v_aa.y) : 1.0) * edge(v_aa.z - r);
  }
  gl_FragColor = v_color * (u_alpha * cov);
}`;

/** Extract the sector (or, absent SECTR1/SECTR2, the degenerate full-circle
 * VALNMR ring) description of one LIGHTS tile feature. Angle normalization
 * (`sectorAngles`) is shared with the info-at-point glyph
 * (../../core/info/chartProvider.ts's `lightSegments`) so the two can't
 * disagree. Callers must have already filtered out `lightHasOwnSymbol`. */
function toSector(
  lng: number,
  lat: number,
  props: Record<string, unknown>,
  COL: ArcColors,
): Sector {
  const { a1, a2, hasSector } = sectorAngles(props);
  const litvis = String(props.LITVIS ?? "").split(",");
  const faint = litvis.includes("3") || litvis.includes("7") || litvis.includes("8");
  const colToken = typeof props.lit_col === "string" ? props.lit_col : "CHMGD";
  // Absent → 0, read by fadeOpacity as "not SCAMIN-gated, never fades".
  const scamin = typeof props.scamin === "number" ? props.scamin : 0;
  const radius = radiusForRange(props.lit_range) - (props.EXCLIT === 3 ? FOG_INSET : 0);
  return {
    lng,
    lat,
    a1,
    a2,
    radius,
    legRadius: radius * LEG_RADIUS_FACTOR,
    outline: faint ? COL.chblk : COL.outline,
    arc: faint ? COL.chbrn : (COL.byToken[colToken] ?? COL.byToken.CHMGD),
    arcHalf: faint ? COL.faintArcHalf : COL.arcHalf,
    scamin,
    hasSector,
  };
}

/** Append an annulus segment a1..a2 (compass degrees) between rIn and rOut,
 * tessellated by `tessStep(rOut)`. One caller, `pushArc` — used for both a
 * real sector's arc and the VALNMR ring's 0..360 sweep, no per-case step. */
function pushAnnulus(out: number[], s: Sector, rIn: number, rOut: number, color: RGBA): void {
  const steps = Math.max(2, Math.ceil((s.a2 - s.a1) / tessStep(rOut)));
  // Geometry padded by AA_PAD so the shader's edge fade has room; the TRUE
  // radii ride in the aa triple (module "Anti-aliasing" comment).
  const gIn = Math.max(0, rIn - AA_PAD);
  const gOut = rOut + AA_PAD;
  const aa = [AA_RING, rIn, rOut];
  let [px, py] = dir(s.a1);
  for (let i = 1; i <= steps; i++) {
    const [qx, qy] = dir(s.a1 + ((s.a2 - s.a1) * i) / steps);
    // two triangles: (in0,out0,out1) (in0,out1,in1)
    out.push(px * gIn, py * gIn, ...color, ...aa, px * gOut, py * gOut, ...color, ...aa, qx * gOut, qy * gOut, ...color, ...aa);
    out.push(px * gIn, py * gIn, ...color, ...aa, qx * gOut, qy * gOut, ...color, ...aa, qx * gIn, qy * gIn, ...color, ...aa);
    [px, py] = [qx, qy];
  }
}

/** Append the filled pie slice a1..a2 from the light to the arc's radius,
 * drawn first (below ring/legs) so it reads as a wash. The VALNMR ring's
 * 0..360 sweep closes the fan on itself (`dir(360) === dir(0)`), yielding a
 * disc with no seam and no separate disc tessellator. */
function pushWedge(out: number[], s: Sector, color: RGBA): void {
  const steps = Math.max(2, Math.ceil((s.a2 - s.a1) / tessStep(s.radius)));
  let [px, py] = dir(s.a1);
  for (let i = 1; i <= steps; i++) {
    const [qx, qy] = dir(s.a1 + ((s.a2 - s.a1) * i) / steps);
    out.push(
      0, 0, ...color, AA_NONE, 0, 0,
      px * s.radius, py * s.radius, ...color, AA_NONE, 0, 0,
      qx * s.radius, qy * s.radius, ...color, AA_NONE, 0, 0,
    );
    [px, py] = [qx, qy];
  }
}

/** The arc shape: a strip of colour centred on `s.radius`, width `half`
 * (theme-scaled, `arcWidths`). `rIn` clamped at 0 as a defensive floor —
 * `s.radius` never gets that small in practice ([50,115] px). */
function pushArc(out: number[], s: Sector, half: number, color: RGBA): void {
  pushAnnulus(out, s, Math.max(0, s.radius - half), s.radius + half, color);
}

/** Append one dashed leg line from the light out to `legRadius`. */
function pushLeg(out: number[], deg: number, legRadius: number, c: RGBA): void {
  const [dx, dy] = dir(deg);
  // Padded half-width for the geometry; the true LEG_HALF rides in the aa
  // triple, with the signed across-distance (±w) interpolated between edges.
  const w = LEG_HALF + AA_PAD;
  const [nx, ny] = [-dy * w, dx * w];
  const lo = [AA_LINE, -w, LEG_HALF];
  const hi = [AA_LINE, w, LEG_HALF];
  for (let r0 = 0; r0 < legRadius; r0 += LEG_DASH + LEG_GAP) {
    const r1 = Math.min(r0 + LEG_DASH, legRadius);
    const [x0, y0, x1, y1] = [dx * r0, dy * r0, dx * r1, dy * r1];
    out.push(x0 - nx, y0 - ny, ...c, ...lo, x0 + nx, y0 + ny, ...c, ...hi, x1 + nx, y1 + ny, ...c, ...hi);
    out.push(x0 - nx, y0 - ny, ...c, ...lo, x1 + nx, y1 + ny, ...c, ...hi, x1 - nx, y1 - ny, ...c, ...lo);
  }
}

export class SectorLightLayer implements CustomLayerInterface {
  id = SECTOR_LIGHTS_LAYER_ID;
  type = "custom" as const;
  renderingMode = "2d" as const;

  /**
   * @param palette live palette accessor, read every refresh (never cached).
   *   Defaults to `currentPalette` because `MapView.wireMap` doesn't yet pass
   *   the real settings accessor.
   * @param chartDetail live boat-wide SCAMIN bias, so the arc fade and the
   *   style's SCAMIN gate move together when "Chart detail" changes.
   */
  constructor(
    private readonly palette: () => Palette = currentPalette,
    private readonly chartDetail: () => ScaminBias = currentScaminBias,
  ) {}

  private map: MLMap | null = null;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private aOffset = 0;
  private aColor = 0;
  private aAa = 0;
  private uAa: WebGLUniformLocation | null = null;
  private uCenter: WebGLUniformLocation | null = null;
  private uScale: WebGLUniformLocation | null = null;
  private uAlpha: WebGLUniformLocation | null = null;
  private ranges: Range[] = [];
  private vertexCount = 0;
  private visible = true;
  /** The "Aids & lights" ENC group's opacity, applied as a flat multiplier on
   * every light's own scamin fade (`setGroupOpacity`). */
  private groupOpacity = 1;
  /** Per-light screen center + fade alpha, cached across frames the camera
   * didn't move (see `render`). Invalidated whenever `ranges` is rebuilt. */
  private frameCache: { x: number; y: number; alpha: number; onScreen: boolean }[] = [];
  private cacheKey: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Chart sources `refresh` last queried. Filters `onSourceData` so a
   * signalk-own/-cpa/-targets tick doesn't trigger a re-query — those fire
   * `sourcedata`/`isSourceLoaded` identically to a tile load. */
  private chartSourceIds = new Set<string>();
  //
  // A single TILE load (`e.tile`) counts too, not only `isSourceLoaded`: that
  // flag is `tileManager.loaded()` — every ideal tile in — which during a
  // continuous zoom-in is almost never true, because the ideal set moves on
  // before it fills. Gating on it alone meant a light entering the data at its
  // SCAMIN boundary (the new, deeper tile) was not queried until the gesture
  // stopped, so it popped in at whatever alpha the zoom had reached instead of
  // fading up from 0 the way the JSON buoy layers do. Zooming OUT never showed
  // this: a leaving light is already in `ranges` and `render` fades it per frame.
  private readonly onSourceData = (e: {
    isSourceLoaded?: boolean;
    sourceId?: string;
    tile?: unknown;
  }) => {
    if (
      (e.isSourceLoaded || e.tile !== undefined) &&
      e.sourceId !== undefined &&
      this.chartSourceIds.has(e.sourceId)
    ) {
      this.scheduleRefresh();
    }
  };
  private readonly onMoveEnd = () => this.scheduleRefresh();

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    // Turning ON re-queries: while OFF, `refresh` skips entirely (below), so
    // the buffer is stale/empty. Turning OFF just needs the one repaint.
    if (visible) this.scheduleRefresh();
    else this.map?.triggerRepaint();
  }

  /** Dim the whole overlay with its ENC group. Must NOT invalidate
   * `frameCache` or fold into the cached alpha — either would make the
   * slider do nothing until the camera moved. `render` multiplies it in
   * at draw time instead. */
  setGroupOpacity(opacity: number): void {
    if (this.groupOpacity === opacity) return;
    this.groupOpacity = opacity;
    this.map?.triggerRepaint();
  }

  onAdd(map: MLMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    const compile = (type: number, src: string): WebGLShader => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(program);
    this.program = program;
    this.aOffset = gl.getAttribLocation(program, "a_offset");
    this.aColor = gl.getAttribLocation(program, "a_color");
    this.uCenter = gl.getUniformLocation(program, "u_center");
    this.uScale = gl.getUniformLocation(program, "u_scale");
    this.uAlpha = gl.getUniformLocation(program, "u_alpha");
    this.aAa = gl.getAttribLocation(program, "a_aa");
    this.uAa = gl.getUniformLocation(program, "u_aa");
    this.buffer = gl.createBuffer();
    map.on("sourcedata", this.onSourceData);
    map.on("moveend", this.onMoveEnd);
    this.scheduleRefresh();
  }

  onRemove(map: MLMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    map.off("sourcedata", this.onSourceData);
    map.off("moveend", this.onMoveEnd);
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    if (this.program) gl.deleteProgram(this.program);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    this.program = null;
    this.buffer = null;
    this.map = null;
    this.gl = null;
    this.ranges = [];
  }

  /** Throttle, not debounce: a pending refresh is left to fire rather than
   * pushed back, so the stream of tile loads during a zoom cannot starve it
   * until the gesture ends. Nothing is lost by absorbing the later calls —
   * `refresh` reads the tiles, style and palette at fire time, not call time. */
  scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, REFRESH_THROTTLE_MS);
  }

  /** Re-read every light from the loaded chart tiles and rebuild the
   * vertex buffer. Cheap: arcs/dots are tessellated in pixel space per
   * refresh, never per frame. */
  private refresh(): void {
    const map = this.map;
    const gl = this.gl;
    const style = map?.getStyle();
    if (!map || !gl || !style) return;
    // Skip while hidden, not just in render: a bare render early-return would
    // still leave every moveend/sourcedata re-querying for nothing.
    if (!this.visible) return;
    // Re-read (not held in a field): a palette switch fires 'style.load' →
    // `ensureOverlays` → `scheduleRefresh`, landing here 50ms later — which is
    // also what makes reading the DOM here safe (settled by then).
    const palette = this.palette();
    const COL = arcColors(palette, paletteColors(palette));
    const sectors = new Map<string, Sector>();
    const queries = sectorQueries(style);
    this.chartSourceIds = new Set(queries.map((q) => q.source));
    for (const query of queries) {
      let features;
      try {
        features = map.querySourceFeatures(query.source, {
          sourceLayer: query.sourceLayer,
          filter: query.filter,
        });
      } catch {
        continue; // source mid-teardown
      }
      for (const f of features) {
        if (f.geometry.type !== "Point") continue;
        const props = f.properties ?? {};
        // A light with a baked `sym` draws its own icon-image SVG instead
        // (aidsHazards.ts `-lights-sym`) — must not also draw here.
        // `lightHasOwnSymbol` is shared with chartProvider.ts's `icon()`.
        if (lightHasOwnSymbol(props)) continue;
        const [lng, lat] = f.geometry.coordinates;
        const sector = toSector(lng, lat, props, COL);
        // dedupe tile-border duplicates and overlapping chart sets
        const key = `${lng.toFixed(6)},${lat.toFixed(6)},${sector.a1},${sector.a2}`;
        sectors.set(key, sector);
      }
    }

    const vertices: number[] = [];
    this.ranges = [];
    for (const s of sectors.values()) {
      const first = vertices.length / VERTEX_SIZE;
      // Fill then arc, for both shapes (tlpktvqv). Legs stay sector-only:
      // dir(0) === dir(360), a full circle would draw a spurious due-north leg.
      pushWedge(vertices, s, tint(s.arc, WEDGE_ALPHA));
      pushArc(vertices, s, COL.outlineHalf, s.outline);
      pushArc(vertices, s, s.arcHalf, s.arc);
      if (s.hasSector) {
        const legColor = tint(s.arc, LEG_ALPHA);
        pushLeg(vertices, s.a1, s.legRadius, legColor);
        pushLeg(vertices, s.a2, s.legRadius, legColor);
      }
      this.ranges.push({
        lng: s.lng,
        lat: s.lat,
        first,
        count: vertices.length / VERTEX_SIZE - first,
        scamin: s.scamin,
      });
    }
    this.vertexCount = vertices.length / VERTEX_SIZE;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    this.cacheKey = null; // ranges changed — render's frame cache is stale
    map.triggerRepaint();
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, _args: CustomRenderMethodInput): void {
    const map = this.map;
    if (!map || !this.visible || !this.program || this.vertexCount === 0) return;
    // Fractional zoom, re-read per frame: fades across the threshold rather
    // than popping at an integer zoom.
    const zoom = map.getZoom();
    const B = this.chartDetail();
    const canvas = map.getCanvas();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const stride = VERTEX_SIZE * 4;
    gl.enableVertexAttribArray(this.aOffset);
    gl.vertexAttribPointer(this.aOffset, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.aColor);
    gl.vertexAttribPointer(this.aColor, 4, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(this.aAa);
    gl.vertexAttribPointer(this.aAa, 3, gl.FLOAT, false, stride, 24);
    // One device pixel in CSS px — the width of the anti-aliasing fade.
    gl.uniform1f(this.uAa, 1 / (map.getPixelRatio() || 1));
    // px -> NDC (y flipped: pixel y grows down)
    gl.uniform2f(this.uScale, 2 / w, -2 / h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // colours are opaque/premultiplied

    // `render` fires on every map repaint, not only camera moves (a live AIS
    // tick, another overlay's setData…). Cache `map.project`/fade keyed on
    // the transform bits that can change them, redo the loop only when one did.
    const center = map.getCenter();
    const key = `${zoom}|${center.lng}|${center.lat}|${map.getBearing()}|${map.getPitch()}|${w}|${h}|${B}`;
    // Worst case (largest possible legRadius) since radius now varies per light.
    const margin = RADIUS_MAX * LEG_RADIUS_FACTOR + 8;
    if (key !== this.cacheKey || this.frameCache.length !== this.ranges.length) {
      this.cacheKey = key;
      this.frameCache = this.ranges.map((range) => {
        const alpha = fadeOpacity(zoom, range.scamin, B);
        if (alpha <= 0) return { x: 0, y: 0, alpha: 0, onScreen: false };
        const p = map.project([range.lng, range.lat]);
        const onScreen = !(p.x < -margin || p.x > w + margin || p.y < -margin || p.y > h + margin);
        return { x: (p.x / w) * 2 - 1, y: 1 - (p.y / h) * 2, alpha, onScreen };
      });
    }

    for (let i = 0; i < this.ranges.length; i++) {
      const range = this.ranges[i]!;
      const c = this.frameCache[i]!;
      if (!c.onScreen) continue;
      gl.uniform1f(this.uAlpha, c.alpha * this.groupOpacity);
      gl.uniform2f(this.uCenter, c.x, c.y);
      gl.drawArrays(gl.TRIANGLES, range.first, range.count);
    }
    // Leave no attribute enabled that MapLibre's next draw doesn't expect —
    // `a_aa` in particular is a third slot its own programs may not bind.
    gl.disableVertexAttribArray(this.aOffset);
    gl.disableVertexAttribArray(this.aColor);
    gl.disableVertexAttribArray(this.aAa);
  }
}

/**
 * The lights overlay, a MapLibre custom (WebGL) layer — a factory closing
 * over the live `SectorLightLayer` instance `wireMap` owns, so it stays a
 * MapView baseOverlay rather than a declarative feature slot. `Z.sectorLights`
 * is NEGATIVE (see docs/architecture/sector-lights-overlay.md) so the
 * per-ensure/-update safety hoist doesn't override its z-order.
 */
export function createSectorLightsOverlay(layer: SectorLightLayer): Overlay {
  return {
    id: "sector-lights",
    layerIds: [SECTOR_LIGHTS_LAYER_ID],
    z: Z.sectorLights,
    ensure(map) {
      if (!map.getLayer(SECTOR_LIGHTS_LAYER_ID)) map.addLayer(layer);
      layer.scheduleRefresh();
    },
    update(_map, ctx) {
      const settings = ctx.settings();
      layer.setVisible(lightsOverlayVisible(settings));
      layer.setGroupOpacity(lightsOverlayOpacity(settings));
    },
  };
}
