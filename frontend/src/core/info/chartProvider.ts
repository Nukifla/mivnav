// The chart-object info provider: S-57 features under the tap, as InfoHits.
// See docs/architecture/chart-info-provider.md for what queryRenderedFeatures
// returns, SCAMIN semantics, and the sector-light hit-test workaround.

import type { MapGeoJSONFeature, PointLike } from "maplibre-gl";
import type { Component } from "solid-js";
import WavesHorizontal from "lucide-solid/icons/waves-horizontal";
import ArrowDownToLine from "lucide-solid/icons/arrow-down-to-line";
import CircleQuestionMark from "lucide-solid/icons/circle-question-mark";
import { WreckGlyph } from "./WreckGlyph";
import { createSectorLightGlyph, type LightSegment } from "./SectorLightGlyph";
import { createChartIconStack, type AidLayerSprite } from "./ChartSpriteIcon";
import { lightFlareRotationDeg } from "../style/aidsHazards";
import { isAreaHitLayerId } from "../style/areaHit";
import { iconRoleColors, paletteColors, type S52Table } from "../style/colors";
import { isIsolatedDangerProps } from "../style/isolatedDanger";
import { lightHasOwnSymbol, sectorAngles } from "../style/sectorGate";
import { THEME_BY_ID } from "../style/themes";
import type { ChartSettings } from "../style/settings";
import { scopedQuery, type QueryScope } from "./queryGuard";
import { priorityRank } from "./rank";
import { attrLabel, attrOrder, classTitle, decodeAttr, isS57Attr, trimLitdsn } from "./s57";
import type {
  InfoDetail,
  InfoHit,
  InfoIconProps,
  InfoNote,
  InfoPrecision,
  InfoPriority,
  InfoProvider,
  InfoQuery,
  InfoRow,
  InfoSection,
} from "./types";

export const CHART_PROVIDER_ID = "chart";

/** Source-id prefix the style generator gives every chart set
 * (`chart-${set.id}`, ../style/chartStyle.ts). Mirrored rather than imported:
 * chartStyle.ts does not export it. */
const CHART_SOURCE_PREFIX = "chart-";

/** The chart set a hit's feature came from (#snyzntrn): the tile's own `set`
 * tag first (o-charts sets share one `chart-all` source, so a plain slice
 * would misname them `"all"`), else the old `source.slice` fallback. */
function chartSetIdOf(hit: { source: string; props: Props }): string {
  const tagged = hit.props.set;
  return typeof tagged === "string" && tagged
    ? tagged
    : hit.source.slice(CHART_SOURCE_PREFIX.length);
}

/** Layer-id prefix of the selection highlight (./highlight.ts): it also
 * matches `source: chart-*` and must be excluded — it sits topmost, so its
 * copy would arrive first and (first-of-run) override the real hit's answer. */
export const INFO_HIGHLIGHT_LAYER_PREFIX = "info-highlight";

/** The chart provider's declared query scope (./queryGuard.ts): every hit
 * `queryAt` sees is already filtered to `chart-*` minus the highlight — a
 * foreign source (raster, SignalK/route/weather overlay) never reaches it. */
export const CHART_QUERY_SCOPE: QueryScope = {
  sourcePrefixes: [CHART_SOURCE_PREFIX],
  excludeLayerPrefixes: [INFO_HIGHLIGHT_LAYER_PREFIX],
};

/** How much a mariner cares about each class. The bands are the design: "what
 * can hurt me" → "what do I steer by" → "what's not allowed here" → "how deep"
 * → "where's the land" → background. An unlisted class falls to `context`. */
const CLASS_PRIORITY: Record<string, InfoPriority> = {
  WRECKS: "hazard",
  OBSTRN: "hazard",
  UWTROC: "hazard",
  ATON: "aid",
  LIGHTS: "aid",
  TOPMAR: "aid",
  DAYMAR: "aid",
  RESARE: "regulated",
  ACHARE: "regulated",
  CTNARE: "regulated",
  MIPARE: "regulated",
  DMPGRD: "regulated",
  SOUNDG: "depth",
  DEPCNT: "depth",
  COALNE: "land",
  SLCONS: "land",
  LNDARE: "land",
  LNDRGN: "land",
  DEPARE: "area",
  DRGARE: "area",
  UNSARE: "context",
  _nodata: "context",
};

/** Layers excluded from info-at-point though drawn: SLCONS/COALNE are
 * render-only (chartcore strips their tags, #IAP-STRUCTURAL-STRIP); LNDARE/
 * LNDRGN (#INFO-LNDARE-STRIP) so tapping land selects nothing, not "Land". */
const INFO_EXCLUDE_LAYERS: ReadonlySet<string> = new Set([
  "SLCONS",
  "COALNE",
  "LNDARE",
  "LNDRGN",
]);

/** Where a tap that only falls INSIDE a drawn-but-unfilled area ranks: the
 * background-area tier, with DEPARE — the same call features/notices makes
 * for its own areas (`INTERIOR_PRIORITY` there). The class's own tier
 * (`regulated`, …) would put a firing area spanning half a sea first on every
 * tap inside it; the user asked only that it be in the list ("maybe not first
 * but it should be there"). A tap on its boundary or centred symbol keeps the
 * class tier. See docs/architecture/chart-info-provider.md ("Area interiors"). */
export const AREA_INTERIOR_PRIORITY: InfoPriority = "area";

/** The tier of an interior-only hit: never promoted, only capped at
 * `AREA_INTERIOR_PRIORITY` (a `context` class stays `context`). */
function interiorPriority(own: InfoPriority): InfoPriority {
  return priorityRank(own) < priorityRank(AREA_INTERIOR_PRIORITY) ? AREA_INTERIOR_PRIORITY : own;
}

type Props = Readonly<Record<string, unknown>>;

