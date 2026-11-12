// Leaf module (no imports), so index.ts, commands.ts and App can share the
// mode id without a runtime import cycle (features/route/layers.ts's trick).
export const ROUTE_DRAW_MODE_ID = "route-draw";
