import { describe, expect, test } from "bun:test";
import { acceptedText, NOT_OFFICIAL_CHARTS, type Licence } from "./ochartsLicence";

describe("NOT_OFFICIAL_CHARTS", () => {
  test("is o-charts' exact wording, verbatim", () => {
    expect(NOT_OFFICIAL_CHARTS).toBe(
      "o-charts sets are not official charts under carriage requirements.",
    );
  });
});

describe("acceptedText", () => {
  const base: Licence = {
    set_id: "oeuSENC-DK-2026-1-31",
    name: "Denmark",
    edition: "2026/01-31",
    eula_id: "abc",
    accepted_at: Date.UTC(2026, 10, 13, 12) / 1000,
    accepted_via: "install",
  };

  test("an install-time acceptance gives its date", () => {
    const text = acceptedText(base, "en-GB");
    expect(text).toContain("13 Nov 2026");
    expect(text).toContain("before install");
  });

  test("a carried-over device acceptance says where it came from", () => {
    expect(acceptedText({ ...base, accepted_via: "device" }, "en-GB")).toContain("registered screen");
  });

  test("never invents a date", () => {
    expect(acceptedText({ ...base, accepted_at: null })).toBe(
      "Installed before acceptance was recorded.",
    );
    expect(acceptedText({ ...base, eula_id: null })).toBe("Ships no licence agreement.");
  });
});
