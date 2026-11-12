import { describe, expect, test } from "bun:test";
import { regionsOf, sourceOf, withRegion, type NoticeSourcesResponse } from "./datasetParamsModel";

const CATALOG: NoticeSourcesResponse = {
  default: "dk-niord",
  sources: [
    {
      id: "dk-niord",
      label: "Danish notices to mariners (Niord)",
      publisher: "DMA",
      regions: [
        { id: "dk", label: "Denmark", description: "" },
        { id: "gl", label: "Greenland", description: "" },
      ],
    },
  ],
};
const DK = CATALOG.sources[0];

describe("notices dataset params", () => {
  test("the source is the implementation, else the catalog default", () => {
    expect(sourceOf(CATALOG, null)?.id).toBe("dk-niord");
    expect(sourceOf(CATALOG, "dk-niord")?.id).toBe("dk-niord");
    expect(sourceOf(CATALOG, "se-x")).toBeUndefined();
    expect(sourceOf(undefined, null)).toBeUndefined();
  });

  test("absent regions mean every region; unknown ids are dropped", () => {
    expect(regionsOf({}, DK)).toEqual(["dk", "gl"]);
    expect(regionsOf({ regions: ["gl", "fo"] }, DK)).toEqual(["gl"]);
  });

  test("toggling keeps catalog order and never empties the list", () => {
    expect(withRegion({}, DK, "gl", false)).toEqual({ regions: ["dk"] });
    expect(withRegion({ regions: ["gl"] }, DK, "dk", true)).toEqual({ regions: ["dk", "gl"] });
    expect(withRegion({ regions: ["dk"] }, DK, "dk", false)).toEqual({ regions: ["dk"] });
  });
});
