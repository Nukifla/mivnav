/**
 * The photo sizing and EXIF reading (./photo.ts, ported from the
 * poi-testclient's photo.js): the two JPEG sizes mivport takes, and the time
 * and position read from a real-shaped EXIF block before re-encoding drops
 * it. The canvas half needs a browser and is not driven here.
 */

import { describe, expect, test } from "bun:test";
import { exifTime, parseExif, photoInfo, PHOTO_SIZES, scaled } from "./photo";

describe("scaled", () => {
  test("the long edge capped, aspect kept, never scaled up", () => {
    expect(scaled(4000, 3000, PHOTO_SIZES.view.edge)).toEqual([1600, 1200]);
    expect(scaled(3000, 4000, PHOTO_SIZES.view.edge)).toEqual([1200, 1600]);
    expect(scaled(800, 600, PHOTO_SIZES.view.edge)).toEqual([800, 600]);
    expect(scaled(1600, 1200, PHOTO_SIZES.thumb.edge)).toEqual([320, 240]);
  });

  test("mivport's rounding, and never below a pixel", () => {
    expect(scaled(1601, 1001, 320)).toEqual([320, 200]);
    expect(scaled(10000, 1, 320)).toEqual([320, 1]);
  });

  test("the limits mivport takes", () => {
    expect(PHOTO_SIZES.view).toEqual({ edge: 1600, max: 2 * 1024 * 1024 });
    expect(PHOTO_SIZES.thumb).toEqual({ edge: 320, max: 200 * 1024 });
  });
});

describe("exifTime", () => {
  const now = Date.parse("2026-11-17T00:00:00Z");
  test("with the recorded offset: exact UTC", () => {
    expect(exifTime("2026:07:01 12:00:00", "+02:00", now)).toBe("2026-07-01T10:00:00Z");
  });
  test("zeros, the far future and garbage are no time", () => {
    expect(exifTime("0000:00:00 00:00:00", "+00:00", now)).toBeUndefined();
    expect(exifTime("2030:01:01 00:00:00", "+00:00", now)).toBeUndefined();
    expect(exifTime("yesterday", undefined, now)).toBeUndefined();
    expect(exifTime(undefined, undefined, now)).toBeUndefined();
  });
});

/** A JPEG with one APP1 EXIF block: DateTimeOriginal + OffsetTimeOriginal in
 * the Exif IFD, and a GPS IFD — big-endian TIFF, offsets as a camera writes
 * them. */
function jpegWithExif(opts: { date: string; offset: string; lat: number[]; latRef: string; lon: number[]; lonRef: string }): DataView {
  const tiff = new DataView(new ArrayBuffer(198));
  const u16 = (o: number, v: number) => tiff.setUint16(o, v);
  const u32 = (o: number, v: number) => tiff.setUint32(o, v);
  const ascii = (o: number, s: string) => [...s].forEach((c, i) => tiff.setUint8(o + i, c.charCodeAt(0)));
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    u16(at, tag);
    u16(at + 2, type);
    u32(at + 4, count);
    u32(at + 8, value);
  };
  u16(0, 0x4d4d);
  u16(2, 42);
  u32(4, 8);
  // IFD0 at 8: Exif IFD → 38, GPS IFD → 68.
  u16(8, 2);
  entry(10, 0x8769, 4, 1, 38);
  entry(22, 0x8825, 4, 1, 68);
  u32(34, 0);
  // Exif IFD at 38.
  u16(38, 2);
  entry(40, 0x9003, 2, 20, 122);
  entry(52, 0x9011, 2, 7, 142);
  u32(64, 0);
  // GPS IFD at 68: refs inline, rationals out of line.
  u16(68, 4);
  entry(70, 1, 2, 2, 0);
  ascii(78, `${opts.latRef}\0`);
  entry(82, 2, 5, 3, 150);
  entry(94, 3, 2, 2, 0);
  ascii(102, `${opts.lonRef}\0`);
  entry(106, 4, 5, 3, 174);
  u32(118, 0);
  ascii(122, `${opts.date}\0`);
  ascii(142, `${opts.offset}\0`);
  opts.lat.forEach((v, i) => {
    u32(150 + i * 8, v);
    u32(154 + i * 8, 1);
  });
  opts.lon.forEach((v, i) => {
    u32(174 + i * 8, v);
    u32(178 + i * 8, 1);
  });

  const out = new Uint8Array(4 + 2 + 6 + tiff.byteLength + 4);
  const v = new DataView(out.buffer);
  v.setUint16(0, 0xffd8);
  v.setUint16(2, 0xffe1);
  v.setUint16(4, 2 + 6 + tiff.byteLength);
  out.set([0x45, 0x78, 0x69, 0x66, 0, 0], 6);
  out.set(new Uint8Array(tiff.buffer), 12);
  v.setUint16(12 + tiff.byteLength, 0xffda);
  return v;
}

describe("parseExif", () => {
  const now = Date.parse("2026-11-17T00:00:00Z");
  test("time taken and position, west and south negative", () => {
    const buf = jpegWithExif({
      date: "2026:07:01 12:00:00",
      offset: "+02:00",
      lat: [55, 30, 0],
      latRef: "S",
      lon: [12, 15, 36],
      lonRef: "W",
    });
    expect(parseExif(buf, now)).toEqual({ takenAt: "2026-07-01T10:00:00Z", lat: -55.5, lon: -12.26 });
  });

  test("0,0 (no fix) is no position", () => {
    const buf = jpegWithExif({
      date: "2026:07:01 12:00:00",
      offset: "+00:00",
      lat: [0, 0, 0],
      latRef: "N",
      lon: [0, 0, 0],
      lonRef: "E",
    });
    expect(parseExif(buf, now)).toEqual({ takenAt: "2026-07-01T12:00:00Z" });
  });

  test("not a JPEG, or a truncated header: no EXIF, no throw", () => {
    expect(parseExif(new DataView(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer))).toEqual({});
    const full = jpegWithExif({ date: "2026:07:01 12:00:00", offset: "+00:00", lat: [1, 0, 0], latRef: "N", lon: [1, 0, 0], lonRef: "E" });
    expect(parseExif(new DataView(full.buffer, 0, 40))).toEqual({});
  });
});

describe("photoInfo", () => {
  test("size, both file sizes, when taken", () => {
    const view = new Blob([new Uint8Array(412 * 1024)]);
    const thumb = new Blob([new Uint8Array(24 * 1024)]);
    expect(photoInfo({ width: 1600, height: 1200, view, thumb }, "en")).toBe("1600×1200 px, 412 KB (thumbnail 24 KB)");
    expect(photoInfo({ width: 1, height: 1, view, thumb, takenAt: "2026-07-01T10:00:00Z" }, "en")).toContain("taken ");
  });
});
