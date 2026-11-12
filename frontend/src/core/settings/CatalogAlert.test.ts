import { describe, expect, test } from "bun:test";
import { catalogSignpost } from "./CatalogAlert";

// The blank-map signpost decision (see CatalogAlert). Two blank maps look
// identical — a failed fetch and an empty chart folder — and this is the rule
// that tells them apart, so it is asserted without a DOM.

describe("catalogSignpost", () => {
  test("a fetch failure with no chart to fall back on → the amber fault box", () => {
    expect(catalogSignpost({ loading: false, error: "HTTP 500", setCount: 0 })).toBe("error");
  });

  test("a failure while a chart is on screen is silent — stale, not gone", () => {
    // A re-ingest that failed over an existing catalog: keep drawing it, no box.
    expect(catalogSignpost({ loading: false, error: "HTTP 500", setCount: 3 })).toBe("none");
  });

  test("a successful but empty catalog → the quiet first-run signpost", () => {
    expect(catalogSignpost({ loading: false, error: "", setCount: 0 })).toBe("empty");
  });

  test("still loading with no sets yet is neither — the empty hint must not flash", () => {
    // The initial in-flight fetch has no error and no sets; without the !loading
    // gate this would flash the empty signpost on every boot.
    expect(catalogSignpost({ loading: true, error: "", setCount: 0 })).toBe("none");
  });

  test("a loaded catalog with charts shows nothing", () => {
    expect(catalogSignpost({ loading: false, error: "", setCount: 5 })).toBe("none");
  });

  test("error wins over empty by construction: a failure never reads as an empty folder", () => {
    // error && chartless is the error box; empty requires !error, so the two are
    // mutually exclusive and a fault can never be mistaken for an empty folder.
    const s = catalogSignpost({ loading: false, error: "HTTP 500", setCount: 0 });
    expect(s).toBe("error");
    expect(s).not.toBe("empty");
  });
});
