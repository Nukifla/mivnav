import { describe, expect, test } from "bun:test";
import { formatAgo } from "./format";

describe("formatAgo", () => {
  test("seconds below a minute", () => {
    expect(formatAgo(0)).toBe("0 s ago");
    expect(formatAgo(5)).toBe("5 s ago");
    expect(formatAgo(59)).toBe("59 s ago");
  });

  test("rolls to minutes at 60 s and stays there below an hour", () => {
    expect(formatAgo(60)).toBe("1 min ago");
    expect(formatAgo(90)).toBe("1 min ago"); // floors, never "1.5 min"
    expect(formatAgo(59 * 60 + 59)).toBe("59 min ago");
  });

  test("rolls to hours at 3600 s, dropping a zero minute", () => {
    expect(formatAgo(3600)).toBe("1 h ago");
    expect(formatAgo(2 * 3600 + 14 * 60)).toBe("2 h 14 min ago");
    expect(formatAgo(2 * 3600 + 59 * 60 + 59)).toBe("2 h 59 min ago");
  });

  test("floors fractional seconds and clamps a negative age", () => {
    expect(formatAgo(0.9)).toBe("0 s ago");
    expect(formatAgo(-3)).toBe("0 s ago");
  });
});
