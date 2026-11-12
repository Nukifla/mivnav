/**
 * The core marker primitive: does it land where the map says, follow the
 * camera, and — the safety-relevant part — is its root always absolutely
 * positioned and shrink-wrapped rather than the `position:relative` block that
 * shoved the crosshair half a map sideways (../MapView.tsx's documented
 * regression, now impossible by construction).
 *
 * Driven against a four-method map double — no WebGL, no DOM, no `mock.module`,
 * the same seam info/marker.ts uses.
 *
 * NB: needs `--conditions=browser` (the `test` script). Bare `bun test` resolves
 * solid-js's `node` export, whose reactive graph never flushes — the reproject
 * assertions would then pass by never happening.
 */

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import {
  createMarkerPosition,
  markerRootStyle,
  markerTransform,
  type MapMarkerMap,
} from "./MapMarker";

/**
 * A map whose projection is a plain scale — 1 degree is 10 px, origin at the
 * container's top-left — so a screen expectation reads as arithmetic. Panning
 * shifts the origin and fires `move`, exactly as MapLibre would.
 */
function fakeMap() {
  let originLng = 0;
  const moveListeners = new Set<() => void>();
  const map: MapMarkerMap = {
    project: (p) => ({ x: (p.lng - originLng) * 10, y: p.lat * 10 }),
    on: (_type, listener) => {
      moveListeners.add(listener);
    },
    off: (_type, listener) => {
      moveListeners.delete(listener);
    },
  };
  return {
    map,
    pan(byLng: number) {
      originLng += byLng;
      for (const l of moveListeners) l();
    },
    get listening() {
      return moveListeners.size > 0;
    },
  };
}

describe("createMarkerPosition — where the marker lands", () => {
  test("lands at map.project(lngLat)", () => {
    createRoot((dispose) => {
      const map = fakeMap();
      const place = createMarkerPosition({ map: map.map, lngLat: () => ({ lng: 10, lat: 20 }) });
      // (10, 20) at 10 px/deg -> (100, 200). Center anchoring is the transform's
      // job; the pixel here is the projected point, unshifted.
      expect(place()).toEqual({ left: "100px", top: "200px" });
      dispose();
    });
  });

  test("re-projects as the chart is panned under it", () => {
    createRoot((dispose) => {
      const map = fakeMap();
      const place = createMarkerPosition({ map: map.map, lngLat: () => ({ lng: 10, lat: 20 }) });
      expect(place()).toEqual({ left: "100px", top: "200px" });
      map.pan(5); // origin moves +5deg -> point is now 5deg from origin
      expect(place()).toEqual({ left: "50px", top: "200px" });
      dispose();
    });
  });

  test("no lngLat places nothing", () => {
    createRoot((dispose) => {
      const map = fakeMap();
      const place = createMarkerPosition({ map: map.map, lngLat: () => undefined });
      expect(place()).toBeUndefined();
      dispose();
    });
  });

  test("does NOT subscribe to the camera while there is no point to place", () => {
    // The framerate regression: several of these markers are permanently mounted
    // (../MapView.tsx: the weather pin, the delete ×, the go-to pin) and idle for
    // most of a session, yet each subscribed to `move` AND `zoom` unconditionally
    // and reprojected a point it then threw away on every frame. An idle marker
    // must not listen at all — it starts only once it has a point, and stops when
    // the point goes.
    const map = fakeMap();
    const [lngLat, setLngLat] = createSignal<{ lng: number; lat: number } | undefined>(undefined);
    // Create under the root, but drive the toggles OUTSIDE it — a write inside a
    // root's synchronous body is batched and would not flush the subscription's
    // render effect before the assertion (the same reason info/marker.test.ts
    // runs its body outside the root).
    const [place, dispose] = createRoot((dispose) => {
      return [createMarkerPosition({ map: map.map, lngLat }), dispose] as const;
    });
    expect(place()).toBeUndefined();
    expect(map.listening).toBe(false);

    // A point appears (the mode turns on, a waypoint is selected): now it tracks.
    setLngLat({ lng: 10, lat: 20 });
    expect(map.listening).toBe(true);
    map.pan(5);
    expect(place()).toEqual({ left: "50px", top: "200px" });

    // The point goes away again (mode off): stop listening.
    setLngLat(undefined);
    expect(place()).toBeUndefined();
    expect(map.listening).toBe(false);
    dispose();
  });

  test("stops listening to the map when its owner goes", () => {
    const map = fakeMap();
    const dispose = createRoot((dispose) => {
      createMarkerPosition({ map: map.map, lngLat: () => ({ lng: 1, lat: 1 }) });
      return dispose;
    });
    expect(map.listening).toBe(true);
    dispose();
    expect(map.listening).toBe(false);
  });

  test("screenAnchored sits at the viewport centre and never subscribes to the camera", () => {
    const map = fakeMap();
    createRoot((dispose) => {
      const place = createMarkerPosition({ map: map.map, screenAnchored: true });
      expect(place()).toEqual({ left: "50%", top: "50%" });
      // Nailed to the viewport: a pan must not move it, and it must not even be
      // listening (the compact "pan to aim" crosshair).
      expect(map.listening).toBe(false);
      map.pan(5);
      expect(place()).toEqual({ left: "50%", top: "50%" });
      dispose();
    });
  });

  test("a screenAnchored offset shifts the anchor off centre, and reacts", () => {
    // Weather's compact crosshair: it rides the visible-strip centre, so its
    // offset from the geometric centre changes when the sheet opens. A live
    // accessor, and still no camera subscription (it is viewport-nailed).
    const map = fakeMap();
    const [off, setOff] = createSignal<[number, number]>([0, 0]);
    const [place, dispose] = createRoot((dispose) => {
      return [
        createMarkerPosition({ map: map.map, screenAnchored: true, screenOffset: off }),
        dispose,
      ] as const;
    });
    // Zero offset is byte-identical to the plain centre — the measure crosshair.
    expect(place()).toEqual({ left: "50%", top: "50%" });
    setOff([0, -280]); // the sheet opens: ride up
    expect(place()).toEqual({ left: "50%", top: "calc(50% + -280px)" });
    expect(map.listening).toBe(false); // still nailed to the viewport
    map.pan(5);
    expect(place()).toEqual({ left: "50%", top: "calc(50% + -280px)" });
    dispose();
  });
});

