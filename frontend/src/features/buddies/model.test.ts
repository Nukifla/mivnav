import { describe, expect, test } from "bun:test";
import { buildAisScene, hullIcon, riskColor, targetTone, vesselColors } from "../../core/layers/aisSymbols";
import { DEFAULT_SETTINGS } from "../../core/style/settings";
import { DEFAULT_COLLISION_SETTINGS } from "../../core/collisionSettings";
import { ageText, buddyFeatures, canAddBuddy, filterBuddies, displayName, OLD_AFTER_S, remembered, shortAge, sortBuddies, sourceText, type Buddy } from "./model";

const at = (ageS: number) => ({ lat: 56, lng: 10, source: "aiscast", fixAtIso: "", ageS });
const palette = DEFAULT_SETTINGS.palette;
const FIVE_DAYS = 432_000;

describe("age", () => {
  test("five days reads as five days, not 120 hours", () => {
    expect(shortAge(FIVE_DAYS)).toBe("5 d");
    expect(ageText(FIVE_DAYS)).toBe("5 d ago");
  });
  test("recent ages", () => {
    expect(ageText(10)).toBe("just now");
    expect(shortAge(600)).toBe("10 min");
    expect(shortAge(7_200)).toBe("2 h");
  });
});

describe("naming", () => {
  test("the nickname follows the AIS name in parentheses", () => {
    expect(displayName({ id: "1", nickname: "bird", aisName: "SEABIRD" })).toBe("SEABIRD (bird)");
  });
  test("without both, whichever exists, then the MMSI", () => {
    expect(displayName({ id: "1", nickname: "bird", mmsi: "219123456" })).toBe("bird");
    expect(displayName({ id: "1", aisName: "SEABIRD", mmsi: "219123456" })).toBe("SEABIRD");
    expect(displayName({ id: "1", mmsi: "219123456" })).toBe("MMSI 219123456");
  });
});

describe("source", () => {
  test("own receiver and online are told apart", () => {
    expect(sourceText({ ...at(1), source: "signalk", via: "local" })).toBe("Own receiver");
    expect(sourceText({ ...at(1), source: "signalk", via: "online" })).toBe("Online (aiscast)");
    expect(sourceText({ ...at(1), via: "aishub" })).toBe("Online (aiscast, AISHub)");
  });
});

describe("remembered", () => {
  const petrel: Buddy = { id: "m", mmsi: "219654321", position: at(10) };
  const bird: Buddy = { id: "v", mmsi: "219123456", position: at(FIVE_DAYS) };
  const none: Buddy = { id: "n", mmsi: "111111111" };

  test("a live target wins, and a buddy with no position has nothing to draw", () => {
    expect(remembered([petrel, bird, none], new Set(["219654321"]))).toEqual([bird]);
  });
  test("newest first, no position last", () => {
    expect(sortBuddies([none, bird, petrel]).map((b) => b.id)).toEqual(["m", "v", "n"]);
  });
});

describe("drawing", () => {
  const draw = (ageS: number) =>
    buddyFeatures([{ id: "v", aisName: "SEABIRD", shipTypeId: 36, position: at(ageS) }], palette)
      .features[0]!.properties!;

  test("an old position is hollow and labelled with its age", () => {
    const f = draw(FIVE_DAYS);
    expect(f.icon).toBe(hullIcon("buddy-old", palette, "leaf"));
    expect(f.label).toBe("SEABIRD · 5 d");
  });
  test("a fresh one is solid", () => {
    expect(draw(OLD_AFTER_S - 1).icon).toBe(hullIcon("buddy", palette, "leaf"));
  });
  test("every buddy feature is only a symbol: no predictor or CPA to lie with", () => {
    const { features } = buddyFeatures([{ id: "v", position: { ...at(1), cogDeg: 90, sogMs: 5 } }], palette);
    expect(features.map((f) => f.geometry.type)).toEqual(["Point"]);
  });
});

describe("tone", () => {
  test("a buddy is its own colour when safe, and a danger colour when not", () => {
    expect(targetTone("green", true, true)).toBe("buddy");
    expect(targetTone("unknown", true, true)).toBe("buddy");
    expect(targetTone("red", true, true)).toBe("red");
    expect(targetTone("yellow", true, true)).toBe("yellow");
    expect(targetTone("red", false, true)).toBe("buddy");
    expect(targetTone("red", true, false)).toBe("red");
    expect(targetTone("red", false, false)).toBe("off");
  });
  test("the buddy colour is distinct from every risk colour in every vessel table", () => {
    const V = vesselColors(palette);
    expect(new Set([V.buddy, V.green, V.yellow, V.red, V.unknown, V.own]).size).toBe(6);
    expect(riskColor(palette, "buddy")).toBe(V.buddy);
  });

  const own = { lat: 56, lng: 10, cogDeg: 0, sogMs: 5 };
  const closing = { lat: 56.01, lng: 10, cogDeg: 180, sogMs: 5, mmsi: "219654321" };
  const hull = (buddy: boolean) =>
    buildAisScene(own, [{ ...closing, buddy }], { ...DEFAULT_SETTINGS, collision: DEFAULT_COLLISION_SETTINGS }, 0).targets.features[0]!.properties!;

  test("a buddy on a collision course stays red and gains the ring", () => {
    expect(hull(true).icon).toBe(hull(false).icon);
    expect(hull(true).buddyRing).toBe(riskColor(palette, "buddy"));
    expect(hull(false).buddyRing).toBeUndefined();
  });
});

describe("adding from a tapped boat", () => {
  const boat = { id: "b", lat: 56, lng: 10, mmsi: "219654321" };
  test("offered on an ordinary boat", () => {
    expect(canAddBuddy(boat)).toBe(true);
  });
  test("not on own ship, an existing buddy, or a boat with no MMSI", () => {
    expect(canAddBuddy({ ...boat, self: true })).toBe(false);
    expect(canAddBuddy({ ...boat, buddy: true })).toBe(false);
    expect(canAddBuddy({ ...boat, mmsi: undefined })).toBe(false);
  });
  test("not on a station or a SAR aircraft", () => {
    expect(canAddBuddy({ ...boat, mmsi: "992190001" })).toBe(false);
    expect(canAddBuddy({ ...boat, mmsi: "111219001" })).toBe(false);
  });
});

describe("searching", () => {
  const bird: Buddy = { id: "v", aisName: "SEABIRD", nickname: "bird", mmsi: "219123456", callsign: "OZ1234", note: "Meet in Tromsø" };
  const petrel: Buddy = { id: "m", aisName: "PETREL", mmsi: "219654321" };
  const find = (q: string) => filterBuddies([bird, petrel], q).map((b) => b.id);

  test("an empty search shows everyone", () => {
    expect(find("  ")).toEqual(["v", "m"]);
  });
  test("any field matches, whatever the case", () => {
    expect(find("seabird")).toEqual(["v"]);
    expect(find("BIRD")).toEqual(["v"]);
    expect(find("219654")).toEqual(["m"]);
    expect(find("oz1")).toEqual(["v"]);
    expect(find("tromsø")).toEqual(["v"]);
  });
  test("every word has to match", () => {
    expect(find("bird tromsø")).toEqual(["v"]);
    expect(find("petrel tromsø")).toEqual([]);
  });
});
