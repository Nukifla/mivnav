import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { settingsFromProfile } from "./profiles";

// Drift guard for the PROFILE COERCER — the profile analogue of
// serverConfig.contract.test.ts.
//
// `settingsFromProfile` (profiles.ts) is the one gate an opaque, hand-editable,
// outlives-its-writer blob passes through to become `ChartSettings` — and, since
// Track B, it is ALSO the coercer for the per-device `settings` store
// (persist.ts `deviceSetting`). `ChartSettings` (style/settings.ts) is the single
// source of truth for what that settings object contains; the same interface both
// the FE type and this coercer are held to.
//
// A field added to `ChartSettings` that the coercer forgets is invisible: on a
// well-formed blob it would ride through, but on a partial or hand-edited one it
// would simply be absent — a `symbolStyle` that silently reverts, a `windUnit` that
// vanishes. (The literal `merged: ChartSettings = {…}` in profiles.ts makes tsc
// catch a *missing* mapping too, but this test states the contract independently:
// every key is not only present but individually PRODUCED by the coercer, so a
// future refactor to a spread-the-defaults shape cannot pass a field through
// uncoerced.) A new key lands as a red test here until it is mapped.

const SETTINGS_TS = join(import.meta.dir, "style/settings.ts");

/** The property names of a TS `export interface`, from the source. Same shape
 * as serverConfig.contract.test.ts's parser: a `name:` (optionally `name?:`) at
 * the interface's own indent; JSDoc lines start with `*` and never match. */
function interfaceFields(src: string, name: string, file: string): string[] {
  const m = src.match(new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`interface ${name} not found in ${file}`);
  const fields = [...m[1].matchAll(/^\s{2}(\w+)\??\s*:/gm)].map((f) => f[1]);
  if (fields.length === 0) throw new Error(`no fields parsed for ${name}`);
  return fields;
}

const settingsSrc = readFileSync(SETTINGS_TS, "utf8");

const chartSettingsFields = interfaceFields(settingsSrc, "ChartSettings", "style/settings.ts");

describe("the profile coercer stays in lockstep with ChartSettings", () => {
  test("the parse is non-trivial (guards against a vacuous pass)", () => {
    // ChartSettings is a large interface; a handful of fields means the regex
    // broke and every coverage assertion below would be vacuously true.
    expect(chartSettingsFields.length).toBeGreaterThan(10);
  });

  test("settingsFromProfile produces every ChartSettings field", () => {
    // Fed nothing: the pure defaults path, whose output must still carry the
    // full shape — this is exactly what a partial/corrupt stored blob collapses
    // to, and a consumer that reads e.g. `settings().windUnit` must never get
    // `undefined`.
    const produced = new Set(Object.keys(settingsFromProfile({})));
    const missing = chartSettingsFields.filter((f) => !produced.has(f));
    expect(missing).toEqual([]);
  });

  test("settingsFromProfile drops keys ChartSettings does not declare", () => {
    // The other half of "single source": a newer client's field cannot ride
    // through an older one unedited. Everything the coercer emits is a
    // ChartSettings key — nothing extra.
    const declared = new Set(chartSettingsFields);
    const extra = Object.keys(settingsFromProfile({ someFutureKey: 1 })).filter(
      (k) => !declared.has(k),
    );
    expect(extra).toEqual([]);
  });
});
