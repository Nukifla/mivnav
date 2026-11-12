// `queryAt` deliberately returns nothing — a bare-coordinate row on every tap
// would turn every single-object tap into a two-row list. ./attach.tsx
// synthesizes `pointHit` only when nothing else answered; this provider just owns the `providerId` (registry.ts).

import MapPin from "lucide-solid/icons/map-pin";
import { degreesDecimalMinutes } from "../coordinate";
import type { InfoDetail, InfoHit, InfoPoint, InfoProvider } from "./types";

export const POINT_PROVIDER_ID = "point";

/**
 * `56°42.350′N 012°34.560′E`. Longitude is padded to three degree digits so
 * a column of positions stays aligned.
 */
export function formatPosition(p: InfoPoint): string {
  const dm = (deg: number, pos: string, neg: string, degPad: number): string => {
    const hemi = deg >= 0 ? pos : neg;
    const { deg: d, min } = degreesDecimalMinutes(deg, 3);
    return `${String(d).padStart(degPad, "0")}°${min.padStart(6, "0")}′${hemi}`;
  };
  return `${dm(p.lat, "N", "S", 2)} ${dm(p.lng, "E", "W", 3)}`;
}

/**
 * `context` priority so it never displaces a real object; carries the tapped
 * point as `lngLat`, which is what "Go here" routes to.
 */
export function pointHit(at: InfoPoint): InfoHit {
  return {
    providerId: POINT_PROVIDER_ID,
    id: "here",
    priority: "context",
    precision: "point",
    title: "This location",
    subtitle: formatPosition(at),
    lngLat: at,
  };
}

export function createPointInfoProvider(): InfoProvider {
  return {
    id: POINT_PROVIDER_ID,
    label: "Location",
    // `defaultIcon`, not per-hit `icon`: the one point hit has nothing to vary on.
    defaultIcon: MapPin,
    queryAt: () => [],
    detail: (hit: InfoHit): InfoDetail => {
      const position = hit.subtitle ?? (hit.lngLat ? formatPosition(hit.lngLat) : undefined);
      return {
        sections: [
          {
            rows: [
              {
                label: "Position",
                value: position ?? "—",
                // Tapping copies (../clipboard.ts); only when a position exists.
                ...(position ? { copy: position } : {}),
              },
            ],
          },
        ],
      };
    },
  };
}
