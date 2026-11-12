// Leaf module (no imports) so index.ts and overlay.ts can both import these
// without a TDZ cycle: overlay.ts builds ROUTE_LAYER_IDS from these at
// module-eval time, which would throw if read off a still-initializing index.ts.
export const ROUTE_LINE_LAYER = "route-line";
export const ROUTE_WAYPOINTS_LAYER = "route-waypoints";
