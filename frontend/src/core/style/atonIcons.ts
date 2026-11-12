// On-demand ATON symbol loading (jt task qkmvmwps): the backend renders one
// icon at a time instead of a baked sprite sheet, hooked via
// `styleimagemissing` (not a tile scan), with palette applied client-side.
// Full rationale, the dusk/night regression, and the placeholder-swap
// protocol: see docs/architecture/aton-icon-loading.md.

import { substituteIconRoles, type IconRole, type IconRoleColors } from "./themes/iconRoles";

/** Symbols with no artwork — must match `chartcore/tests/derive_symbol_coverage.rs`'s
 * `NO_ARTWORK` (`atonIcons.test.ts` re-reads that file so this can't drift).
 * See docs/architecture/aton-icon-loading.md. */
export const NO_ARTWORK_SYMBOLS: ReadonlySet<string> = new Set(["LNDARE01"]);

/** What {@link NO_ARTWORK_SYMBOLS} draw instead: S-52's own question mark,
 * which chartcore does serve. */
export const PLACEHOLDER_ALIAS = "QUESMRK1";

/** Vendored SVGs are ~11-24 native units; upstream quantenschaum/mapping's
 * topmark offsets assume the same k≈2 (jt task yxrmtltk). Native size would
 * silently halve every buoy. */
export const ATON_ICON_SCALE = 2;

/** `.svg` is cosmetic here (the backend strips it) but keeps the response
 * readable as a file. */
export function atonIconUrl(id: string): string {
  return `/api/icons/${id}.svg?roles=1`;
}

/** Used to reject palette-prefixed ids (`dusk_`/`dark_`) — that rejection was
 * itself the dusk/night bug (see docs/architecture/aton-icon-loading.md). */
export function isAtonIconCandidate(id: string): boolean {
  return id.length > 0;
}

/** chartcore guarantees an explicit `viewBox` on every rendered icon
 * (`icons::pack::render`) because usvg's writer drops the one
 * `composite::stack` sets. */
export function svgViewBoxSize(svg: string): { width: number; height: number } | undefined {
  const m = /viewBox="\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)\s*"/.exec(svg);
  if (!m) return undefined;
  const width = Number(m[3]);
  const height = Number(m[4]);
  if (!(width > 0) || !(height > 0)) return undefined;
  return { width, height };
}

/** `pixels = native * scale * dpr`, and MapLibre divides by `pixelRatio`, so
 * `dpr` cancels — same physical size at any device pixel ratio. */
export function atonIconRaster(
  svg: string,
  dpr: number,
  scale: number = ATON_ICON_SCALE,
): { width: number; height: number; pixelRatio: number; svg: string } | undefined {
  const box = svgViewBoxSize(svg);
  if (!box) return undefined;
  // 4x cap: past that, extra pixels buy nothing visible but cost 16x GPU atlas space.
  const ratio = Math.min(Math.max(dpr, 1), 4);
  const width = Math.max(1, Math.ceil(box.width * scale * ratio));
  const height = Math.max(1, Math.ceil(box.height * scale * ratio));
  // viewBox left untouched so the composite::stack pivot stays centred,
  // matching MapLibre's default icon-anchor: "center".
  return { width, height, pixelRatio: ratio, svg: sizeSvg(svg, width, height) };
}

/** Rewrite (or add) the root `<svg>`'s `width`/`height` attributes. */
export function sizeSvg(svg: string, width: number, height: number): string {
  const open = svg.indexOf(">");
  if (open < 0) return svg;
  const head = svg
    .slice(0, open)
    .replace(/\swidth="[^"]*"/, "")
    .replace(/\sheight="[^"]*"/, "");
  return `${head} width="${width}" height="${height}"${svg.slice(open)}`;
}

/** Sliver of `maplibregl.Map` needed, so the loader is drivable from a plain
 * object in tests. */
export interface AtonIconTarget {
  on(type: "styleimagemissing", listener: (e: { id: string }) => void): unknown;
  hasImage(id: string): boolean;
  addImage(id: string, image: unknown, options?: { pixelRatio?: number }): void;
  updateImage(id: string, image: unknown): void;
  removeImage(id: string): void;
}

export interface AtonIconLoaderOptions {
  fetchImpl?: typeof fetch;
  /** Injected so the loader's bookkeeping is testable without a DOM. */
  decode?: (svg: string, width: number, height: number) => Promise<unknown>;
  devicePixelRatio?: number;
  /** The theme's role -> hex table (`colors.ts`'s `iconRoleColors`). Omitted
   * renders the reserved `#fe00XX` sentinels literally. */
  iconColors?: Partial<IconRoleColors>;
}

export interface AtonIconLoader {
  /** Re-colour every icon for a new theme, without refetch — needed because
   * `MapView.tsx`'s `setStyle(diff: true)` keeps registered images across a
   * palette switch, and the cached document is palette-neutral. */
  refresh(colors: Partial<IconRoleColors>): Promise<void>;
}

/** Registered synchronously so MapLibre's re-check finds an image and skips
 * its "could not be loaded" warning while the real icon fetches. Fresh
 * object per registration — MapLibre clones the ArrayBuffer. */