function num(props: Props, key: string): number | undefined {
  const v = props[key];
  return typeof v === "number" ? v : undefined;
}

/** The official isolated-danger predicate. Lives ONCE in
 * ../style/isolatedDanger.ts; the chart's MapLibre expression
 * (../style/aidsHazards.ts) is generated from the same definition. */
export function isIsolatedDanger(
  sourceLayer: string,
  props: Props,
  settings: ChartSettings,
): boolean {
  return isIsolatedDangerProps(sourceLayer, props, settings.safetyContour);
}

function precisionOf(type: string): InfoPrecision {
  if (type === "Point" || type === "MultiPoint") return "point";
  if (type === "LineString" || type === "MultiLineString") return "line";
  return "area";
}

/** Identity of the S-57 object behind a style-layer hit: keyed on properties,
 * not the RCID right there in `feature.id` — dedup and identity are different
 * questions. See docs/architecture/chart-info-provider.md ("hitId"). */
function hitId(feature: MapGeoJSONFeature): string {
  const props = feature.properties ?? {};
  const stable = Object.keys(props)
    .sort()
    .map((k) => `${k}=${String(props[k])}`)
    .join("");
  const base = `${feature.source}${feature.sourceLayer}${stable}`;
  // Exception (#AID-PICK-PARTIAL): two components of one aid can be
  // byte-identical in decoded props but are distinct S-57 objects, so a
  // grouped aid component is also keyed by RCID (others still content-dedup).
  const rcid = rcidOf(feature);
  if (
    rcid !== undefined &&
    typeof props.aid_group === "string" &&
    props.aid_group &&
    feature.sourceLayer !== undefined &&
    AID_COMPONENT_CLASSES.has(feature.sourceLayer)
  ) {
    return `${base}#${rcid}`;
  }
  return base;
}

/** The MVT feature id, when present: chartcore's namespaced RCID
 * (`mvt::cell_namespace`), unique once cells merge into one tile. Absent on
 * derived features sharing a source RCID and on synthetic `_nodata` polygons. */
function rcidOf(feature: MapGeoJSONFeature): number | undefined {
  return typeof feature.id === "number" ? feature.id : undefined;
}

/** The most identifying secondary fact, for the list row and the panel
 * header — a name where the chart gives one, else the number the class is
 * actually about. */
function subtitleOf(sourceLayer: string, props: Props): string | undefined {
  const name = props.OBJNAM;
  const named = typeof name === "string" && name.trim() ? name.trim() : undefined;
  // LNDMRK titles as the generic "Landmark", so its name alone ("Timmendorf")
  // never says it's a tower — name AND category both, the one class where the
  // name doesn't short-circuit below.
  if (sourceLayer === "LNDMRK") return lndmrkSummary(named, props);
  if (named) return named;
  switch (sourceLayer) {
    case "ATON":
      // A nameless buoy/beacon identifies by category + shape — the same summary
      // the detail rows spell out, in one phrase. See `atonSummary`.
      return atonSummary(props);
    case "LIGHTS":
      // The characteristic ("Fl(2)10s"): chartcore's baked `litdsn`, the same
      // string the detail panel and the sector overlay show, not reinvented here.
      return typeof props.litdsn === "string" ? props.litdsn : undefined;
    case "SOUNDG":
      return depthText(num(props, "DEPTH"));
    case "DEPCNT": {
      // also carries line-primitive DEPARE, which has no VALDCO
      const valdco = num(props, "VALDCO");
      return valdco !== undefined ? depthText(valdco) : depthRangeText(props);
    }
    case "DEPARE":
    case "DRGARE":
      return depthRangeText(props);
    case "WRECKS":
    case "OBSTRN":
    case "UWTROC":
      return depthText(num(props, "VALSOU") ?? num(props, "depth_value"));
    default:
      return undefined;
  }
}

/** One decimal at most, and no trailing ".0" — charts print 5 m, not 5.0 m. */
function metres(v: number): string {
  return Number.isInteger(v) ? `${v}` : v.toFixed(1);
}

function depthText(v: number | undefined): string | undefined {
  // 99999 is chartcore's no-depth sentinel (see the SOUNDG layer's filter)
  if (v === undefined || Math.abs(v) > 40000) return undefined;
  // A negative sounding is a drying height, not a depth — saying "-1.5 m"
  // would invite exactly the sign error the wording exists to prevent.
  return v < 0 ? `${metres(-v)} m drying` : `${metres(v)} m`;
}

function depthRangeText(props: Props): string | undefined {
  const lo = num(props, "drval1") ?? num(props, "DRVAL1");
  const hi = num(props, "drval2") ?? num(props, "DRVAL2");
  if (lo === undefined && hi === undefined) return undefined;
  if (lo === undefined) return `to ${depthText(hi)}`;
  if (hi === undefined) return `from ${depthText(lo)}`;
  return lo === hi ? depthText(lo) : `${metres(lo)}–${metres(hi)} m`;
}

/** A buoy/beacon in a phrase — IALA category + physical shape — for the list
 * subtitle of an aid with no name: CATCAM=2 + BOYSHP=5 → "East cardinal · spar".
 * `undefined` when the aid names neither, rather than a bare dot. */
