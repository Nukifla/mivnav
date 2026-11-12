/**
 * The MMSI grammar and the MID table it resolves against.
 *
 * Run with `bun run test` — never bare `bun test`, which resolves solid-js's
 * SSR build. (Nothing here is reactive, but the rule is the rule.)
 *
 * What is pinned, beyond "219 is Denmark":
 *
 *  - The country comes out of the *right offset for the format*. An AtoN, a
 *    coast station and a ship can all carry MID 219 and all three are Danish;
 *    a first-three-digits reader gets one of the three right.
 *  - A device that has no country shows none. An AIS-SART is a distress
 *    beacon; captioning it "Sweden" because its manufacturer id happened to
 *    look like a MID is the worst failure available here.
 *  - Unassigned MIDs and malformed numbers degrade to `undefined`, never to a
 *    guess and never to the string "undefined".
 *  - The committed table matches the ITU: spot-checked against countries
 *    verified by hand at https://www.itu.int/gladapp/Allocation/MIDs, plus
 *    structural invariants over all ~290 rows that a bad regenerate would
 *    break.
 */

import { describe, expect, test } from "bun:test";
import { MID_TO_COUNTRY } from "./midTable.generated";
import { isNonVesselStation, isSarAircraft, mmsiCountry, parseMmsi, type MmsiKind } from "./mmsi";

const DENMARK = "Denmark";
const SWEDEN = "Sweden";
const UK = "United Kingdom of Great Britain and Northern Ireland";

describe("the MID table", () => {
  // These are the anchors: if a regenerate ever moves one of these, the table
  // is wrong and every assertion below it is worthless.
  test("spot-checks against the ITU's published table", () => {
    expect(MID_TO_COUNTRY["219"]).toBe(DENMARK);
    expect(MID_TO_COUNTRY["220"]).toBe(DENMARK);
    expect(MID_TO_COUNTRY["265"]).toBe(SWEDEN);
    expect(MID_TO_COUNTRY["266"]).toBe(SWEDEN);
    for (const mid of ["232", "233", "234", "235"]) expect(MID_TO_COUNTRY[mid]).toBe(UK);
    expect(MID_TO_COUNTRY["211"]).toBe("Germany (Federal Republic of)");
    expect(MID_TO_COUNTRY["257"]).toBe("Norway");
    expect(MID_TO_COUNTRY["338"]).toBe("United States of America");
  });

  test("is the whole list, not a sample", () => {
    // 292 at the 2026-07 regenerate. A table that silently halved — a parse
    // that matched fewer rows after an ITU redesign — must fail here even
    // though every spot-check above would still pass.
    expect(Object.keys(MID_TO_COUNTRY).length).toBeGreaterThanOrEqual(280);
  });

  test("every MID is three digits in 201-775, which is what makes the grammar unambiguous", () => {
    // Not decoration: `mmsi.ts` relies on no assigned MID starting with 0, 1,
    // 8 or 9, because those are exactly the non-ship format prefixes. If the
    // ITU ever assigns MID 8xx, `8MIDXXXXX` (handheld) becomes ambiguous with
    // a ship station and this test is the alarm.
    for (const [mid, country] of Object.entries(MID_TO_COUNTRY)) {
      expect(mid).toMatch(/^\d{3}$/);
      expect(Number(mid)).toBeGreaterThanOrEqual(201);
      expect(Number(mid)).toBeLessThanOrEqual(775);
      expect(country.length).toBeGreaterThan(0);
    }
  });

  test("keeps the ITU's formal names, which is what keeps the two Koreas apart", () => {
    // The argument against "prettifying" these, as data. Strip "(Republic
    // of)" and 440 becomes a bare "Korea" indistinguishable from 445.
    expect(MID_TO_COUNTRY["440"]).toBe("Korea (Republic of)");
    expect(MID_TO_COUNTRY["445"]).toBe("Democratic People's Republic of Korea");
    expect(MID_TO_COUNTRY["615"]).toBe("Congo (Republic of the)");
    expect(MID_TO_COUNTRY["676"]).toBe("Democratic Republic of the Congo");
  });

  test("resolves the shared Dutch Caribbean MID to the state all three share", () => {
    // 306 is listed three times by the ITU (Bonaire/Sint Eustatius and Saba,
    // Curaçao, Sint Maarten). The MMSI genuinely cannot say which; the
    // sovereign state is the part that is certain, and it is what we show.
    expect(MID_TO_COUNTRY["306"]).toBe("Netherlands (Kingdom of the)");
  });
});

describe("ship stations", () => {
  test("read their country from the first three digits", () => {
    expect(mmsiCountry("219000001")).toBe(DENMARK);
    expect(mmsiCountry("265123456")).toBe(SWEDEN);
    expect(mmsiCountry("235098765")).toBe(UK);
  });

  test("are classified as ships", () => {
    expect(parseMmsi("219000001")).toEqual({ kind: "ship", mid: "219", country: DENMARK });
  });
});

