import { createMemo, createSignal, createUniqueId, For, Show, type Component } from "solid-js";
import PaletteIcon from "lucide-solid/icons/palette";
import { AccordionSection } from "../ui/Accordion";
import { Button } from "../ui/Button";
import { ColorPicker } from "../ui/ColorPicker";
import { Note } from "../ui/Text";
import { Slider } from "../ui/Controls";
import {
  clearThemeOverride,
  EMITTED_ICON_ROLES,
  getThemeOverride,
  setThemeOverrideField,
  THEME_BY_ID,
  type BasemapColors,
  type ContourWidth,
  type NoticesColors,
  type OverlayColors,
  type PoiColors,
  type RasterDim,
  type BasemapTint,
  type RouteOverlayColors,
  type ThemeOverridePatch,
} from "../style/themes";
import { isColourValue, noticesColors, type Palette } from "../style/colors";
import { S52_EDITOR_FIELDS } from "../style/themes/s52Fields";
import { DERIVED_ICON_ROLES, DERIVED_ICON_ROLE_NAMES, derivedIconRoles } from "../style/themes/derivedIcons";
import type { S52Colors } from "../style/s52Tables.generated";

/** The icon roles this editor offers a row for: the ones chartcore emits,
 * minus the ones that are an S-52 token in disguise (see docs/architecture/theme-editor.md). */
const EDITABLE_ICON_ROLES = EMITTED_ICON_ROLES.filter(
  (r) => !(DERIVED_ICON_ROLE_NAMES as readonly string[]).includes(r.role),
);

/** The four S-52 tokens an icon role reads — LITRD/LITGN/LITYW/CHMGD. Editing
 * one of these has to be carried into the icons; editing NODTA does not. */
const DERIVED_S52_TOKENS = new Set<string>(Object.values(DERIVED_ICON_ROLES));

/** THE THEME EDITOR — live, session-only tweaking of the ACTIVE theme
 * against the real map (task mnsyyonx); rationale in
 * docs/architecture/theme-editor.md. */
interface ThemeEditorSectionProps {
  palette: Palette;
}

/** Live override if touched this session, else the theme file's own value —
 * so reopening the editor shows what's ACTUALLY on screen. */
function fieldValue<T extends Record<string, string>>(
  base: T,
  patch: Partial<T> | undefined,
  key: keyof T,
): string {
  return patch?.[key] ?? base[key];
}

/** ONE COLOUR TOKEN: swatch plus free-text field, both live — picker handles
 * alpha, typed entry handles pasted rgb()/rgba(). Full rationale:
 * docs/architecture/theme-editor.md#colorrow. */
const ColorRow: Component<{ label: string; value: string; onInput: (v: string) => void }> = (props) => {
  const id = createUniqueId();
  return (
    <div class="flex items-center justify-between gap-2 py-0.5 text-xs text-fg-2">
      <label class="truncate" for={id}>
        {props.label}
      </label>
      <span class="flex shrink-0 items-center gap-1.5">
        <ColorPicker label={props.label} value={props.value} onChange={props.onInput} />
        <input
          id={id}
          class="w-28 rounded border border-line bg-chrome px-1.5 py-0.5 font-mono text-[11px] focus:border-accent focus:outline-none"
          value={props.value}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          spellcheck={false}
        />
      </span>
    </div>
  );
};

