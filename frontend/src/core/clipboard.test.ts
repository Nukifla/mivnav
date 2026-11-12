// The clipboard POLICY, driven through injected paths — because the case that
// actually matters cannot be reproduced in a test runner or on a developer's
// machine: the boat is a plain-HTTP LAN deployment, a NON-secure context,
// where `navigator.clipboard` simply does not exist. Every one of these cases
// is a shape the real deployment can be in.

import { describe, expect, test } from "bun:test";
import { copyText, type ClipboardEnv } from "./clipboard";

function env(over: Partial<ClipboardEnv> = {}): { env: ClipboardEnv; legacyCalls: string[] } {
  const legacyCalls: string[] = [];
  return {
    env: { legacy: (t) => (legacyCalls.push(t), true), ...over },
    legacyCalls,
  };
}

describe("copyText", () => {
  test("secure context: the modern API takes it, the fallback is never touched", async () => {
    const written: string[] = [];
    const { env: e, legacyCalls } = env({
      writeText: async (t) => {
        written.push(t);
      },
    });
    expect(await copyText("56°30.000′N", e)).toBe(true);
    expect(written).toEqual(["56°30.000′N"]);
    expect(legacyCalls).toEqual([]);
  });

  test("the boat: no navigator.clipboard at all, so the legacy path copies", async () => {
    const { env: e, legacyCalls } = env();
    expect(await copyText("56°30.000′N", e)).toBe(true);
    expect(legacyCalls).toEqual(["56°30.000′N"]);
  });

  test("a writeText that exists but rejects falls THROUGH, it does not fail", async () => {
    // A denied permission, or an origin that exposes the object without
    // honouring it — the legacy path is not subject to the same gate, so
    // reporting failure here would give up a copy that would have worked.
    const { env: e, legacyCalls } = env({ writeText: () => Promise.reject(new Error("denied")) });
    expect(await copyText("x", e)).toBe(true);
    expect(legacyCalls).toEqual(["x"]);
  });

  test("both paths out: false, so the caller can SAY the copy failed", async () => {
    const e: ClipboardEnv = { writeText: () => Promise.reject(new Error("no")), legacy: () => false };
    expect(await copyText("x", e)).toBe(false);
  });

  test("a legacy path that throws is a failure, not an escaped exception", async () => {
    const e: ClipboardEnv = {
      legacy: () => {
        throw new Error("no document");
      },
    };
    expect(await copyText("x", e)).toBe(false);
  });
});