describe("the formats whose MID is not the first three digits", () => {
  // The heart of it. Every one of these is a Danish station (MID 219) wearing
  // a different M.585 format. A first-three-digits reader answers `undefined`
  // for all of them; the right answer is Denmark for all of them.
  const danish: readonly { mmsi: string; kind: MmsiKind; what: string }[] = [
    { mmsi: "992191234", kind: "aton", what: "an aid to navigation (99MIDXXXX)" },
    { mmsi: "002191000", kind: "coast", what: "a coast station (00MIDXXXX)" },
    { mmsi: "982191234", kind: "craft", what: "a craft with a parent ship (98MIDXXXX)" },
    { mmsi: "111219123", kind: "sar-aircraft", what: "a SAR aircraft (111MIDXXX)" },
    { mmsi: "021912345", kind: "group-ship", what: "a group of ships (0MIDXXXXX)" },
    { mmsi: "821912345", kind: "handheld", what: "a handheld VHF (8MIDXXXXX)" },
  ];

  for (const { mmsi, kind, what } of danish) {
    test(`${what} is Danish, and is known to be ${kind}`, () => {
      expect(parseMmsi(mmsi)).toEqual({ kind, mid: "219", country: DENMARK });
    });
  }

  test("a coast station is not misread as a group of ships", () => {
    // The one place prefix order actually bites: "00" must beat "0".
    expect(parseMmsi("002191000")?.kind).toBe("coast");
    expect(parseMmsi("021912345")?.kind).toBe("group-ship");
  });
});

describe("devices that have no country", () => {
  // 970/972/974/979 are followed by a manufacturer id, not a MID. The digits
  // are chosen to be maximally tempting: `970` + `265`… would read as Sweden
  // to anything that goes looking for a MID after the prefix.
  const freeform: readonly { mmsi: string; kind: MmsiKind; what: string }[] = [
    { mmsi: "970265123", kind: "sart", what: "AIS-SART" },
    { mmsi: "972219456", kind: "mob", what: "MOB device" },
    { mmsi: "974232789", kind: "epirb", what: "EPIRB-AIS" },
    { mmsi: "979211000", kind: "amrd-b", what: "AMRD Group B" },
  ];

  for (const { mmsi, kind, what } of freeform) {
    test(`${what} (${mmsi}) reports no country at all`, () => {
      expect(parseMmsi(mmsi)).toEqual({ kind });
      expect(mmsiCountry(mmsi)).toBeUndefined();
    });
  }

  test("no freeform device leaks a MID", () => {
    for (const { mmsi } of freeform) {
      expect(parseMmsi(mmsi)?.mid).toBeUndefined();
      expect(parseMmsi(mmsi)?.country).toBeUndefined();
    }
  });
});

describe("degrading gracefully", () => {
  test("an unassigned MID yields no country, but still says what it claimed", () => {
    // 299 is not assigned. The number is a well-formed ship station whose MID
    // we cannot resolve — which is different from a number with no MID.
    expect(MID_TO_COUNTRY["299"]).toBeUndefined();
    expect(parseMmsi("299000001")).toEqual({ kind: "ship", mid: "299" });
    expect(mmsiCountry("299000001")).toBeUndefined();
  });

  test("an unassigned MID inside a non-ship format also yields no country", () => {
    expect(parseMmsi("992991234")).toEqual({ kind: "aton", mid: "299" });
  });

  test("malformed MMSIs are refused rather than guessed at", () => {
    for (const bad of ["", "21900000", "2190000012", "219abc001", "  219000001", "219 000 001"]) {
      expect(parseMmsi(bad)).toBeUndefined();
      expect(mmsiCountry(bad)).toBeUndefined();
    }
  });

  test("a leading-zero-stripped coast station is refused, not read as a ship", () => {
    // 002191000 shorn to 2191000 would parse as a Danish *ship* if we padded
    // or tolerated short input. It is 7 digits, so it is refused.
    expect(parseMmsi("2191000")).toBeUndefined();
  });

  test("an absent MMSI is not a country", () => {
    expect(mmsiCountry(undefined)).toBeUndefined();
  });

  test("isSarAircraft is the 111 production only", () => {
    expect(isSarAircraft("111219123")).toBe(true);
    expect(isSarAircraft("219000001")).toBe(false);
    expect(isSarAircraft("11121912")).toBe(false); // eight digits: damaged
    expect(isSarAircraft(undefined)).toBe(false);
  });

  test("isNonVesselStation is true for aids/beacons, false for ships and aircraft", () => {
    // The one fact the collision path needs: which MMSIs are NOT collision
    // targets. AtoN, coast station, and the emergency beacons — yes.
    expect(isNonVesselStation("992191234")).toBe(true); // AtoN
    expect(isNonVesselStation("002191000")).toBe(true); // coast station
    expect(isNonVesselStation("970315123")).toBe(true); // AIS-SART
    expect(isNonVesselStation("972315123")).toBe(true); // MOB
    expect(isNonVesselStation("974315123")).toBe(true); // EPIRB-AIS
    // A ship, and a SAR aircraft (a MOVING target that keeps its risk) — no.
    expect(isNonVesselStation("219000001")).toBe(false); // ship
    expect(isNonVesselStation("111219123")).toBe(false); // SAR aircraft
    // An absent or malformed MMSI is not a station.
    expect(isNonVesselStation(undefined)).toBe(false);
    expect(isNonVesselStation("2191000")).toBe(false);
  });

  test("nothing ever renders the string \"undefined\"", () => {
    for (const m of ["299000001", "970265123", "2191000", ""]) {
      expect(mmsiCountry(m)).not.toBe("undefined");
    }
  });
});
