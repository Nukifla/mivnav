import { describe, expect, test } from "bun:test";
import { providerOptions } from "./historyProvider";

// The boat, 2026-10-28: KIP registered itself as the default history provider.
const BOAT = [
  { id: "kip", default: true },
  { id: "signalk-to-influxdb2", default: false },
];

describe("providerOptions", () => {
  test("SignalK's default comes first and says which provider it is now", () => {
    expect(providerOptions(BOAT, null)).toEqual([
      { value: "", label: "SignalK's default (now kip)" },
      { value: "kip", label: "kip (default)" },
      { value: "signalk-to-influxdb2", label: "signalk-to-influxdb2" },
    ]);
  });

  test("a saved provider the box no longer registers is still shown, marked", () => {
    const options = providerOptions(BOAT, "signalk-parquet");
    expect(options.at(-1)).toEqual({
      value: "signalk-parquet",
      label: "signalk-parquet (not registered)",
    });
  });

  test("nothing listed yet still offers the default and the saved choice", () => {
    expect(providerOptions([], "signalk-to-influxdb2").map((o) => o.value)).toEqual([
      "",
      "signalk-to-influxdb2",
    ]);
  });
});
