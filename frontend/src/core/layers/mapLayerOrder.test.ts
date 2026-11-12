/**
 * The generic map-layer ORDER, proved — the pure merge and the runtime apply.
 *
 *  (a) orderMapLayers: the persisted order wins for the ids it names, an id it
 *      omits falls back to its DEFAULT position (a new layer never wedges), and a
 *      PINNED layer (own-ship) is dropped from the reorderable set and pinned last
 *      — topmost — no matter what the persisted order says.
 *  (b) moveInOrder: a pure splice-move (the drag's decision).
 *  (c) encGroupLayerIds: the metadata bucket, in stack order.
 *  (d) applyMapLayerOrder: the band is moved BELOW the anchor and own-ship is
 *      never touched — you never lose your own boat.
 */

import { describe, expect, test } from "bun:test";
import type { Map as MLMap } from "maplibre-gl";
import type { MapLayer } from "../chrome/feature";
import { ENC_GROUP_META } from "../style/encGroups";
import { dropTargetIndex } from "../chrome/dashboardDnd";
import {
  applyMapLayerOrder,
  encGroupLayerIds,
  moveInOrder,
  orderMapLayers,
} from "./mapLayerOrder";

/** A minimal MapLayer — only id/pinned matter to the ordering. */
const L = (id: string, pinned = false): MapLayer => ({
  id,
  label: id,
  visible: () => true,
  setVisible: () => {},
  pinned,
});

// DEFAULT bottom → top registry: three ENC groups, a wash, and own-ship pinned.
const DEFAULTS: MapLayer[] = [
  L("enc:fills"),
  L("enc:soundings"),
  L("enc:aids"),
  L("satellite"),
  L("own-ship", true),
];

describe("(a) orderMapLayers", () => {
  test("default (empty persisted) is the input order, own-ship last", () => {
    expect(orderMapLayers(DEFAULTS, []).map((l) => l.id)).toEqual([
      "enc:fills",
      "enc:soundings",
      "enc:aids",
      "satellite",
      "own-ship",
    ]);
  });

  test("a persisted order reorders the non-pinned layers, own-ship stays pinned last", () => {
    const persisted = ["satellite", "enc:aids", "enc:soundings", "enc:fills"];
    expect(orderMapLayers(DEFAULTS, persisted).map((l) => l.id)).toEqual([
      "satellite",
      "enc:aids",
      "enc:soundings",
      "enc:fills",
      "own-ship",
    ]);
  });

  test("own-ship can never enter the reorderable order — pinned wins over a stray id", () => {
    // Even if a hand-edited order lists own-ship, it is dropped from the free set
    // and re-pinned last.
    const persisted = ["own-ship", "enc:aids", "enc:fills", "enc:soundings", "satellite"];
    const out = orderMapLayers(DEFAULTS, persisted).map((l) => l.id);
    expect(out[out.length - 1]).toBe("own-ship");
    expect(out.filter((id) => id === "own-ship")).toHaveLength(1);
  });

  test("a layer absent from a non-empty order falls to a default slot, not an end", () => {
    // enc:soundings is new (not in the saved order). It is spliced in at the
    // count of its default-predecessors already placed (fills → index 1), so it
    // lands mid-list rather than wedged at the top or bottom.
    const persisted = ["satellite", "enc:aids", "enc:fills"];
    const out = orderMapLayers(DEFAULTS, persisted).map((l) => l.id);
    expect(out).toEqual(["satellite", "enc:soundings", "enc:aids", "enc:fills", "own-ship"]);
    // not wedged at an end of the reorderable span (own-ship is the pinned tail)
    const free = out.filter((id) => id !== "own-ship");
    expect(free.indexOf("enc:soundings")).toBeGreaterThan(0);
    expect(free.indexOf("enc:soundings")).toBeLessThan(free.length - 1);
  });
});

