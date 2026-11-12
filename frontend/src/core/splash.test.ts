/**
 * The boot splash's words. A splash that only ever said "Starting…" gave the
 * crew no way to tell a slow Pi from a dead one; these pin that each failure
 * reads as what it is.
 */

import { describe, expect, test } from "bun:test";
import {
  BAD_ANSWER,
  describeFetchError,
  drawingStatus,
  faultHint,
  sourceLabel,
  tileFault,
  tilesStalled,
} from "./splash";

describe("describeFetchError", () => {
  test("nothing answered: fetch's TypeError, whatever the browser calls it", () => {
    expect(describeFetchError(new TypeError("Failed to fetch"))).toBe("Can't reach the server");
    expect(describeFetchError(new TypeError("Load failed"))).toBe("Can't reach the server");
    // catalog.ts keeps only the message string — no status means unreachable.
    expect(describeFetchError("NetworkError when attempting to fetch resource.")).toBe(
      "Can't reach the server",
    );
  });

  test("a server answered and failed: the status says how", () => {
    expect(describeFetchError(new Error("catalog: HTTP 502"))).toBe("Server not responding (HTTP 502)");
    expect(describeFetchError("catalog: HTTP 504")).toBe("Server not responding (HTTP 504)");
    expect(describeFetchError("catalog: HTTP 503")).toBe("Server busy (HTTP 503)");
    expect(describeFetchError("catalog: HTTP 500")).toBe("Server error (HTTP 500)");
  });

  test("a non-JSON answer is not an unreachable server", () => {
    expect(describeFetchError(new SyntaxError("Unexpected token <"))).toBe("Server sent a bad answer");
    // ...including once catalog.ts has reduced it to a string.
    expect(describeFetchError(`catalog: ${BAD_ANSWER}`)).toBe("Server sent a bad answer");
  });

  test("an attempt that timed out is unreachable: the wrong network hangs, it doesn't refuse", () => {
    expect(describeFetchError("catalog: no answer in 6 s")).toBe("Can't reach the server");
  });
});

describe("faultHint", () => {
  test("unreachable points at the network, the crew's end of the problem", () => {
    expect(faultHint("catalog: no answer in 6 s")).toContain("boat's network");
    expect(faultHint(new TypeError("Failed to fetch"), false)).toBe("This device has no network connection.");
  });

  test("something answering that isn't our server reads as the wrong network", () => {
    expect(faultHint(`catalog: ${BAD_ANSWER}`)).toContain("wrong network");
  });

  test("a server that answered isn't a network problem", () => {
    expect(faultHint("catalog: HTTP 500")).toContain("server's logs");
    expect(faultHint("catalog: HTTP 503")).toContain("overloaded");
  });
});

describe("tileFault", () => {
  test("every chart tile failing is a fault, even over a good basemap", () => {
    const fault = tileFault({
      "chart-DE1": { loaded: 0, failed: 2, status: 503 },
      "chart-DE2": { loaded: 0, failed: 1 },
      "osm-world": { loaded: 4, failed: 0 },
    });
    expect(fault?.text).toBe("Can't load the charts");
    expect(fault?.detail).toContain("3 tiles failed (HTTP 503)");
  });

  test("charts and basemap both dead names both; no status means lost contact", () => {
    const fault = tileFault({
      "chart-DE1": { loaded: 0, failed: 1 },
      "osm-world": { loaded: 0, failed: 1 },
    });
    expect(fault?.text).toBe("Can't load the charts or basemap");
    expect(fault?.detail).toContain("Lost contact");
  });

  test("a gap isn't a fault: one failed tile among good ones, or one chart set of two", () => {
    expect(tileFault({ "chart-DE1": { loaded: 5, failed: 1 } })).toBeUndefined();
    expect(
      tileFault({ "chart-DE1": { loaded: 5, failed: 0 }, "chart-DE2": { loaded: 0, failed: 3 } }),
    ).toBeUndefined();
  });

  test("a dead basemap under working charts isn't, but with nothing else drawn it is", () => {
    const dead = { loaded: 0, failed: 2 };
    expect(tileFault({ "chart-DE1": { loaded: 5, failed: 0 }, "osm-world": dead })).toBeUndefined();
    expect(tileFault({ "osm-world": dead })?.text).toBe("Can't load the basemap");
  });

  test("the boat's internet is not boot's problem: external layers never fault", () => {
    expect(tileFault({ openseamap: { loaded: 0, failed: 9 } })).toBeUndefined();
    expect(tileFault({})).toBeUndefined();
  });
});

describe("tilesStalled", () => {
  test("essential tiles wanted and none arrived", () => {
    expect(tilesStalled({}, ["chart-DE1"])).toBe(true);
    expect(tilesStalled({ "chart-DE1": { loaded: 0, failed: 1 } }, ["osm-world"])).toBe(true);
  });

  test("anything essential arriving is progress, and external layers don't count", () => {
    expect(tilesStalled({ "osm-world": { loaded: 1, failed: 0 } }, ["chart-DE1"])).toBe(false);
    expect(tilesStalled({}, ["openseamap"])).toBe(false);
  });
});

describe("drawingStatus", () => {
  test("names what is still loading, many chart sets reading as one", () => {
    expect(drawingStatus(["chart-DE1", "chart-DE2", "osm-world"])).toBe("Drawing charts, basemap…");
    expect(drawingStatus(["openseamap"])).toBe("Drawing seamarks…");
  });

  test("an unknown source is named by its id, never dropped", () => {
    expect(sourceLabel("mystery")).toBe("mystery");
    expect(drawingStatus([])).toBe("Drawing chart…");
  });
});
