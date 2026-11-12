// Standalone marks: the wire types and the pure pieces (naming, search, the
// chart scene). The server owns the list; it lives on Signal K as waypoint
// resources, so marks other apps placed show up here too.

import type { Feature, FeatureCollection } from "geojson";
import { symbolColors } from "../../core/layers/aisSymbols";
import { haloPaint, type Palette } from "../../core/style/colors";

export const MARK_ICONS = ["pin", "anchor", "danger", "fish", "star", "flag"] as const;
export type MarkIcon = (typeof MARK_ICONS)[number];

export const MARK_ICON_LABELS: Record<MarkIcon, string> = {
  pin: "Pin",
  anchor: "Anchorage",
  danger: "Danger",
  fish: "Fishing",
  star: "Favourite",
  flag: "Flag",
};

export interface Mark {
  id: string;
  name: string;
  note: string;
  icon: MarkIcon;
  lat: number;
  lon: number;
  updated: number;
}

export interface MarkList {
  marks: Mark[];
  icons: string[];
  /** Signal K didn't answer: this is the server's last copy. */
  stale: boolean;
}

/** What a save sends: everything but the server-owned fields. */
export type MarkBody = Pick<Mark, "name" | "note" | "icon" | "lat" | "lon">;

export const isMarkIcon = (v: unknown): v is MarkIcon =>
  typeof v === "string" && (MARK_ICONS as readonly string[]).includes(v);

/** An icon the server sent but this build doesn't draw reads as a pin. */
export const iconOf = (m: Pick<Mark, "icon">): MarkIcon => (isMarkIcon(m.icon) ? m.icon : "pin");

export const displayName = (m: Pick<Mark, "name">): string => m.name.trim() || "Unnamed mark";

/** "Mark 1", "Mark 2", ... — the lowest number no existing mark uses. */
export function nextMarkName(marks: readonly Pick<Mark, "name">[]): string {
  const taken = new Set(
    marks.flatMap((m) => {
      const hit = /^Mark (\d+)$/.exec(m.name.trim());
      return hit ? [Number(hit[1])] : [];
    }),
  );
  let n = 1;
  while (taken.has(n)) n += 1;
  return `Mark ${n}`;
}

/** Every word must match the name or the note. */
export function filterMarks(marks: readonly Mark[], query: string): Mark[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...marks];
  return marks.filter((m) => {
    const text = `${m.name} ${m.note} ${MARK_ICON_LABELS[iconOf(m)]}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** Nearest the boat first when there is a fix, else by name. */
export function sortMarks(
  marks: readonly Mark[],
  distance?: (m: Mark) => number,
): Mark[] {
  const byName = (a: Mark, b: Mark) => displayName(a).localeCompare(displayName(b));
  if (!distance) return [...marks].sort(byName);
  return [...marks].sort((a, b) => distance(a) - distance(b) || byName(a, b));
}

/** The mapped `icon-image` id for one icon in one palette (./icons.ts draws it). */
export const markIconId = (icon: MarkIcon, palette: Palette): string => `mark-${icon}-${palette}`;

/** The chart scene: one point per mark, icon + name. No areas at all — a
 * mark is a symbol, never a fill that would wash the chart. */
export function markFeatures(
  marks: readonly Mark[],
  palette: Palette,
): FeatureCollection {
  const { ui, uiHalo } = symbolColors(palette);
  const glow = haloPaint(palette);
  const features: Feature[] = marks.map((m) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [m.lon, m.lat] },
    properties: {
      id: m.id,
      icon: markIconId(iconOf(m), palette),
      label: displayName(m),
      textColor: ui,
      haloColor: uiHalo,
      haloWidth: glow["text-halo-width"] ?? 0,
      haloBlur: glow["text-halo-blur"] ?? 0,
    },
  }));
  return { type: "FeatureCollection", features };
}
