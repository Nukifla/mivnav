import { describe, expect, test } from "bun:test";
import { diskCacheFill, pretileProgress, type DiskTileCacheStats } from "./diskTileCache";

const GB = 1024 ** 3;
const base: DiskTileCacheStats = {
  state: "ready",
  locked_reason: "",
  bytes: 1 * GB,
  budget: 4 * GB,
  evictions: 0,
};

describe("diskCacheFill", () => {
  test("a quarter full", () => {
    const f = diskCacheFill(base);
    expect(f.pct).toBe(25);
    expect(f.label).toBe("1.0 GB of 4.0 GB (25%)");
    expect(f.full).toBe(false);
  });

  test("evictions mean full, whatever the ratio says", () => {
    const f = diskCacheFill({ ...base, evictions: 12 });
    expect(f.full).toBe(true);
    expect(f.note).toContain("12 tiles evicted");
  });

  test("nearly full without evictions yet", () => {
    expect(diskCacheFill({ ...base, bytes: 3.6 * GB }).full).toBe(true);
  });

  test("locked shows why, with no bar", () => {
    const f = diskCacheFill({ ...base, state: "locked", locked_reason: "machine fingerprint unavailable" });
    expect(f.pct).toBeNull();
    expect(f.label).toBe("Locked");
    expect(f.note).toBe("machine fingerprint unavailable");
  });

  test("off and not yet measured", () => {
    expect(diskCacheFill({ ...base, state: "off" }).label).toBe("Off");
    expect(diskCacheFill({ ...base, bytes: null }).pct).toBeNull();
  });
});

describe("pretileProgress", () => {
  const pre = { state: "planning", total: 0, done: 0, rendered: 0, failed: 0 };
  const warm = (p: Partial<typeof pre>) => ({ state: "warm", pretile: { ...pre, ...p } });

  test("off when prefetch or the disk cache is off", () => {
    expect(pretileProgress({ state: "disabled" }).label).toBe("Off");
    expect(pretileProgress(warm({ state: "disabled" })).busy).toBe(false);
  });

  test("percent while rendering", () => {
    const p = pretileProgress(warm({ state: "rendering z9/1/2", total: 2000, done: 500 }));
    expect(p.pct).toBe(25);
    expect(p.busy).toBe(true);
    expect(p.label).toContain("25%");
  });

  test("planning with a total is the walk over already-cached tiles", () => {
    expect(pretileProgress(warm({ total: 400, done: 100 })).pct).toBe(25);
    const planning = pretileProgress(warm({}));
    expect(planning.pct).toBeNull();
    expect(planning.busy).toBe(true);
  });

  test("done", () => {
    const p = pretileProgress(warm({ state: "complete", total: 1234, done: 1234, failed: 2 }));
    expect(p.busy).toBe(false);
    expect(p.label).toContain("Done");
    expect(p.label).toContain("2 failed");
  });

  test("stopped when overview cells do not fit", () => {
    expect(pretileProgress({ state: "oversized" }).busy).toBe(false);
  });
});