const PLACEHOLDER_PIXEL = () => ({ width: 1, height: 1, data: new Uint8Array(4) });

/**
 * Register the on-demand per-symbol SVG icon loader on a map. Bookkeeping
 * mirrors `features/poi/icons.ts`. Placeholder swap and failure semantics:
 * see docs/architecture/aton-icon-loading.md.
 */
export function installAtonIconLoader(
  map: AtonIconTarget,
  options: AtonIconLoaderOptions = {},
): AtonIconLoader {
  const fetchImpl = options.fetchImpl ?? fetch;
  const decode = options.decode ?? decodeSvgImage;
  const dpr = options.devicePixelRatio ?? (typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
  const inFlight = new Map<string, Promise<void>>();
  const unavailable = new Set<string>();
  const documents = new Map<string, string>(); // id -> palette-neutral document
  const placeholders = new Set<string>(); // ids holding PLACEHOLDER_PIXEL, not artwork
  let colors: Partial<IconRoleColors> = options.iconColors ?? {};

  // hasImage re-check: a non-diff setStyle mid-load can drop every
  // registered image without telling this Set, and removeImage errors on an
  // id it doesn't hold.
  function dropPlaceholder(id: string): void {
    if (placeholders.delete(id) && map.hasImage(id)) map.removeImage(id);
  }

  /** Substitute + size + decode one cached document under the CURRENT table. */
  async function paint(id: string): Promise<{ image: unknown; pixelRatio: number } | undefined> {
    const doc = documents.get(id);
    if (doc === undefined) return undefined;
    const plan = atonIconRaster(substituteIconRoles(doc, colors), dpr, ATON_ICON_SCALE);
    if (!plan) return undefined;
    return { image: await decode(plan.svg, plan.width, plan.height), pixelRatio: plan.pixelRatio };
  }

  /** One GET, or `undefined` for any non-OK answer. */
  async function fetchDocument(id: string): Promise<string | undefined> {
    const res = await fetchImpl(atonIconUrl(id));
    return res.ok ? await res.text() : undefined;
  }

  async function load(id: string): Promise<void> {
    let doc = await fetchDocument(id);
    // Tried after the real request, not instead of it, so the alias
    // disappears on its own once real artwork lands (see NO_ARTWORK_SYMBOLS).
    if (doc === undefined && NO_ARTWORK_SYMBOLS.has(id)) {
      doc = documents.get(PLACEHOLDER_ALIAS) ?? (await fetchDocument(PLACEHOLDER_ALIAS));
    }
    if (doc === undefined) {
      unavailable.add(id);
      dropPlaceholder(id);
      return;
    }
    documents.set(id, doc);
    const painted = await paint(id);
    if (!painted) {
      documents.delete(id);
      unavailable.add(id);
      dropPlaceholder(id);
      return;
    }
    dropPlaceholder(id);
    // Re-check: another path may have registered it while this was in
    // flight, and addImage throws on a duplicate.
    if (!map.hasImage(id)) map.addImage(id, painted.image, { pixelRatio: painted.pixelRatio });
  }

  function ensure(id: string): void {
    if (!isAtonIconCandidate(id) || unavailable.has(id) || inFlight.has(id)) return;
    if (map.hasImage(id)) return;
    // Synchronous, before any await: MapLibre re-reads the image the
    // instant this handler returns (see PLACEHOLDER_PIXEL).
    map.addImage(id, PLACEHOLDER_PIXEL());
    placeholders.add(id);
    const pending = load(id)
      .catch(() => {
        unavailable.add(id);
        dropPlaceholder(id);
      })
      .finally(() => {
        inFlight.delete(id);
      });
    inFlight.set(id, pending);
  }

  map.on("styleimagemissing", (e) => ensure(e.id));

  return {
    async refresh(next: Partial<IconRoleColors>): Promise<void> {
      if (sameColors(colors, next)) return;
      colors = next;
      const ids = [...documents.keys()];
      await Promise.all(
        ids.map(async (id) => {
          if (!map.hasImage(id)) return;
          // Skip a document still showing its placeholder: updateImage would
          // reject the dimension change, and the in-flight load already
          // reads the new table.
          if (placeholders.has(id)) return;
          try {
            const painted = await paint(id);
            if (painted) map.updateImage(id, painted.image);
          } catch {
            // Leave the previous palette's image in place rather than let
            // the exception escape into a reactive effect.
          }
        }),
      );
    },
  };
}

function sameColors(a: Partial<IconRoleColors>, b: Partial<IconRoleColors>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k as IconRole] === b[k as IconRole]);
}

/** Decode a sized SVG document to an `ImageBitmap`. Size is written into the
 * document itself rather than relied on from `<img>` width/height, since
 * that behaviour differs across engines for a document with no intrinsic
 * size. `ImageBitmap` (not `HTMLImageElement`) because MapLibre uploads it
 * to the GPU directly. */
async function decodeSvgImage(svg: string, width: number, height: number): Promise<ImageBitmap> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image(width, height);
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("svg decode failed"));
      img.src = url;
    });
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}