function atonSummary(props: Props): string | undefined {
  const category = atonCategory(props);
  const shape =
    props.BOYSHP !== undefined
      ? decodeAttr("BOYSHP", props.BOYSHP)
      : props.BCNSHP !== undefined
        ? decodeAttr("BCNSHP", props.BCNSHP)
        : undefined;
  const parts = [category, shape].filter((p): p is string => !!p);
  if (!parts.length) return undefined;
  const phrase = parts.join(" · ");
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** The aid's mark category as a noun phrase: cardinals name their quadrant,
 * laterals their hand, special-purpose reads generically (the CATSPM purpose
 * is a detail row, too long for the summary line). */
function atonCategory(props: Props): string | undefined {
  if (props.CATCAM !== undefined) {
    const cam = decodeAttr("CATCAM", props.CATCAM);
    return cam ? `${cam} cardinal` : undefined;
  }
  if (props.CATLAM !== undefined) return decodeAttr("CATLAM", props.CATLAM) || undefined;
  if (props.CATSPM !== undefined) return "special purpose";
  return undefined;
}

/** A landmark in a phrase: name + category, joined the same way a composite
 * aid joins name and characteristic (../info/s57.ts `trimLitdsn`) — "Timmendorf
 * · tower". `undefined` when both are missing, rather than a bare dot. */
function lndmrkSummary(name: string | undefined, props: Props): string | undefined {
  const parts = [name, lndmrkCategory(props)].filter((p): p is string => !!p);
  if (!parts.length) return undefined;
  const phrase = parts.join(" · ");
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** FUNCTN codes that name a landmark better than its CATLMK shape: a church is
 * CATLMK=15/17/20 *plus* FUNCTN=20, and FUNCTN is what a mariner recognises it
 * by — chartcore's symbol pick makes the same call (`derive/lndmrk.rs`). */
const LNDMRK_FUNCTN_FIRST = new Set([20, 21, 22, 23, 24, 25, 26, 27]);

/** The landmark's category as one lowercase word, from CATLMK/FUNCTN. Not read
 * off chartcore's baked `sym` — icon names aren't display words, and some
 * S-57 categories (cemetery, memorial plaque) have no icon at all. */
function lndmrkCategory(props: Props): string | undefined {
  // Both are S-57 list-valued attributes, so the tile carries them
  // comma-joined ("15,17") — MVT has no list type (chartcore `attr_to_tag`).
  const codes = (v: unknown): number[] =>
    v === undefined || v === null
      ? []
      : String(v)
          .split(",")
          .map((c) => Number(c.trim()))
          .filter(Number.isFinite);
  // A code outside the S-57 domain decodes back to its own number
  // (`decodeAttr`'s honest fallback) — fine as a detail row, useless as a
  // subtitle, so it counts as "no category" here.
  const word = (acronym: string, code: number): string | undefined => {
    const text = decodeAttr(acronym, code);
    return text && !/^\d+$/.test(text) ? text : undefined;
  };
  const functn = codes(props.FUNCTN);
  const preferred = functn.find((c) => LNDMRK_FUNCTN_FIRST.has(c));
  if (preferred !== undefined) return word("FUNCTN", preferred);
  const catlmk = codes(props.CATLMK);
  // First code wins when a landmark claims several shapes — the chart lists
  // them in its own order and there is no "most important" among them.
  return (
    catlmk.map((c) => word("CATLMK", c)).find(Boolean) ??
    functn.map((c) => word("FUNCTN", c)).find(Boolean)
  );
}

/** chartcore's lowercase derived facts worth showing a mariner, and what to
 * call them. The rest (sym_s, lsty, dispcat, bcol, …) are presentation
 * plumbing and would be noise. */
const DERIVED_LABELS: Record<string, string> = {
  depth_value: "Depth used for symbology (m)",
  encl_drval1: "Surrounding depth area, min (m)",
  drval1: "Minimum depth (m)",
  drval2: "Maximum depth (m)",
  litdsn: "Light description",
  floating: "Floating aid",
};

/** Attributes whose *value* names an external text file, not a fact to read —
 * rendered as a lazily-fetched note (`textNotes`, #87-fork) instead of a row.
 * TXTDSC/NTXTDS are the same fact in two languages, folded into one `InfoNote`. */
const TEXT_ATTR_KEYS = new Set(["TXTDSC", "NTXTDS"]);

/** `suppressLitdsn` drops the derived "Light description" row when it merely
 * restates the hit's own subtitle — true for a standalone light, false when
 * folded into a composite aid (its own subtitle is the buoy's name, not litdsn). */
function rowsFor(
  sourceLayer: string,
  props: Props,
  danger: boolean,
  suppressLitdsn = true,
): InfoRow[] {
  const rows: InfoRow[] = [];
  if (danger) {
    rows.push({
      label: "Isolated danger",
      value: "shallower than your safety contour, in deeper water",
      emphasis: true,
    });
  }
  // Raw S-57 truth first, in ./s57.ts's reading order — minus the ones whose
  // value is a filename, which become notes below rather than a bare row.
  const s57 = Object.keys(props)
    .filter((k) => isS57Attr(k) && !TEXT_ATTR_KEYS.has(k))
    .sort((a, b) => attrOrder(a) - attrOrder(b) || a.localeCompare(b));
  for (const key of s57) {
    const value = decodeAttr(key, props[key]);
    if (value === "") continue;
    rows.push({ label: attrLabel(key), value });
  }
  // Then the derived facts, minus the ones that merely restate a raw
  // attribute we just printed.
  for (const [key, label] of Object.entries(DERIVED_LABELS)) {
    if (props[key] === undefined || props[key] === null) continue;
    if (key === "drval1" && props.DRVAL1 !== undefined) continue;
    if (key === "drval2" && props.DRVAL2 !== undefined) continue;
    if (key === "litdsn" && suppressLitdsn && subtitleOf(sourceLayer, props) === props.litdsn)
      continue;
    rows.push({ label, value: String(props[key]) });
  }
  return rows;
}

/** What a chart hit carries beyond the seam's vocabulary: everything `detail`
 * prints and everything ./highlight.ts needs to find the object again in the
 * tiles. Provider-private — `chartHitPayload` is the only way in. */
export interface ChartHitPayload {
  sourceLayer: string;
  source: string;
  props: Props;
  danger: boolean;
  /** The namespaced MVT feature id, unique per TILE not merely per cell (bare
   * RCIDs collide across merged cells — measured on the DK set). See
   * docs/architecture/chart-info-provider.md ("ChartHitPayload.rcid"). */
  rcid?: number;
  /** Set when the tap reached this object ONLY through its area's invisible
   * interior tap target (../style/areaHit.ts) — neither its boundary nor its
   * centred symbol was under the tap. Absent otherwise. Read through
   * `chartInteriorOnlyArea`. */
  interiorOnly?: true;
  /** The non-primary components of a *composite aid* hit (topmark/light/
   * daymark), in section order. Absent on an ordinary hit; the primary's own
   * fields are this payload's directly, so callers don't know it's composite. */
  components?: ChartHitPayload[];
}

/** The chart provider's payload, or `undefined` for a hit that is not its —
 * routed on `providerId` like every other lookup in the seam (./registry.ts),
 * so a vessel hit cannot be mistaken for a chart object by shape alone. */
export function chartHitPayload(hit: InfoHit | undefined): ChartHitPayload | undefined {
  if (!hit || hit.providerId !== CHART_PROVIDER_ID) return undefined;
  return hit.payload as ChartHitPayload | undefined;
}

/**
 * The class and attributes of a chart AREA hit that answered the tap only
 * because the tap fell inside it (see `AREA_INTERIOR_PRIORITY`), or
 * `undefined` for every other hit — a tap on the area's own boundary line or
 * centred symbol, a point or line object, another provider's hit. For a
 * provider that holds a better record of the same real area and wants to
 * supersede the chart's bare outline (`InfoProvider.supersedes`): "the user
 * tapped somewhere inside it" is superseded, "the user pointed at the charted
 * object" never is.
 */
export function chartInteriorOnlyArea(
  hit: InfoHit | undefined,
): { sourceLayer: string; props: Readonly<Record<string, unknown>> } | undefined {
  const payload = chartHitPayload(hit);
  if (!payload?.interiorOnly) return undefined;
  return { sourceLayer: payload.sourceLayer, props: payload.props };
}

export interface ChartProviderOptions {
  /** `queryRenderedFeatures` answers taps; `hasImage` tells the panel the map
   * really carries a symbol before offering to draw it (`icon`). `hasImage` is
   * optional so an omitting test double just yields no chart icon. */
  map: {
    queryRenderedFeatures(geometry?: PointLike | [PointLike, PointLike]): MapGeoJSONFeature[];
    hasImage?(id: string): boolean;
    /** Re-query a grouped aid's own anchor when a tap landed on a light's
     * offset flare alone (`augmentLightOnlyAids`). Optional so a
     * `queryRenderedFeatures`-only double just skips that re-query. */
    project?(lngLat: { lng: number; lat: number }): { x: number; y: number };
  };
  /** Read live: the isolated-danger promotion compares against the mariner's
   * safety contour, so the same tap answers differently after a settings
   * change — exactly as the chart repaints. */
  settings: () => ChartSettings;
  /** Fetch an external S-57 text file (`TXTDSC`/`NTXTDS`) by chart-set id and
   * filename. Injected for tests; defaults to the backend `/api/text`
   * endpoint, which enforces the path-safety contract on the filename. */
  loadText?: (setId: string, name: string) => Promise<string>;
}

/** The default `loadText` (`mivnav.api.charts.text`). The 404 message, shown
 * verbatim (`NoteBlock`), separates "this set doesn't ship that note" (a
 * chart fact) from a real failure — they used to read alike. */
export async function fetchChartText(setId: string, name: string): Promise<string> {
  const url = `/api/text/${encodeURIComponent(setId)}/${encodeURIComponent(name)}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error("The chart server didn’t answer.");
  }
  if (res.status === 404) throw new Error(`This chart set doesn’t include the note ${name}.`);
  if (!res.ok) throw new Error(`Couldn’t load the note ${name} (HTTP ${res.status}).`);
  return res.text();
}

function textAttr(props: Props, key: string): string | undefined {
  const value = props[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** The lazily-fetched note a hit's TXTDSC/NTXTDS attributes turn into. `[]` if
 * neither is present; one `InfoNote` otherwise — TXTDSC is the default, NTXTDS
 * becomes `alt` when both are present so the panel offers a toggle (#87-fork). */
function textNotes(
  setId: string,
  props: Props,
  loadText: (setId: string, name: string) => Promise<string>,
): InfoNote[] {
  const intl = textAttr(props, "TXTDSC");
  const natl = textAttr(props, "NTXTDS");
  if (intl && natl) {
    return [
      {
        label: "Text description",
        load: () => loadText(setId, intl),
        alt: { label: "Text description (national language)", load: () => loadText(setId, natl) },
      },
    ];
  }
  if (intl) return [{ label: "Text description", load: () => loadText(setId, intl) }];
  if (natl) {
    return [{ label: "Text description (national language)", load: () => loadText(setId, natl) }];
  }
  return [];
}

/** The S-52 sprite id a tapped feature wears, or `undefined` with no point
 * symbol: a promoted isolated danger wears `ISODGR51` as the chart overpaints
 * it, else `sym`/`sym_s`/`sym_cs`/`sym_pos`, the style's own precedence. */
export function chartSpriteId(payload: ChartHitPayload): string | undefined {
  return spriteName(payload);
}

function spriteName(payload: ChartHitPayload): string | undefined {
  if (payload.danger) return "ISODGR51";
  const props = payload.props;
  // A WRECKS with QUASOU=7 ("depth unknown") wears the dangerous-wreck symbol
  // on the chart whatever its baked `sym` says (../style/aidsHazards.ts,
  // lppokvtq); `quasou7` is derived for WRECKS only, so no other class sees it.
  if (props.quasou7) return "wreck-dangerous";
  const str = (key: string): string | undefined => {
    const v = props[key];
    return typeof v === "string" && v ? v : undefined;
  };
  return str("sym") ?? str("sym_s") ?? str("sym_cs") ?? str("sym_pos");
}

/** `../style/aidsHazards.ts`'s own `-lights-sym` `icon-rotate`, evaluated
 * against a LIGHTS feature so the panel's flare matches the map's — off the
 * SAME expression, not a second copy that could drift. */
function lightRotateDeg(sourceLayer: string, props: Props): number | undefined {
  return sourceLayer === "LIGHTS" ? lightFlareRotationDeg(props) : undefined;
}

/** The stacked symbol layers of a composite aid icon: the primary structure as
 * `base`, then each folded-in component the map really carries. `undefined`
 * when even the base symbol isn't carried (the icon then falls to the chip). */
export function aidIconLayers(
  payload: ChartHitPayload,
  onSheet: (id: string | undefined) => id is string,
): AidLayerSprite[] | undefined {
  const baseId = chartSpriteId(payload);
  if (!onSheet(baseId)) return undefined;
  const layers: AidLayerSprite[] = [
    { spriteId: baseId, role: "base", rotateDeg: lightRotateDeg(payload.sourceLayer, payload.props) },
  ];
  for (const comp of payload.components ?? []) {
    const compId = chartSpriteId(comp);
    if (onSheet(compId)) {
      layers.push({
        spriteId: compId,
        role: aidLayerRole(comp.sourceLayer),
        rotateDeg: lightRotateDeg(comp.sourceLayer, comp.props),
      });
    }
  }
  return layers;
}

/** The S-52 colour a `lit_col` token resolves to, the same set
 * `sector-lights/overlay.ts` `arcColors` draws arcs from. Unlisted tokens fall
 * back to magenta, matching `derive/lights.rs`'s own rule. */
function litColor(token: string, C: S52Table): string {
  switch (token) {
    case "LITRD":
      return C.LITRD;
    case "LITGN":
      return C.LITGN;
    case "LITYW":
      return C.LITYW;
    default:
      return C.CHMGD;
  }
}

/** A LIGHTS hit's own sector geometry. Angles come from `sectorAngles`
 * (../style/sectorGate.ts), the exact function the sector-lights overlay
 * derives the SAME feature's on-chart arc from, so they can't disagree. */
export function lightSegments(
  payload: ChartHitPayload,
  settings: ChartSettings,
): LightSegment[] {
  const C = paletteColors(settings.palette);
  const outline = THEME_BY_ID[settings.palette]?.sectorOutline === false ? undefined : C.OUTLW;
  const lightProps = [payload, ...(payload.components ?? [])]
    .filter((p) => p.sourceLayer === "LIGHTS")
    .map((p) => p.props);
  return lightProps.map((props) => {
    const { a1, a2, hasSector } = sectorAngles(props);
    const token = typeof props.lit_col === "string" ? props.lit_col : "CHMGD";
    return { a1, a2, hasSector, color: litColor(token, C), outline };
  });
}

/** Dedicated, recognizable glyphs for classes the sprite path serves poorly.
 * LIGHTS is deliberately absent — `icon` builds its glyph directly, per-feature.
 * See docs/architecture/chart-info-provider.md ("CLASS_ICONS"). */
const CLASS_ICONS: Record<string, Component<InfoIconProps>> = {
  DEPARE: WavesHorizontal,
  DRGARE: WavesHorizontal,
  DEPCNT: WavesHorizontal,
  UNSARE: CircleQuestionMark,
  SOUNDG: ArrowDownToLine,
  WRECKS: WreckGlyph,
};

/** The last-resort glyph (#INFO-ICONS-COMPLETE) for a hit with neither a
 * `CLASS_ICONS` glyph nor an S-52 point symbol — replaces the priority chip
 * as the floor, so every info-at-point type shows a picture. */
const GENERIC_ICON: Component<InfoIconProps> = CircleQuestionMark;

export function createChartInfoProvider(opts: ChartProviderOptions): InfoProvider {
  const loadText = opts.loadText ?? fetchChartText;
  // Bound once to CHART_QUERY_SCOPE, so the loop below never re-checks the
  // source or excludes the highlight itself.
  const query = scopedQuery(opts.map, CHART_QUERY_SCOPE);
  return {
    id: CHART_PROVIDER_ID,
    label: "Chart",

    queryAt(q: InfoQuery): InfoHit[] {
      const { x, y } = q.point;
      const r = q.radius;
      const settings = opts.settings();
      const features = query([
        [x - r, y - r],
        [x + r, y + r],
      ]);
      const byId = new Map<string, InfoHit>();
      const hits: InfoHit[] = [];
      collectChartHits(features, settings, q.lngLat, byId, hits);
      // A tap on a lit aid's flare can land on LIGHTS alone (drawn offset from
      // the pivot); re-query the light's own anchor to pull the buoy in.
      const augmented = augmentLightOnlyAids(hits, (anchor) => {
        // Call `project` on its receiver: MapLibre's `Map.project` reads
        // `this.transform`, and a bare variable would detach `this`.
        if (typeof opts.map.project !== "function") return [];
        const p = opts.map.project(anchor);
        const requeried = query([
          [p.x - r, p.y - r],
          [p.x + r, p.y + r],
        ]);
        const out: InfoHit[] = [];
        collectChartHits(requeried, settings, anchor, new Map(), out);
        return out;
      });
      // Fold a lit buoy's components into one aid hit, then fold the tap's
      // depth objects into one "Depth" hit — disjoint classes, order doesn't matter.
      return mergeDepth(mergeAidComponents(augmented));
    },

    detail(hit: InfoHit): InfoDetail {
      const payload = chartHitPayload(hit);
      if (!payload) {
        // A chart hit only exists as map-query output: its attributes come from
        // the tile the tap landed on, and the RCID addresses a drawn feature
        // *within this set's tiles*, not a catalogue record (see `rcid`).
        return { sections: [{ rows: [{ label: "Detail", value: "not available" }] }] };
      }
      const { sourceLayer, props, danger, components } = payload;
      const setId = chartSetIdOf(payload);
      const sections: InfoSection[] = [{ rows: rowsFor(sourceLayer, props, danger) }];
      const notes = textNotes(setId, props, loadText);
      // One titled section per folded-in component. Each fetches text notes
      // under its OWN set id (#snyzntrn: co-located components can in
      // principle carry different owning sets; the wrong one 404s outright).
      for (const comp of components ?? []) {
        sections.push({
          label: componentSectionLabel(comp.sourceLayer),
          rows: rowsFor(comp.sourceLayer, comp.props, comp.danger, false),
        });
        notes.push(...textNotes(chartSetIdOf(comp), comp.props, loadText));
      }
      // One Chart section for the whole aid — the components share a set, so
      // repeating the chart-set row per section would be noise.
      sections.push({
        label: "Chart",
        rows: [
          { label: "Chart set", value: setId },
          { label: "Object class", value: sourceLayer },
        ],
      });
      return {
        sections,
        notes: notes.length ? notes : undefined,
      };
    },

    /** Precedence: class glyph → S-52 symbol → generic question-mark, with a
     * light and a composite aid resolved specially. See
     * docs/architecture/chart-info-provider.md ("icon precedence"). */
    icon(hit: InfoHit): Component<InfoIconProps> | undefined {
      const payload = chartHitPayload(hit);
      if (!payload) return undefined;
      const settings = opts.settings();
      if (payload.sourceLayer === "LIGHTS" && !lightHasOwnSymbol(payload.props)) {
        return createSectorLightGlyph(lightSegments(payload, settings));
      }
      const classIcon = CLASS_ICONS[payload.sourceLayer];
      if (classIcon) return classIcon;
      const onSheet = (id: string | undefined): id is string =>
        !!id && !!opts.map.hasImage?.(id);
      // A composite aid: the base structure plus each component symbol the map
      // carries, stacked over it (see `aidIconLayers`).
      const layers = aidIconLayers(payload, onSheet);
      // Icons fetch palette-neutral (`?roles=1`) and colour client-side, exactly
      // as the map's own loader does; ./HitIcon.tsx re-derives on settings change.
      if (layers) return createChartIconStack(layers, iconRoleColors(settings.palette));
      // An object that NAMES a symbol (`chartSpriteId` defined) just isn't drawn
      // on THIS map — decline and let the caller fall back. One that names none
      // never had a symbol, so it takes the generic icon (#INFO-ICONS-COMPLETE).
      return chartSpriteId(payload) === undefined ? GENERIC_ICON : undefined;
    },
  };
}

/** Turn a query's raw features into deduped chart hits. Factored out of
 * `queryAt` so a re-query (`augmentLightOnlyAids`) builds hits by the same
 * rule. Deduped here, not left to `dedupeHits`, to adopt a duplicate's RCID. */
function collectChartHits(
  features: MapGeoJSONFeature[],
  settings: ChartSettings,
  fallbackLngLat: { lng: number; lat: number },
  byId: Map<string, InfoHit>,
  hits: InfoHit[],
): void {
  // Hits seen so far ONLY through an area's invisible interior tap target
  // (../style/areaHit.ts), with the tier they take back if a drawn layer of
  // the same object — its boundary, its symbol — turns up under the tap too.
  const interiorOnly = new Map<string, InfoPriority>();
  for (const feature of features) {
    // `query` already dropped every foreign source and the highlight; a
    // feature with no source-layer can't be filed to a class.
    const sourceLayer = feature.sourceLayer;
    if (!sourceLayer) continue;
    if (INFO_EXCLUDE_LAYERS.has(sourceLayer)) continue;
    const id = hitId(feature);
    const rcid = rcidOf(feature);
    const interior = isAreaHitLayerId(feature.layer?.id);
    const seen = byId.get(id);
    if (seen) {
      // Query order is z-order, and the tap target sits at the bottom — but
      // don't depend on it: whichever arrives first, a drawn layer wins.
      const ownPriority = interiorOnly.get(id);
      if (!interior && ownPriority !== undefined) {
        seen.priority = ownPriority;
        interiorOnly.delete(id);
      }
      // An area's derived label point carries no RCID and is normally *first*
      // (drawn above the fill) — adopt a later duplicate's RCID instead.
      const payload = chartHitPayload(seen);
      if (!interior && payload) delete payload.interiorOnly;
      if (payload && payload.rcid === undefined) payload.rcid = rcid;
      continue;
    }
    const props: Props = feature.properties ?? {};
    const danger = isIsolatedDanger(sourceLayer, props, settings);
    const payload: ChartHitPayload = {
      sourceLayer,
      source: feature.source,
      props,
      danger,
      rcid,
    };
    if (interior) payload.interiorOnly = true;
    const ownPriority: InfoPriority = danger ? "danger" : (CLASS_PRIORITY[sourceLayer] ?? "context");
    if (interior) interiorOnly.set(id, ownPriority);
    const hit: InfoHit = {
      providerId: CHART_PROVIDER_ID,
      id,
      priority: interior ? interiorPriority(ownPriority) : ownPriority,
      precision: precisionOf(feature.geometry?.type ?? "Polygon"),
      title: classTitle(sourceLayer, props),
      subtitle: subtitleOf(sourceLayer, props),
      // A point object answers "where?" with itself; everything else answers
      // with WHERE YOU ASKED — a depth area has no position, and deciding
      // "in view" for a polygon bigger than the screen is ./highlight.ts's job.
      lngLat: pointLngLat(feature) ?? fallbackLngLat,
      payload,
    };
    byId.set(id, hit);
    hits.push(hit);
  }
}

function pointLngLat(feature: MapGeoJSONFeature): { lng: number; lat: number } | undefined {
  const geometry = feature.geometry;
  if (!geometry || geometry.type !== "Point") return undefined;
  const [lng, lat] = geometry.coordinates;
  return { lng, lat };
}

// Merging an aid's components: a lit buoy is 3 co-located S-57 objects, merged
// on chartcore's `aid_group` tag, not a coordinate recomputed here. See
// docs/architecture/chart-info-provider.md ("Merging an aid's components").

/** The S-57 classes that make up one physical aid and may be folded together
 * when co-located; DAYMAR sits on its beacon the same way TOPMAR sits on a buoy. */
const AID_COMPONENT_CLASSES = new Set(["ATON", "TOPMAR", "LIGHTS", "DAYMAR"]);

/** Primary-selection precedence: the structure wins, then a light, then the
 * marks. Lower index = more likely to be the aid the mariner tapped. */
const PRIMARY_ORDER = ["ATON", "LIGHTS", "TOPMAR", "DAYMAR"];

/** Order the folded-in components appear as sections: topmark, then light, then
 * daymark — the primary's own rows come first, before any of these. */
const COMPONENT_SECTION_ORDER = ["TOPMAR", "LIGHTS", "DAYMAR"];

/** The stacking role of a folded-in component's sprite in the composite icon
 * (`createCompositeAidIcon`). A LIGHTS flare rides upper-right; a TOPMAR/DAYMAR
 * perches above the structure. */
function aidLayerRole(sourceLayer: string): AidLayerSprite["role"] {
  switch (sourceLayer) {
    case "LIGHTS":
      return "light";
    case "DAYMAR":
      return "daymark";
    default:
      return "topmark";
  }
}

function componentSectionLabel(sourceLayer: string): string {
  switch (sourceLayer) {
    case "TOPMAR":
      return "Topmark";
    case "LIGHTS":
      return "Light";
    case "DAYMAR":
      return "Daymark";
    default:
      return classTitle(sourceLayer, {});
  }
}

function orderIn(order: string[], value: string): number {
  const i = order.indexOf(value);
  return i < 0 ? order.length : i;
}

/** The grouping key of a hit eligible to merge, or `undefined`: the
 * chartcore-derived `aid_group` tag, emitted only on components of a
 * multi-object aid — the tile already decided which objects are one aid. */
function aidComponentKey(hit: InfoHit): string | undefined {
  const payload = chartHitPayload(hit);
  if (!payload || !AID_COMPONENT_CLASSES.has(payload.sourceLayer)) return undefined;
  const group = payload.props.aid_group;
  return typeof group === "string" && group ? group : undefined;
}

/** A group is one physical aid — mergeable — when it has ≥2 co-located
 * components AND at most one structure (ATON): two buoys at one point are two
 * distinct aids, so a second structure leaves the group wholly unmerged. */
function isMergeableGroup(group: InfoHit[]): boolean {
  if (group.length < 2) return false;
  const structures = group.filter((h) => classOf(h) === "ATON").length;
  return structures <= 1;
}

/** Recover the structure of a grouped aid that a tap on its light MISSED (the
 * flare draws offset from the pivot): re-queries the group's own anchor and
 * adopts same-group members, only when the structure is absent. */
export function augmentLightOnlyAids(
  hits: InfoHit[],
  requery: (anchor: { lng: number; lat: number }) => InfoHit[],
): InfoHit[] {
  const groups = new Map<string, InfoHit[]>();
  for (const hit of hits) {
    const key = aidComponentKey(hit);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(hit);
    else groups.set(key, [hit]);
  }
  const seen = new Set(hits.map((h) => h.id));
  const added: InfoHit[] = [];
  for (const [key, group] of groups) {
    // The structure is already here — the direct-buoy path folds this group as
    // is. Re-querying would only risk pulling the same objects in twice.
    if (group.some((h) => classOf(h) === "ATON")) continue;
    // The group's anchor: a component's own point coordinate. Aid components are
    // point objects, so `lngLat` is the shared aid coordinate, not the tap (a
    // chart hit always carries one; the guard is only for the optional type).
    const anchor = group[0].lngLat;
    if (!anchor) continue;
    for (const hit of requery(anchor)) {
      // Keep only co-located members of THIS group (a box can catch unrelated
      // neighbours) that are not already in the set (the light re-finds itself).
      if (aidComponentKey(hit) !== key) continue;
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      added.push(hit);
    }
  }
  return added.length ? [...hits, ...added] : hits;
}

/** Fold co-located aid components into one composite hit each. A group of one
 * is not a merge — a plain unlit buoy passes straight through unchanged. */
function mergeAidComponents(hits: InfoHit[]): InfoHit[] {
  const groups = new Map<string, InfoHit[]>();
  for (const hit of hits) {
    const key = aidComponentKey(hit);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(hit);
    else groups.set(key, [hit]);
  }
  const emitted = new Set<string>();
  const out: InfoHit[] = [];
  for (const hit of hits) {
    const key = aidComponentKey(hit);
    if (!key || !isMergeableGroup(groups.get(key)!)) {
      out.push(hit);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    out.push(compositeHit(groups.get(key)!));
  }
  return out;
}

/** One composite hit from a co-located group of ≥2 aid components. */
function compositeHit(group: InfoHit[]): InfoHit {
  // Primary = the structure, by `PRIMARY_ORDER`; ties keep query order. Its
  // payload is the composite's payload, so the primary object is what the icon
  // draws and the highlight outlines.
  const ordered = [...group].sort(
    (a, b) => orderIn(PRIMARY_ORDER, classOf(a)) - orderIn(PRIMARY_ORDER, classOf(b)),
  );
  const primary = ordered[0];
  const primaryPayload = chartHitPayload(primary)!;
  // Components (everything but the primary), in section order.
  const components = ordered
    .slice(1)
    .map((h) => chartHitPayload(h)!)
    .sort(
      (a, b) =>
        orderIn(COMPONENT_SECTION_ORDER, a.sourceLayer) -
        orderIn(COMPONENT_SECTION_ORDER, b.sourceLayer),
    );
  // Highest priority across the group: a component that outranks the structure
  // (an isolated-danger promotion, say) keeps its rank on the merged hit.
  const priority = group.reduce(
    (best, h) => (priorityRank(h.priority) < priorityRank(best) ? h.priority : best),
    group[0].priority,
  );
  // Stable, content-derived id from the sorted component ids, so a repeat tap
  // resolves to the same merged hit and dedupe/selection are well-behaved.
  const id = `aid:${group.map((h) => h.id).sort().join("|")}`;
  const payload: ChartHitPayload = { ...primaryPayload, components };
  return {
    ...primary,
    id,
    priority,
    // A lit aid states its light's characteristic after the name/summary
    // ("No 3" → "No 3 · Fl(2)WR 5s"), so the row says colour/rhythm unopened.
    subtitle: withLightSubtitle(primary.subtitle, components),
    payload,
  };
}

/** Append the folded light's trimmed `litdsn` to an aid's subtitle, joined with
 * the same " · " middot the summary uses. Unchanged with no LIGHTS component or
 * a `litdsn` that trims to nothing. */
function withLightSubtitle(
  subtitle: string | undefined,
  components: ChartHitPayload[],
): string | undefined {
  const light = components.find((c) => c.sourceLayer === "LIGHTS");
  const chr = light && trimLitdsn(light.props.litdsn);
  if (!chr) return subtitle;
  return subtitle ? `${subtitle} · ${chr}` : chr;
}

function classOf(hit: InfoHit): string {
  return chartHitPayload(hit)?.sourceLayer ?? "";
}

// Merging depth at a point: DEPARE/DRGARE + DEPCNT share no coordinate or tag,
// so this folds them by CLASS instead. SOUNDG stays its own hit (more precise
// than a band). See docs/architecture/chart-info-provider.md ("depth").

/** The depth classes that fold into one "Depth" hit. SOUNDG is intentionally
 * absent — see the note above. */
const DEPTH_CLASSES = new Set(["DEPARE", "DRGARE", "DEPCNT"]);

/** Primary precedence within a Depth group: the filled band you float in wins
 * over a contour, so the composite highlights the area and ranks as the band.
 * DEPARE before DRGARE only to be deterministic — either is "the area". */
const DEPTH_PRIMARY_ORDER = ["DEPARE", "DRGARE", "DEPCNT"];

function isDepthHit(hit: InfoHit): boolean {
  const payload = chartHitPayload(hit);
  return !!payload && DEPTH_CLASSES.has(payload.sourceLayer);
}

/** Fold each chart set's depth hits into one composite "Depth" hit, in the
 * slot the set's first depth hit held; a lone depth object is not a merge.
 * Same structure as `mergeAidComponents`, keyed on the chart source. */
function mergeDepth(hits: InfoHit[]): InfoHit[] {
  const groups = new Map<string, InfoHit[]>();
  for (const hit of hits) {
    if (!isDepthHit(hit)) continue;
    const source = chartHitPayload(hit)!.source;
    const group = groups.get(source);
    if (group) group.push(hit);
    else groups.set(source, [hit]);
  }
  const emitted = new Set<string>();
  const out: InfoHit[] = [];
  for (const hit of hits) {
    if (!isDepthHit(hit)) {
      out.push(hit);
      continue;
    }
    const source = chartHitPayload(hit)!.source;
    const group = groups.get(source)!;
    if (group.length < 2) {
      out.push(hit); // a lone depth object in this set — not a merge
      continue;
    }
    // The merged hit takes the slot of the set's first depth hit; the rest drop.
    if (emitted.has(source)) continue;
    emitted.add(source);
    out.push(depthCompositeHit(group));
  }
  return out;
}

/** One composite "Depth" hit from a group of ≥2 depth objects at a tap. */
function depthCompositeHit(group: InfoHit[]): InfoHit {
  // Primary = the band the point is inside, by `DEPTH_PRIMARY_ORDER`; ties keep
  // query order. Its payload is the composite's, so `icon`/./highlight.ts read
  // the area without knowing it is a composite.
  const ordered = [...group].sort(
    (a, b) => orderIn(DEPTH_PRIMARY_ORDER, classOf(a)) - orderIn(DEPTH_PRIMARY_ORDER, classOf(b)),
  );
  const primary = ordered[0];
  const primaryPayload = chartHitPayload(primary)!;
  // Components (everything but the primary), in the order they were tapped —
  // there is no natural section order among contours, so query order is the
  // least surprising.
  const components = ordered.slice(1).map((h) => chartHitPayload(h)!);
  // Stable, content-derived id from the sorted member ids, so a repeat tap
  // resolves to the same merged hit and dedupe/selection are well-behaved.
  const id = `depth:${group.map((h) => h.id).sort().join("|")}`;
  const payload: ChartHitPayload = { ...primaryPayload, components };
  return {
    // priority + precision ride along from the primary band — the depth band is
    // what was tapped, and a contour folded in does not promote it.
    ...primary,
    id,
    title: "Depth",
    // The primary band's own subtitle is its range ("X–Y m") — exactly what the
    // list row should read for the whole Depth item.
    subtitle: primary.subtitle,
    payload,
  };
}
