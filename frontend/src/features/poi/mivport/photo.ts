// Turns a picked image into the two JPEGs mivport takes (mivport README,
// "Photos"): mivport never decodes or resizes, so all image work happens in
// the browser. Ported from the poi-testclient's photo.js.
//   view   long edge at most 1600 px, at most 2 MB
//   thumb  the view scaled to a long edge of 320 px, at most 200 KB
// Also reads the time taken and the GPS position from the EXIF before the
// pixels are re-encoded (which drops all metadata).
//
// `scaled`, `parseExif` and `exifTime` are pure (unit-tested); the canvas
// work in `preparePhoto` needs a browser.

export const PHOTO_SIZES = {
  view: { edge: 1600, max: 2 << 20 },
  thumb: { edge: 320, max: 200 << 10 },
} as const;

/** The licence every upload is published under. */
export const PHOTO_LICENCE = { name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" } as const;

/** `w`×`h` scaled down so the long edge is at most `edge` (never up), with
 * mivport's own rounding. */
export function scaled(w: number, h: number, edge: number): [number, number] {
  const long = Math.max(w, h);
  if (long <= edge) return [w, h];
  return [Math.max(1, Math.round((w * edge) / long)), Math.max(1, Math.round((h * edge) / long))];
}

export interface PhotoExif {
  /** RFC 3339, UTC. */
  takenAt?: string;
  lat?: number;
  lon?: number;
}

export interface PreparedPhoto extends PhotoExif {
  view: Blob;
  thumb: Blob;
  width: number;
  height: number;
}

/** "2026:07:01 12:00:00" (+ "+02:00" when known) → RFC 3339 UTC. Without an
 * offset the time is read as this browser's local time. Nonsense (zeros, the
 * far future, before 1900) → undefined. */
export function exifTime(s: string | undefined, offset?: string, now = Date.now()): string | undefined {
  const m = s?.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
  if (!m || m[1] === "0000") return undefined;
  const [, Y, M, D, h, mi, se] = m;
  const local = `${Y}-${M}-${D}T${h}:${mi}:${se}`;
  const d = /^[+-]\d\d:\d\d$/.test(offset ?? "") ? new Date(local + offset) : new Date(local);
  if (Number.isNaN(d.getTime()) || d.getTime() > now + 864e5 || d.getFullYear() < 1900) return undefined;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The EXIF of a JPEG's first bytes: time taken and GPS position. Never
 * throws — an unreadable header is no EXIF. */
export function parseExif(buf: DataView, now = Date.now()): PhotoExif {
  try {
    if (buf.byteLength < 4 || buf.getUint16(0) !== 0xffd8) return {};
    let off = 2;
    while (off + 4 <= buf.byteLength) {
      const marker = buf.getUint16(off);
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
      const len = buf.getUint16(off + 2);
      // APP1 "Exif\0\0"
      if (marker === 0xffe1 && buf.getUint32(off + 4) === 0x45786966) return parseTiff(buf, off + 10, now);
      off += 2 + len;
    }
  } catch {
    // A truncated or odd header: no EXIF.
  }
  return {};
}

interface Tag {
  type: number;
  count: number;
  at: number;
}

function parseTiff(v: DataView, t: number, now: number): PhotoExif {
  const le = v.getUint16(t) === 0x4949;
  const u16 = (o: number) => v.getUint16(t + o, le);
  const u32 = (o: number) => v.getUint32(t + o, le);
  const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 };
  const ifd = (at: number): Record<number, Tag> => {
    const tags: Record<number, Tag> = {};
    const n = u16(at);
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = (SIZE[type] ?? 1) * count;
      tags[u16(e)] = { type, count, at: size > 4 ? u32(e + 8) : e + 8 };
    }
    return tags;
  };
  const str = (tag: Tag | undefined) =>
    tag &&
    new TextDecoder()
      .decode(new Uint8Array(v.buffer, v.byteOffset + t + tag.at, tag.count))
      .replace(/\0[\s\S]*$/, "");
  const rationals = (tag: Tag | undefined) =>
    tag && Array.from({ length: tag.count }, (_, i) => u32(tag.at + i * 8) / (u32(tag.at + i * 8 + 4) || 1));

  const ifd0 = ifd(u32(4));
  const out: PhotoExif = {};
  if (ifd0[0x8769]) {
    const ex = ifd(u32(ifd0[0x8769].at));
    const taken = exifTime(str(ex[0x9003]) ?? str(ifd0[0x0132]), str(ex[0x9011]), now);
    if (taken) out.takenAt = taken;
  }
  if (ifd0[0x8825]) {
    const gps = ifd(u32(ifd0[0x8825].at));
    const lat = rationals(gps[2]);
    const lon = rationals(gps[4]);
    if (lat?.length === 3 && lon?.length === 3) {
      const deg = ([d, m, s]: number[]) => d + m / 60 + s / 3600;
      const y = deg(lat) * (str(gps[1]) === "S" ? -1 : 1);
      const x = deg(lon) * (str(gps[3]) === "W" ? -1 : 1);
      // 0,0 is what some cameras write without a fix.
      if (Number.isFinite(y) && Number.isFinite(x) && Math.abs(y) <= 90 && Math.abs(x) <= 180 && (y || x)) {
        out.lat = Number(y.toFixed(6));
        out.lon = Number(x.toFixed(6));
      }
    }
  }
  return out;
}

