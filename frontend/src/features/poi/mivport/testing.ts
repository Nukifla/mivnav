// Test support: puts the mivport POI source into the host's (global) POI
// source registry for one test file, with a detail loader a test can swap,
// and takes it out again afterwards.
//
// Unlike a register-once-per-process helper, the registration is undone:
// bun shares ONE module registry across every test file of a run
// (and the app registers mivport at start-up, not at import), and other
// tests pin the registry's exact contents. A mivport source left in would
// fail those whenever they run after this file. Use as:
//
//   beforeAll(registerMivport);
//   afterAll(unregisterMivport);
//
// (This module can't call beforeAll itself: it is typechecked with the app,
// which has no `bun:test` types.)

import {
  extraPoiQueryLayers,
  poiSource,
  poiSources,
  registerPoiQueryLayers,
  registerPoiSource,
  resetPoiSources,
  type PoiSourcePlugin,
} from "../sources";
import type { MivportPlaceDetail } from "./detail";
import { MIVPORT_SRC, mivportPoiSource } from "./index";

export const loaders: { detail: (setId: string, ref: string) => Promise<MivportPlaceDetail> } = {
  detail: () => Promise.reject(new Error("no loader")),
};

export const testSource = mivportPoiSource((s, r) => loaders.detail(s, r));

let saved: { sources: PoiSourcePlugin[]; layers: string[] } | undefined;

/** Register the mivport source (after whatever is registered already). */
export function registerMivport(): void {
  if (poiSource(MIVPORT_SRC)) return;
  saved = { sources: [...poiSources()], layers: [...extraPoiQueryLayers()] };
  registerPoiSource(testSource);
}

/** Put the registry back exactly as `registerMivport` found it. */
export function unregisterMivport(): void {
  if (!saved) return;
  const { sources, layers } = saved;
  saved = undefined;
  resetPoiSources();
  for (const s of sources) registerPoiSource(s);
  registerPoiQueryLayers(layers);
  loaders.detail = () => Promise.reject(new Error("no loader"));
}
