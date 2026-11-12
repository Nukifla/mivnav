// Save a route as a .gpx file on THIS device — a Blob behind a temporary
// anchor, so it works offline on the boat LAN with no server round-trip.
// Kept out of ./gpx.ts so that module stays pure (no DOM).

import type { Route } from "../../core/routes";
import { gpxFileName, routeToGpx } from "./gpx";

export function downloadGpx(route: Route): void {
  const blob = new Blob([routeToGpx(route)], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = gpxFileName(route);
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked later, not now: some browsers start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
