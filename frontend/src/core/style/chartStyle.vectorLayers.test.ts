import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADVERTISED_AS_NOTHING, styledSourceLayers } from "./chartStyle";

// Cross-language drift guard for the advertised source-layer list.
//
// The backend advertises a fixed set of MVT source-layers for its on-demand
// (o-charts) sets — STATIC_VECTOR_LAYERS in
// backend/mivnav/features/ocharts/service.py.
// The frontend styles a set of source-layers, and `add()` silently drops any
// layer the set does not advertise (`if (!present.has(sourceLayer)) return`).
// So a class the frontend styles but the backend omits NEVER RENDERS on
// o-charts sets, with no error anywhere. The two lists used to be kept equal
// by hand, by a comment. This test replaces that comment with a gate.
//
// The ground truth is neither hand-list: it is the `add()` call sites, which
// `styledSourceLayers()` recovers by running the generator with a collector.
// The frontend's full advertised set is those plus the two ADVERTISED_AS_NOTHING
// layers the design tiles-but-paints-nothing (`_nodata`, LNDRGN) — no `add()`
// can produce those, so they are named explicitly on the frontend side too.
// That union must equal the backend list, class for class.

const SERVICE_PY = join(
  import.meta.dir,
  "../../../../backend/mivnav/features/ocharts/service.py",
);

/** The backend's advertised names, read from its authoritative Python list.
 * Fails loud (throws) if the list's shape changes — a broken parse is a red
 * test, never a silent pass. */
function backendAdvertisedLayers(): string[] {
  const src = readFileSync(SERVICE_PY, "utf8");
  // STATIC_VECTOR_LAYERS = [ {"id": name, ...} for name in [ "_nodata", ... ] ]
  // — capture the inner `for name in [...]` list, whose only string literals
  // are the layer names.
  const block = src.match(/STATIC_VECTOR_LAYERS[\s\S]*?for name in \[([\s\S]*?)\]/);
  if (!block) {
    throw new Error(
      `could not locate the STATIC_VECTOR_LAYERS name list in ${SERVICE_PY}; ` +
        "its shape changed — update this parser or the layout it expects",
    );
  }
  const names = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error("STATIC_VECTOR_LAYERS name list parsed as empty");
  return names;
}

describe("advertised vs. styled source-layers stay in lockstep across languages", () => {
  const styled = styledSourceLayers();
  const advertised = new Set(backendAdvertisedLayers());

  test("the ground-truth set is non-trivial and the exceptions really are exceptions", () => {
    // Guards against the collector silently returning nothing (which would make
    // the equality below vacuously satisfiable) and against an exception that
    // is in fact styled (in which case it should not be a hand-listed one).
    expect(styled.size).toBeGreaterThan(10);
    for (const cls of ADVERTISED_AS_NOTHING) expect(styled.has(cls)).toBe(false);
  });

  test("the backend advertises no duplicates", () => {
    const list = backendAdvertisedLayers();
    expect(list.length).toBe(new Set(list).size);
  });

  /**
   * THE claim: the backend's advertised set equals the frontend's styled set
   * (the true `add()` sites) plus the deliberately-unpainted exceptions.
   *
   * RED if a styled layer is not advertised (it would never render on o-charts
   * sets — the silent failure), and RED if the backend advertises a layer the
   * frontend neither styles nor lists as a deliberate no-op. A diff here is a
   * real drift: add the class to STATIC_VECTOR_LAYERS, or stop styling it, or
   * (for a new tiled-but-unpainted layer) add it to ADVERTISED_AS_NOTHING.
   */
  test("advertised == styled ∪ ADVERTISED_AS_NOTHING", () => {
    const frontend = new Set([...styled, ...ADVERTISED_AS_NOTHING]);
    expect([...frontend].sort()).toEqual([...advertised].sort());
  });
});
