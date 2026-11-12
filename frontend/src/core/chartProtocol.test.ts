// chartEpoch/bumpChartEpoch/clearChartTileCache: the URL-busting signal and
// the Service Worker cache-clear message. The actual tile fetch/cache logic
// (formerly here, behind a custom MapLibre `chart://` protocol handler) moved
// to tileCache.ts/sw.ts — see tileCache.test.ts for that coverage.

import { describe, expect, mock, test } from "bun:test";
import { bumpChartEpoch, chartEpoch, clearChartTileCache } from "./chartProtocol";

/** Stubs `navigator.serviceWorker.controller`, restored by the caller. */
function stubServiceWorker(controller: { postMessage: (m: unknown) => void } | null) {
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "serviceWorker");
  Object.defineProperty(globalThis.navigator, "serviceWorker", {
    value: controller ? { controller } : undefined,
    configurable: true,
  });
  return () => {
    if (original) Object.defineProperty(globalThis.navigator, "serviceWorker", original);
  };
}

describe("clearChartTileCache", () => {
  test("posts a clear-tile-cache message to the controlling Service Worker", () => {
    const postMessage = mock(() => {});
    const restore = stubServiceWorker({ postMessage });
    try {
      clearChartTileCache();
      expect(postMessage).toHaveBeenCalledWith({ type: "clear-tile-cache" });
    } finally {
      restore();
    }
  });

  test("is a no-op when no Service Worker controls the page yet", () => {
    const restore = stubServiceWorker(null);
    try {
      expect(() => clearChartTileCache()).not.toThrow();
    } finally {
      restore();
    }
  });
});

describe("bumpChartEpoch", () => {
  test("increments chartEpoch and also clears the tile cache", () => {
    const postMessage = mock(() => {});
    const restore = stubServiceWorker({ postMessage });
    try {
      const before = chartEpoch();
      bumpChartEpoch();
      expect(chartEpoch()).toBe(before + 1);
      expect(postMessage).toHaveBeenCalledWith({ type: "clear-tile-cache" });
    } finally {
      restore();
    }
  });
});
