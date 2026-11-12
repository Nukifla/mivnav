/**
 * The register guard, which is the one irreversible act in the app: it binds
 * this machine's fingerprint to a system name at o-charts.org, for good.
 *
 * The button moved (Charts panel → the sidebar's boat group), so its
 * conditions are pinned here rather than left to the JSX they were spelled
 * out in.
 */

import { describe, expect, test } from "bun:test";
import {
  canRegister,
  fncAction,
  fncSize,
  fncUpdatesSummary,
  updatesSummary,
  type FncRegionState,
  type UpdatesStatus,
} from "./ChartLibrary";

const shop = (registered: boolean) => ({ system_name: null, registered, charts: [] });

describe("canRegister", () => {
  test("not before the shop was connected on purpose", () => {
    expect(canRegister(null, "boatpc", false)).toBe(false);
  });

  test("not without a typed system name — there is no default to fall into", () => {
    expect(canRegister(shop(false), "", false)).toBe(false);
    expect(canRegister(shop(false), "   ", false)).toBe(false);
  });

  test("not while something else is in flight", () => {
    expect(canRegister(shop(false), "boatpc", true)).toBe(false);
  });

  test("not again once the account is registered", () => {
    expect(canRegister(shop(true), "boatpc", false)).toBe(false);
  });

  test("connected, unregistered, idle, named", () => {
    expect(canRegister(shop(false), "boatpc", false)).toBe(true);
  });
});

/**
 * The free-charts button. Three independent inputs — what is published, what
 * is installed, what is in flight — collapse into one control, and the case
 * that matters is "already up to date": getting it wrong invites a sailor to
 * re-download 63 MB over a boat uplink for nothing.
 */
const version = (published: string, size = 63_645_871) => ({
  etag: `"${published}"`,
  last_modified: "Mon, 20 Jul 2026 03:25:39 GMT",
  published,
  size,
});

const region = (over: Partial<FncRegionState> = {}): FncRegionState => ({
  region: "de",
  label: "Germany",
  url: "https://freenauticalchart.net/download/fnc-de.zip",
  available: version("2026-07-20"),
  installed: null,
  update_available: true,
  ...over,
});

describe("fncAction", () => {
  test("nothing installed: install", () => {
    expect(fncAction(region(), false, false)).toEqual({ label: "Install", disabled: false });
  });

  test("a newer edition published: update", () => {
    const entry = region({ installed: { ...version("2026-06-01"), set_id: "fnc-de-2026-06-01" } });
    expect(fncAction(entry, false, false)).toEqual({ label: "Update", disabled: false });
  });

  test("current edition installed: no re-download offered", () => {
    const entry = region({
      installed: { ...version("2026-07-20"), set_id: "fnc-de-2026-07-19" },
      update_available: false,
    });
    expect(fncAction(entry, false, false)).toEqual({ label: "Up to date", disabled: true });
  });

  test("publisher unreachable: never offer a download that cannot start", () => {
    const entry = region({ available: null, error: "cannot reach …", update_available: false });
    expect(fncAction(entry, false, false)).toEqual({ label: "Unavailable", disabled: true });
  });

  test("not while another action or install is in flight", () => {
    expect(fncAction(region(), true, false).disabled).toBe(true);
    expect(fncAction(region(), false, true).disabled).toBe(true);
    // ...but the label still says what pressing it would do
    expect(fncAction(region(), false, true).label).toBe("Install");
  });
});

describe("fncSize", () => {
  test("MB up to a gigabyte, then GB", () => {
    expect(fncSize(63_645_871)).toBe("64 MB");
    expect(fncSize(412_602_658)).toBe("413 MB");
    expect(fncSize(2_400_000_000)).toBe("2.4 GB");
  });

  test("an unknown size says nothing rather than '0 MB'", () => {
    expect(fncSize(0)).toBe("");
  });
});

describe("updatesSummary", () => {
  const NOW = 1_800_000_000;
  const st = (over: Partial<UpdatesStatus>): UpdatesStatus => ({
    state: "idle",
    checked_at: NOW - 7200,
    error: "",
    updates: [],
    installed: [],
    fnc: { checked_at: null, error: "" },
    ...over,
  });
  const dk = {
    chart_id: "DK",
    name: "Denmark 2026",
    set_id: "oeuSENC-DK-2026-1-31-base",
    installed_edition: "2026/1-31",
    available_edition: "2026/1-38",
    failed: "",
  };

  test("never 'up to date' before a check has run", () => {
    expect(updatesSummary(st({ checked_at: null }), NOW)).toBe(
      "Not checked since the server started.",
    );
  });

  test("never 'up to date' about a check that failed — at sea the shop is unreachable", () => {
    const text = updatesSummary(st({ error: "shop error (code AV4)" }), NOW);
    expect(text).toContain("Could not check");
    expect(text).toContain("AV4");
    expect(text).not.toContain("Up to date");
  });

  test("says what a successful check found, and how long ago", () => {
    expect(updatesSummary(st({}), NOW)).toBe("Up to date — checked 2 h ago.");
    expect(updatesSummary(st({ updates: [dk] }), NOW)).toBe(
      "1 update available — checked 2 h ago.",
    );
    expect(updatesSummary(st({ updates: [dk, dk], checked_at: NOW - 10 }), NOW)).toBe(
      "2 updates available — checked just now.",
    );
  });

  test("a run in progress outranks the last result", () => {
    expect(updatesSummary(st({ state: "checking", error: "old" }), NOW)).toBe("Checking the shop…");
    expect(updatesSummary(st({ state: "installing" }), NOW)).toBe("Installing updates…");
  });
});

describe("fncUpdatesSummary", () => {
  const NOW = 1_800_000_000;
  const st = (fnc: UpdatesStatus["fnc"]): UpdatesStatus => ({
    state: "idle",
    checked_at: null,
    error: "",
    updates: [],
    installed: [],
    fnc,
  });

  test("silent when no free charts are installed (nothing was asked)", () => {
    expect(fncUpdatesSummary(st({ checked_at: null, error: "" }), NOW)).toBe("");
    expect(fncUpdatesSummary(null, NOW)).toBe("");
  });

  test("its own line, independent of the shop's", () => {
    expect(fncUpdatesSummary(st({ checked_at: NOW - 7200, error: "" }), NOW)).toBe(
      "Free charts checked 2 h ago.",
    );
    expect(
      fncUpdatesSummary(st({ checked_at: NOW - 7200, error: "cannot reach x" }), NOW),
    ).toContain("could not update (checked 2 h ago): cannot reach x");
  });
});
