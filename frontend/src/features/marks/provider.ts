// Tap a mark: its name, note, position, range/bearing from the boat, and the
// mark's own verbs (edit, move, delete). "Go here" comes free from the panel
// for any placed hit — that IS "navigate to", through the one course publish.

import { bearingDeg, rangeNm } from "../../core/chrome/geo";
import { formatBearingDeg, formatDistanceNm } from "../../core/info/vesselProvider";
import { formatPosition } from "../../core/info/pointProvider";
import type {
  InfoAction,
  InfoDetail,
  InfoHit,
  InfoIconProps,
  InfoPoint,
  InfoProvider,
  InfoQuery,
  InfoRow,
} from "../../core/info/types";
import MarkGlyph from "./MarkGlyph";
import { displayName, iconOf, MARK_ICON_LABELS, type Mark } from "./model";

export const MARK_PROVIDER_ID = "marks";
const TAP_RADIUS_PX = 14;

export interface MarkProviderDeps {
  marks: () => readonly Mark[];
  own: () => InfoPoint | undefined;
  project: (p: InfoPoint) => { x: number; y: number } | undefined;
  /** Under the header: Edit — naming a mark is the common verb. */
  headerActions?: (m: Mark) => readonly InfoAction[];
  /** Under the record: move, delete. */
  actions?: (m: Mark) => readonly InfoAction[];
}

export function markHit(m: Mark): InfoHit {
  return {
    providerId: MARK_PROVIDER_ID,
    id: m.id,
    // Above "context" (a bare point) and chart detail; a mark is something
    // the skipper put there on purpose.
    priority: "traffic",
    precision: "point",
    title: displayName(m),
    subtitle: `Mark · ${MARK_ICON_LABELS[iconOf(m)]}`,
    lngLat: { lng: m.lon, lat: m.lat },
  };
}

export function createMarkProvider(deps: MarkProviderDeps): InfoProvider {
  const find = (id: string) => deps.marks().find((m) => m.id === id);
  return {
    id: MARK_PROVIDER_ID,
    label: "Marks",

    queryAt(query: InfoQuery): InfoHit[] {
      const r = Math.max(query.radius, TAP_RADIUS_PX);
      return deps
        .marks()
        .flatMap((m) => {
          const at = deps.project({ lng: m.lon, lat: m.lat });
          const d = at ? Math.hypot(at.x - query.point.x, at.y - query.point.y) : Number.NaN;
          return d <= r ? [{ m, d }] : [];
        })
        .sort((a, b) => a.d - b.d)
        .map(({ m }) => markHit(m));
    },

    locate(hit) {
      const m = find(hit.id);
      return m && { lng: m.lon, lat: m.lat };
    },

    icon(hit) {
      const m = find(hit.id);
      const icon = m ? iconOf(m) : "pin";
      return (props: InfoIconProps) => MarkGlyph({ ...props, icon });
    },

    watch() {
      void deps.marks();
      void deps.own();
    },

    detail(hit): InfoDetail {
      const m = find(hit.id);
      if (!m) return { sections: [{ rows: [{ label: "Mark", value: "deleted" }] }] };
      const position = formatPosition({ lng: m.lon, lat: m.lat });
      const rows: InfoRow[] = [{ label: "Position", value: position, copy: position }];
      const own = deps.own();
      if (own) {
        const to = { lng: m.lon, lat: m.lat };
        rows.push({ label: "Range", value: formatDistanceNm(rangeNm(own, to)) });
        rows.push({ label: "Bearing", value: formatBearingDeg(bearingDeg(own, to)) });
      }
      return {
        title: displayName(m),
        subtitle: `Mark · ${MARK_ICON_LABELS[iconOf(m)]}`,
        actions: deps.headerActions?.(m) ?? [],
        footerActions: deps.actions?.(m) ?? [],
        sections: [
          ...(m.note ? [{ label: "Note", rows: [{ label: "Note", value: m.note }] }] : []),
          { label: "Position", rows },
        ],
      };
    },
  };
}
