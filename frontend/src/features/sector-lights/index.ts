// The SECTOR-LIGHTS feature — the S-52 light-sector arcs. Contributes NO
// `defineFeature`: its only surface is the custom WebGL arc layer, so it
// stays a MapView baseOverlay (like weather) rather than a registry feature.

export { SectorLightLayer, SECTOR_LIGHTS_LAYER_ID, createSectorLightsOverlay } from "./overlay";
