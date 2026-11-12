// Notice text (Niord's part details / publication) arrives as HTML that the
// backend has ALREADY sanitised with an nh3 allow-list
// (backend/mivnav/features/notices/sanitize.py). The panel still never hands
// it to `innerHTML`: this parses it into a plain tree over the SAME allow-list
// — anything else is dropped (its text kept), attributes other than the few
// listed are dropped, `a[href]` only for http(s)/mailto — and ./NoticeHtml.tsx
// builds DOM nodes from that tree with text as text nodes. Belt and braces:
// a backend regression can at worst produce odd formatting, never script.
//
// Pure (no DOM), so it is unit-testable under bun.

import { decodeEntities } from "../../core/htmlEntities";

export const HTML_TAGS = [
  "p",
  "br",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "strong",
  "b",
  "em",
  "i",
  "a",
] as const;
export type HtmlTag = (typeof HTML_TAGS)[number];
const ALLOWED = new Set<string>(HTML_TAGS);
const VOID = new Set(["br"]);
/** Dropped WITH their content (nh3 does the same). */
const DROP_CONTENT = new Set(["script", "style", "template", "iframe", "object", "noscript", "svg", "math"]);

export interface HtmlElement {
  tag: HtmlTag;
  /** Only `href` (a), `colspan`/`rowspan` (td/th). */
  attrs: Record<string, string>;
  children: HtmlNode[];
}
export type HtmlNode = string | HtmlElement;

const SAFE_HREF = /^(https?:|mailto:)/i;

function parseAttrs(tag: HtmlTag, raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of raw.matchAll(re)) {
    const name = m[1].toLowerCase();
    const value = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (tag === "a" && name === "href" && SAFE_HREF.test(value)) out.href = value;
    if ((tag === "td" || tag === "th") && (name === "colspan" || name === "rowspan") && /^\d{1,2}$/.test(value)) {
      out[name] = value;
    }
  }
  return out;
}

/** Parse sanitised notice HTML into a tree of allow-listed elements and
 * decoded text. Unclosed elements close at their parent's end; a stray close
 * tag is ignored. Whitespace-only text between block elements is dropped. */
export function parseNoticeHtml(html: string | null | undefined): HtmlNode[] {
  const root: HtmlElement = { tag: "p", attrs: {}, children: [] };
  const stack: HtmlElement[] = [root];
  const top = () => stack[stack.length - 1];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const src = html ?? "";
  let last = 0;
  let dropping: string | null = null;
  const text = (s: string) => {
    if (dropping || !s) return;
    const t = glueCoordinates(decodeEntities(s));
    if (t) top().children.push(t);
  };
  for (const m of src.matchAll(re)) {
    text(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[0].startsWith("<!--")) continue;
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    if (dropping) {
      if (closing && name === dropping) dropping = null;
      continue;
    }
    if (DROP_CONTENT.has(name)) {
      if (!closing && !m[3].trim().endsWith("/")) dropping = name;
      continue;
    }
    if (!ALLOWED.has(name)) continue; // unknown tag: dropped, its text kept
    const tag = name as HtmlTag;
    if (closing) {
      const at = stack.map((e) => e.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const el: HtmlElement = { tag, attrs: parseAttrs(tag, m[3]), children: [] };
    top().children.push(el);
    if (!VOID.has(tag)) stack.push(el);
  }
  text(src.slice(last));
  return trimBlocks(root.children);
}

/** "54° 38,433'N - 011° 22,183'E" may break only around the " - ": the
 * spaces inside each half (after the degree sign) and before the dash become
 * no-break spaces, so a narrow panel shows "54° 38,433'N -" over the
 * longitude, never "54°" or "-" alone. */
export function glueCoordinates(s: string): string {
  return s.replace(/(\d°) +(?=\d)/g, "$1\u00a0").replace(/([NS]) +- +(?=\d)/g, "$1\u00a0- ");
}

const BLOCK = new Set<string>(["p", "ul", "ol", "li", "table", "thead", "tbody", "tr", "td", "th"]);
const isBlock = (n: HtmlNode | undefined) => typeof n !== "string" && n !== undefined && BLOCK.has(n.tag);

/** Drop whitespace-only text that only separates block elements (the "\n"
 * between `</p>` and `<table>`), recursively; inline whitespace stays. */
function trimBlocks(nodes: HtmlNode[]): HtmlNode[] {
  const out: HtmlNode[] = [];
  nodes.forEach((n, i) => {
    if (typeof n === "string") {
      if (/^\s*$/.test(n) && (i === 0 || i === nodes.length - 1 || isBlock(nodes[i - 1]) || isBlock(nodes[i + 1]))) {
        return;
      }
      out.push(n);
    } else {
      out.push({ ...n, children: trimBlocks(n.children) });
    }
  });
  return out;
}

/** The text of a tree, for tests and for an accessible fallback. */
export function htmlText(nodes: readonly HtmlNode[]): string {
  return nodes.map((n) => (typeof n === "string" ? n : htmlText(n.children))).join("");
}