/** "1600×1200 px, 412 KB (thumbnail 24 KB) · taken 1 Jul 2026, 12:00". */
export function photoInfo(p: Pick<PreparedPhoto, "width" | "height" | "view" | "thumb" | "takenAt">, locale?: string): string {
  const kb = (b: Blob) => `${Math.round(b.size / 1024)} KB`;
  const parts = [`${p.width}×${p.height} px, ${kb(p.view)} (thumbnail ${kb(p.thumb)})`];
  if (p.takenAt) {
    const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(p.takenAt));
    parts.push(`taken ${when}`);
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Browser-only

/** Prepare a picked file: the two JPEGs and what its EXIF says. Rejects with
 * prose fit to show. */
export async function preparePhoto(file: Blob): Promise<PreparedPhoto> {
  const exif = await file
    .slice(0, 256 << 10)
    .arrayBuffer()
    .then((b) => parseExif(new DataView(b)))
    .catch((): PhotoExif => ({}));
  const src = await decode(file);
  const [w, h] = scaled(src.width, src.height, PHOTO_SIZES.view.edge);
  const viewCanvas = resize(src, w, h);
  src.close?.();
  const [tw, th] = scaled(w, h, PHOTO_SIZES.thumb.edge);
  const thumbCanvas = resize(viewCanvas, tw, th);
  const view = await encode(viewCanvas, PHOTO_SIZES.view.max, "photo");
  const thumb = await encode(thumbCanvas, PHOTO_SIZES.thumb.max, "thumbnail");
  return { view, thumb, width: w, height: h, ...exif };
}

type Drawable = (ImageBitmap | HTMLCanvasElement) & { close?: () => void };

/** Decoded and upright (the EXIF orientation applied). */
async function decode(file: Blob): Promise<Drawable> {
  try {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      if (e instanceof TypeError) return await createImageBitmap(file);
      throw e;
    }
  } catch {
    throw new Error("This browser can’t read that image. Pick a JPEG or PNG.");
  }
}

/** Scale down in halving steps so a big reduction stays sharp, onto white
 * (JPEG has no transparency). */
function resize(src: Drawable, w: number, h: number): HTMLCanvasElement {
  let cur: Drawable = src;
  let cw = src.width;
  let ch = src.height;
  while (cw / 2 >= w && ch / 2 >= h) {
    cw = Math.round(cw / 2);
    ch = Math.round(ch / 2);
    cur = draw(cur, cw, ch);
  }
  return draw(cur, w, h);
}

function draw(src: Drawable, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) throw new Error("This browser can’t resize images.");
  // JPEG paper, not a theme colour: a transparent PNG must not turn black.
  g.fillStyle = "white";
  g.fillRect(0, 0, w, h);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, w, h);
  return c;
}

/** JPEG at quality 0.82, lower while it is over the limit. */
async function encode(canvas: HTMLCanvasElement, max: number, name: string): Promise<Blob> {
  for (const q of [0.82, 0.72, 0.6, 0.45]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q));
    if (!blob) throw new Error(`Couldn’t make the ${name} JPEG.`);
    if (blob.size <= max) return blob;
  }
  throw new Error(`The ${name} stays over ${max >> 10} KB.`);
}
