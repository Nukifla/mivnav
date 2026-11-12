// Tap a buddy that isn't a live target. Deliberately no CPA and no Collision
// section: nothing here is current enough to assess. A live buddy is the
// vessel provider's, with its "Buddy" and "Source" rows.

import { bearingDeg, rangeNm } from "../../core/chrome/geo";
import { createVesselIcon, vesselIconModel } from "../../core/info/BoatGlyph";
import {
  formatBearingDeg,
  formatDistanceNm,
  formatInstant,
  formatLatLng,
} from "../../core/info/vesselProvider";
import type { InfoAction, InfoDetail, InfoHit, InfoPoint, InfoProvider, InfoQuery, InfoRow } from "../../core/info/types";
import type { ChartSettings } from "../../core/style/settings";
import { DEFAULT_SETTINGS } from "../../core/style/settings";
import { ageText, displayName, OLD_AFTER_S, sourceText, type Buddy } from "./model";

export const BUDDY_PROVIDER_ID = "buddies";
const TAP_RADIUS_PX = 14;

export interface BuddyProviderDeps {
  /** The ones drawn by this feature's overlay (`remembered`). */
  drawn: () => readonly Buddy[];
  own: () => InfoPoint | undefined;
  project: (p: InfoPoint) => { x: number; y: number } | undefined;
  actions?: (b: Buddy) => readonly InfoAction[];
  settings?: () => ChartSettings;
}

export function buddyHit(b: Buddy): InfoHit {
  return {
    providerId: BUDDY_PROVIDER_ID,
    id: b.id,
    priority: "traffic",
    precision: "point",
    title: displayName(b),
    subtitle: b.position ? `Last seen ${ageText(b.position.ageS)}` : "No position yet",
    ...(b.position ? { lngLat: { lng: b.position.lng, lat: b.position.lat } } : {}),
  };
}

export function createBuddyProvider(deps: BuddyProviderDeps): InfoProvider {
  const settings = deps.settings ?? (() => DEFAULT_SETTINGS);
  const find = (id: string) => deps.drawn().find((b) => b.id === id);

  return {
    id: BUDDY_PROVIDER_ID,
    label: "Buddies",

    queryAt(query: InfoQuery): InfoHit[] {
      const r = Math.max(query.radius, TAP_RADIUS_PX);
      return deps
        .drawn()
        .flatMap((b) => {
          if (!b.position) return [];
          const at = deps.project({ lng: b.position.lng, lat: b.position.lat });
          const d = at ? Math.hypot(at.x - query.point.x, at.y - query.point.y) : Number.NaN;
          return d <= r ? [{ b, d }] : [];
        })
        .sort((x, y) => x.d - y.d)
        .map(({ b }) => buddyHit(b));
    },

    locate(hit) {
      const p = find(hit.id)?.position;
      return p && { lng: p.lng, lat: p.lat };
    },

    icon(hit) {
      return createVesselIcon(() => {
        const b = find(hit.id);
        const p = b?.position;
        if (!b || !p) return undefined;
        return vesselIconModel(
          {
            id: b.id,
            lat: p.lat,
            lng: p.lng,
            mmsi: b.mmsi,
            shipTypeId: b.shipTypeId,
            cogDeg: p.cogDeg,
            headingDeg: p.headingDeg,
            buddy: true,
          },
          settings(),
          "unknown",
        );
      });
    },

    watch() {
      void deps.drawn();
      void deps.own();
    },

    detail(hit): InfoDetail {
      const b = find(hit.id);
      const p = b?.position;
      if (!b || !p) return { sections: [{ rows: [{ label: "Buddy", value: "no position" }] }] };
      const identity: InfoRow[] = [];
      if (b.note) identity.push({ label: "Note", value: b.note });
      if (b.mmsi) identity.push({ label: "MMSI", value: b.mmsi });
      if (b.callsign) identity.push({ label: "Call sign", value: b.callsign });
      const old = p.ageS > OLD_AFTER_S;
      const position: InfoRow[] = [
        { label: "Last seen", value: ageText(p.ageS), emphasis: old },
        { label: "Fix time", value: formatInstant(p.fixAtIso) },
        { label: "Position", value: formatLatLng(p.lat, p.lng) },
        { label: "Source", value: sourceText(p) },
      ];
      const own = deps.own();
      if (own) {
        const to = { lng: p.lng, lat: p.lat };
        position.push({ label: "Range", value: formatDistanceNm(rangeNm(own, to)) });
        position.push({ label: "Bearing", value: formatBearingDeg(bearingDeg(own, to)) });
      }
      if (p.cogDeg !== undefined) {
        position.push({ label: "Last COG", value: formatBearingDeg(p.cogDeg) });
      }
      return {
        title: displayName(b),
        subtitle: `Buddy · last seen ${ageText(p.ageS)}`,
        footerActions: deps.actions?.(b) ?? [],
        sections: [
          { label: "Buddy", rows: identity },
          { label: "Position", rows: position },
        ],
      };
    },
  };
}