describe("markerTransform — anchoring and offset", () => {
  test("centres by default", () => {
    expect(markerTransform()).toBe("translate(-50%, -50%)");
  });

  test("honours a non-centre anchor", () => {
    expect(markerTransform("bottom")).toBe("translate(-50%, -100%)");
    expect(markerTransform("top-left")).toBe("translate(0%, 0%)");
  });

  test("appends a pixel offset after anchoring (delete-badge's [20,-20])", () => {
    expect(markerTransform("center", [20, -20])).toBe(
      "translate(-50%, -50%) translate(20px, -20px)",
    );
  });
});

describe("markerRootStyle — the regression guard (MapView.tsx:216-224)", () => {
  const style = markerRootStyle({ left: "100px", top: "200px" }, "translate(-50%, -50%)");

  test("the root is position:absolute, INLINE — never relative/static", () => {
    // The whole bug in one assertion. `position:relative` (or static) drops the
    // root into normal flow, it goes full container WIDTH, and the -50% centring
    // resolves against that width — the crosshair lands ~half the map away. Inline
    // absolute wins over any class a caller could pass, so it cannot happen.
    expect(style.position).toBe("absolute");
    expect(style.position).not.toBe("relative");
    expect(style.position).not.toBe("static");
  });

  test("the root shrink-wraps — no width/height/display forcing it to a block", () => {
    // An absolutely positioned element with only left/top/transform shrink-wraps
    // to its content, which is what makes the -50% resolve against the marker's
    // OWN width. A width/display here would be the block that breaks it.
    expect("width" in style).toBe(false);
    expect("height" in style).toBe(false);
    expect("display" in style).toBe(false);
  });

  test("carries the projected point and the centring transform through", () => {
    expect(style.left).toBe("100px");
    expect(style.top).toBe("200px");
    expect(style.transform).toBe("translate(-50%, -50%)");
  });
});
