// The seam between the mivport POI source (registered at start-up, before
// the app exists — src/index.tsx) and the editing state the app builds
// (./editing.ts): the source asks here for its actions, its hidden refs and
// its details, and gets nothing until editing binds itself.

import { createSignal } from "solid-js";
import type { InfoAction } from "../../../core/info/types";
import type { PoiFeatureProps } from "../sources";
import type { MivportPlaceDetail } from "./types";

export interface MivportSourceHooks {
  /** The info-panel actions for one mivport point. */
  actions: (props: PoiFeatureProps) => { actions?: InfoAction[]; footerActions?: InfoAction[] };
  /** Refs the baked layers must not draw. */
  hiddenRefs: () => readonly string[];
  /** Load a place's detail (and remember it, so actions and the body follow
   * later writes). */
  loadDetail: (setId: string, ref: string) => Promise<MivportPlaceDetail>;
  /** The remembered detail, reactive: refreshed after each write. */
  cachedDetail: (setId: string, ref: string) => MivportPlaceDetail | undefined;
}

const [hooks, setHooks] = createSignal<MivportSourceHooks>();

/** The bound editing hooks, or undefined (read-only: tests, or before App). */
export const mivportHooks = hooks;

/** Bind editing to the source; returns the unbind. */
export function bindMivportHooks(h: MivportSourceHooks): () => void {
  setHooks(() => h);
  return () => {
    if (hooks() === h) setHooks(undefined);
  };
}