describe("(b) moveInOrder", () => {
  test("moves an item forward and back", () => {
    expect(moveInOrder(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveInOrder(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });
  test("a no-op / out-of-range move returns an equal array", () => {
    expect(moveInOrder(["a", "b"], 0, 0)).toEqual(["a", "b"]);
    expect(moveInOrder(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });
});

/** A Map double that models getStyle().layers + moveLayer(id, beforeId) as a real
 * array reorder, so the final stack can be asserted. */
class FakeMap {
  layers: { id: string; metadata?: Record<string, unknown> }[];
  constructor(layers: { id: string; metadata?: Record<string, unknown> }[]) {
    this.layers = layers;
  }
  getStyle() {
    return { layers: this.layers };
  }
  getLayer(id: string) {
    return this.layers.find((l) => l.id === id);
  }
  moveLayer(id: string, beforeId?: string) {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    const [layer] = this.layers.splice(i, 1);
    if (beforeId == null) {
      this.layers.push(layer!); // to the top
      return;
    }
    const b = this.layers.findIndex((l) => l.id === beforeId);
    this.layers.splice(b < 0 ? this.layers.length : b, 0, layer!);
  }
  ids() {
    return this.layers.map((l) => l.id);
  }
}

describe("(b') the panel's drag→persist flow", () => {
  // The panel renders TOP-first (props.layers reversed) and persists BOTTOM→top.
  // This mirrors LayersPanel's drop handler: reorder the display ids, reverse.
  test("dragging soundings to the top of the list persists it at the top of the stack", () => {
    const ordered = orderMapLayers(DEFAULTS, []); // bottom → top
    const display = [...ordered].reverse().filter((l) => !l.pinned).map((l) => l.id);
    // display (top → down): satellite, enc:aids, enc:soundings, enc:fills
    const from = display.indexOf("enc:soundings");
    const to = dropTargetIndex(from, 0); // dropped into the top gap
    const nextDisplay = moveInOrder(display, from, to);
    expect(nextDisplay[0]).toBe("enc:soundings");
    // persisted = display reversed (bottom → top); own-ship (pinned) excluded.
    const persisted = [...nextDisplay].reverse();
    expect(persisted).toEqual(["enc:fills", "enc:aids", "satellite", "enc:soundings"]);
    expect(persisted).not.toContain("own-ship");
    // and feeding it back reproduces that exact stack, own-ship still pinned last.
    expect(orderMapLayers(DEFAULTS, persisted).map((l) => l.id)).toEqual([
      "enc:fills",
      "enc:aids",
      "satellite",
      "enc:soundings",
      "own-ship",
    ]);
  });
});

describe("(c) encGroupLayerIds", () => {
  test("buckets the chart layers by their group metadata, in stack order", () => {
    const map = new FakeMap([
      { id: "world-earth" },
      { id: "chart-a-depare", metadata: { [ENC_GROUP_META]: "fills" } },
      { id: "chart-a-lndare", metadata: { [ENC_GROUP_META]: "fills" } },
      { id: "chart-a-soundg", metadata: { [ENC_GROUP_META]: "soundings" } },
      { id: "chart-a-aton", metadata: { [ENC_GROUP_META]: "aids" } },
    ]);
    expect(encGroupLayerIds(map as unknown as MLMap, "fills")).toEqual([
      "chart-a-depare",
      "chart-a-lndare",
    ]);
    expect(encGroupLayerIds(map as unknown as MLMap, "soundings")).toEqual(["chart-a-soundg"]);
  });
});

describe("(d) applyMapLayerOrder — the band goes below the anchor, own-ship stays top", () => {
  // Bottom → top: the basemap, the chart groups (fills, soundings, aids), satellite wash,
  // then the fixed safety overlays (ais, own-ship). Own-ship is the top of stack.
  const build = () =>
    new FakeMap([
      { id: "world-earth" },
      { id: "chart-a-depare", metadata: { [ENC_GROUP_META]: "fills" } },
      { id: "chart-a-soundg", metadata: { [ENC_GROUP_META]: "soundings" } },
      { id: "chart-a-aton", metadata: { [ENC_GROUP_META]: "aids" } },
      { id: "satellite" },
      { id: "ais-target" },
      { id: "own-ship" },
    ]);

  // Resolve a MapLayer id to its live layer ids (ENC via metadata, wash literal).
  const resolve = (map: FakeMap) => (id: string) =>
    id.startsWith("enc:")
      ? encGroupLayerIds(map as unknown as MLMap, id.slice(4) as never)
      : id === "satellite"
        ? ["satellite"]
        : [];

  test("reorders the band beneath the anchor (ais-target), never above it", () => {
    const map = build();
    // User order: soundings on top of the band, then satellite, aids, fills.
    const order = ["enc:fills", "enc:aids", "satellite", "enc:soundings"];
    applyMapLayerOrder(map as unknown as MLMap, order, resolve(map), "ais-target");
    const ids = map.ids();
    // Every band layer sits below the anchor; ais + own-ship stay on top, own-ship
    // topmost — you never lose your own boat.
    expect(ids[ids.length - 1]).toBe("own-ship");
    expect(ids[ids.length - 2]).toBe("ais-target");
    // Band order preserved beneath the anchor, in the requested sequence.
    expect(ids.filter((id) => id !== "world-earth" && id !== "ais-target" && id !== "own-ship")).toEqual([
      "chart-a-depare", // enc:fills (bottom of band)
      "chart-a-aton", // enc:aids
      "satellite",
      "chart-a-soundg", // enc:soundings (top of band, just under the anchor)
    ]);
  });

  test("own-ship is never in the band and never moves", () => {
    const map = build();
    const before = map.getLayer("own-ship");
    applyMapLayerOrder(
      map as unknown as MLMap,
      ["enc:soundings", "enc:fills", "enc:aids", "satellite"],
      resolve(map),
      "ais-target",
    );
    // own-ship still present, still topmost.
    expect(map.ids()[map.ids().length - 1]).toBe("own-ship");
    expect(map.getLayer("own-ship")).toBe(before!);
  });
});