const ThemeEditorSection: Component<ThemeEditorSectionProps> = (props) => {
  const base = createMemo(() => THEME_BY_ID[props.palette]);
  const override = createMemo(() => getThemeOverride());
  const patch = createMemo(() => (override()?.palette === props.palette ? override()!.patch : undefined));
  const [exporting, setExporting] = createSignal(false);

  // `notices` is optional on the wire (a user theme may predate it): seed
  // from what the overlay actually paints — `noticesColors`' day fallback —
  // rather than `undefined`, so a row never reads a missing base.
  const groupBase = (group: keyof ThemeOverridePatch): unknown =>
    group === "notices"
      ? (base().notices ?? noticesColors(props.palette))
      : (base() as unknown as Record<string, unknown>)[group];
  const hasEdits = () => {
    const p = patch();
    return !!p && Object.keys(p).length > 0;
  };

  // Reads the CURRENT merged object (override if touched, else the theme
  // file's own) so editing one field never drops a sibling's earlier edit.
  function patchGroup<K extends "routeOverlay" | "overlay" | "poi" | "notices" | "basemap" | "rasterDim" | "basemapTint" | "contourWidth" | "icons" | "s52">(
    group: K,
    key: string,
    value: string | number,
  ): void {
    // icons/s52 seed empty, not from the theme's own table: colors.ts spreads
    // these over the base rather than replacing, so staying sparse keeps the
    // JSON export a real diff instead of restating all roles/tokens.
    const seed = group === "icons" || group === "s52" ? {} : (groupBase(group) as Record<string, unknown> | undefined);
    const current = { ...seed, ...(patch()?.[group] as Record<string, unknown> | undefined) };
    const next = { ...current, [key]: value };
    setThemeOverrideField(props.palette, group, next as unknown as ThemeOverridePatch[K]);
    if (group === "s52" && DERIVED_S52_TOKENS.has(key)) reflectDerivedIcons(next as Partial<S52Colors>);
  }

  /** Carries an S-52 edit into icon roles that ARE that token — normally
   * `derivedIcons.ts` resolves those only when a theme set is INSTALLED,
   * which a session override never is. See theme-editor.md#reflectderivedicons. */
  function reflectDerivedIcons(s52Patch: Partial<S52Colors>): void {
    const valid = Object.entries(s52Patch).filter(([, v]) => typeof v === "string" && isColourValue(v));
    const effective = { ...base().s52, ...Object.fromEntries(valid) } as Partial<S52Colors>;
    const icons = { ...(patch()?.icons ?? {}), ...derivedIconRoles(effective) };
    setThemeOverrideField(props.palette, "icons", icons);
  }

  const colorGroup = (
    title: string,
    group: "routeOverlay" | "overlay" | "poi" | "notices" | "basemap" | "icons" | "s52",
    fields: readonly { key: string; label: string }[],
  ) => {
    const baseObj = () => groupBase(group) as unknown as Record<string, string>;
    const patchObj = () => patch()?.[group] as Partial<Record<string, string>> | undefined;
    return (
      <div class="space-y-0.5">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{title}</p>
        <For each={fields}>
          {(f) => (
            <ColorRow
              label={f.label}
              value={fieldValue(baseObj(), patchObj(), f.key)}
              onInput={(v) => patchGroup(group, f.key, v)}
            />
          )}
        </For>
      </div>
    );
  };

  const numberGroup = (
    title: string,
    group: "rasterDim" | "basemapTint" | "contourWidth",
    fields: readonly { key: string; label: string; min: number; max: number; step: number; fallback: number }[],
  ) => {
    const baseObj = () => (base()[group] as Record<string, number> | undefined) ?? {};
    const patchObj = () => patch()?.[group] as Partial<Record<string, number>> | undefined;
    const value = (f: (typeof fields)[number]) => patchObj()?.[f.key] ?? baseObj()[f.key] ?? f.fallback;
    return (
      <div class="space-y-2">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{title}</p>
        <For each={fields}>
          {(f) => (
            <Slider
              label={f.label}
              value={value(f)}
              min={f.min}
              max={f.max}
              step={f.step}
              format={(v) => v.toFixed(2)}
              onChange={(v) => patchGroup(group, f.key, v)}
            />
          )}
        </For>
      </div>
    );
  };

  /** The patch as a paste-into-the-theme-file diff, minus the derived icon
   * roles `reflectDerivedIcons` writes — those are a consequence of the `s52`
   * rows already in the export, and `resolveTheme` ignores them anyway. */
  const exportJson = createMemo(() => {
    const p = patch();
    if (!p?.icons) return JSON.stringify(p ?? {}, null, 2);
    const icons = Object.fromEntries(
      Object.entries(p.icons).filter(([role]) => !(DERIVED_ICON_ROLE_NAMES as readonly string[]).includes(role)),
    ) as ThemeOverridePatch["icons"];
    const out: ThemeOverridePatch = { ...p, icons };
    if (Object.keys(icons ?? {}).length === 0) delete out.icons;
    return JSON.stringify(out, null, 2);
  });

  return (
    <AccordionSection value="theme-editor" title="Theme editor" icon={PaletteIcon}>
      <Note>
        Live edits to the "{base().label}" theme, for finding values to put in a theme file — they show
        on the map at once and are lost on reload. To edit another theme, pick it under Appearance →
        Theme. The app's own UI colours are not here: they live in the theme's JSON on the server.
      </Note>

      <div class="space-y-0.5">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-fg-3">Canvas</p>
        <ColorRow
          label="Empty chart background"
          value={patch()?.canvas ?? base().canvas}
          onInput={(v) => setThemeOverrideField(props.palette, "canvas", v)}
        />
      </div>

      {colorGroup("Route overlay", "routeOverlay", [
        { key: "route", label: "Route line" },
        { key: "accent", label: "Steer-to / accent" },
        { key: "halo", label: "Halo" },
        { key: "target", label: "Active-course target" },
      ] satisfies { key: keyof RouteOverlayColors; label: string }[])}

      {colorGroup("Crosshair & measure overlay", "overlay", [
        { key: "accent", label: "Accent" },
        { key: "halo", label: "Halo" },
        { key: "markerHalo", label: "Marker halo" },
      ] satisfies { key: keyof OverlayColors; label: string }[])}

      {colorGroup("POI markers", "poi", [
        { key: "marina", label: "Marina" },
        { key: "fuel", label: "Fuel" },
        { key: "harbourmaster", label: "Harbourmaster" },
        { key: "other", label: "Other" },
        { key: "label", label: "Label text" },
      ] satisfies { key: keyof PoiColors; label: string }[])}

      {colorGroup("Notices to Mariners", "notices", [
        { key: "warning", label: "Warning (NW)" },
        { key: "firing", label: "Firing" },
        { key: "temporary", label: "Temporary (T)" },
        { key: "preliminary", label: "Preliminary (P)" },
        { key: "permanent", label: "Permanent" },
        { key: "inactive", label: "Firing area, not firing" },
        { key: "badge", label: "Icon badge" },
        { key: "label", label: "Label text" },
        { key: "halo", label: "Label halo" },
      ] satisfies { key: keyof NoticesColors; label: string }[])}

      {/* No `coastline` key: Protomaps draws land as a FILL (`land` below),
          not a shore stroke, so BasemapColors dropped that field (unqqplrl/ymkrsmky). */}
      {colorGroup("Basemap (OSM)", "basemap", [
        { key: "land", label: "Land" },
        { key: "roadMajor", label: "Major road" },
        { key: "roadMinor", label: "Minor road" },
        { key: "place", label: "Place label" },
        { key: "placeHalo", label: "Place label halo" },
        { key: "boundary", label: "Admin boundary" },
      ] satisfies { key: keyof BasemapColors; label: string }[])}

      {colorGroup(
        "Chart symbol colours (icon roles)",
        "icons",
        EDITABLE_ICON_ROLES.map((r) => ({ key: r.role, label: r.role })),
      )}

      {colorGroup("Chart colours (S-52 tokens)", "s52", S52_EDITOR_FIELDS)}

      {numberGroup("Raster dimming (satellite / OpenSeaMap)", "rasterDim", [
        { key: "brightness", label: "Brightness max", min: 0, max: 1, step: 0.05, fallback: 1 },
        { key: "saturation", label: "Saturation", min: -1, max: 1, step: 0.05, fallback: 1 },
      ] satisfies { key: keyof RasterDim; label: string; min: number; max: number; step: number; fallback: number }[])}

      {numberGroup("Basemap colour tint (raster)", "basemapTint", [
        { key: "hueRotate", label: "Hue rotate (°)", min: 0, max: 360, step: 1, fallback: 0 },
        { key: "contrast", label: "Contrast", min: -1, max: 1, step: 0.05, fallback: 0 },
      ] satisfies { key: keyof BasemapTint; label: string; min: number; max: number; step: number; fallback: number }[])}

      {numberGroup("Depth contour width (px)", "contourWidth", [
        { key: "safety", label: "Safety contour", min: 0.5, max: 6, step: 0.5, fallback: 2 },
        { key: "other", label: "Other contours", min: 0.5, max: 6, step: 0.5, fallback: 1 },
      ] satisfies { key: keyof ContourWidth; label: string; min: number; max: number; step: number; fallback: number }[])}

      <div class="flex flex-wrap gap-2 pt-1">
        <Button variant="tinted" tone="notice" disabled={!hasEdits()} onClick={() => clearThemeOverride(props.palette)}>
          Reset to theme file
        </Button>
        <Button disabled={!hasEdits()} onClick={() => setExporting((v) => !v)}>
          {exporting() ? "Hide JSON" : "Export as JSON"}
        </Button>
      </div>

      <Show when={exporting()}>
        <Show when={hasEdits()} fallback={<Note>No edits yet this session.</Note>}>
          <p class="text-[11px] text-fg-3">
            The fields touched this session, as a patch over "{base().label}" — paste into that theme's JSON
            (`backend/mivnav/features/themes/data/{base().id}.json`, or a copy of it in
            `~/.config/mivnav/themes/`) to make an edit permanent. No rebuild needed.
          </p>
          <textarea
            readonly
            rows={10}
            class="w-full rounded border border-line bg-chrome p-2 font-mono text-[11px]"
            value={exportJson()}
            onClick={(e) => e.currentTarget.select()}
          />
        </Show>
      </Show>
    </AccordionSection>
  );
};

export default ThemeEditorSection;
