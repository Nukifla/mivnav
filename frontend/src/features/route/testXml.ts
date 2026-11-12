// TEST-ONLY: a minimal, strict XML parser standing in for the browser's
// `DOMParser` (bun's test runtime has no DOM). Produces ./gpx.ts's
// `XmlElement` shape — `localName` without the prefix, `textContent` as the
// concatenated descendant text — and returns null for anything not
// well-formed (mismatched/unclosed tags, junk after the root, bad entity),
// as `DOMParser` reports a `<parsererror>`. Not imported by app code.

import type { XmlElement, XmlParse } from "./gpx";

class El implements XmlElement {
  children: El[] = [];
  private parts: (string | El)[] = [];
  constructor(
    readonly name: string,
    private attrs: Map<string, string>,
  ) {}
  get localName(): string {
    const i = this.name.indexOf(":");
    return i >= 0 ? this.name.slice(i + 1) : this.name;
  }
  get textContent(): string {
    return this.parts.map((p) => (typeof p === "string" ? p : p.textContent)).join("");
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  addText(t: string) {
    this.parts.push(t);
  }
  addChild(c: El) {
    this.children.push(c);
    this.parts.push(c);
  }
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&([^;&\s]*);|&/g, (m, e: string | undefined) => {
    if (e === undefined) throw new Error("bare &");
    if (e in ENT) return ENT[e]!;
    if (/^#x[0-9a-f]+$/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (/^#[0-9]+$/.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 10));
    throw new Error(`unknown entity ${m}`);
  });
}

const NAME = /^[A-Za-z_][\w.:-]*/;

export const testXmlParse: XmlParse = (text) => {
  try {
    let i = 0;
    let root: El | null = null;
    const stack: El[] = [];
    const s = text.replace(/^﻿/, "");
    while (i < s.length) {
      if (s.startsWith("<?", i)) {
        const end = s.indexOf("?>", i);
        if (end < 0) return null;
        i = end + 2;
      } else if (s.startsWith("<!--", i)) {
        const end = s.indexOf("-->", i);
        if (end < 0) return null;
        i = end + 3;
      } else if (s.startsWith("<![CDATA[", i)) {
        const end = s.indexOf("]]>", i);
        if (end < 0 || stack.length === 0) return null;
        stack[stack.length - 1]!.addText(s.slice(i + 9, end));
        i = end + 3;
      } else if (s.startsWith("<!", i)) {
        const end = s.indexOf(">", i);
        if (end < 0) return null;
        i = end + 1;
      } else if (s.startsWith("</", i)) {
        const m = NAME.exec(s.slice(i + 2));
        if (!m) return null;
        const top = stack.pop();
        if (!top || top.name !== m[0]) return null;
        i += 2 + m[0].length;
        while (/\s/.test(s[i] ?? "")) i++;
        if (s[i] !== ">") return null;
        i++;
      } else if (s[i] === "<") {
        const m = NAME.exec(s.slice(i + 1));
        if (!m) return null;
        i += 1 + m[0].length;
        const attrs = new Map<string, string>();
        for (;;) {
          while (/\s/.test(s[i] ?? "")) i++;
          if (s.startsWith("/>", i) || s[i] === ">") break;
          const a = NAME.exec(s.slice(i));
          if (!a) return null;
          i += a[0].length;
          while (/\s/.test(s[i] ?? "")) i++;
          if (s[i] !== "=") return null;
          i++;
          while (/\s/.test(s[i] ?? "")) i++;
          const q = s[i];
          if (q !== '"' && q !== "'") return null;
          const end = s.indexOf(q, i + 1);
          if (end < 0) return null;
          if (attrs.has(a[0])) return null;
          attrs.set(a[0], decode(s.slice(i + 1, end)));
          i = end + 1;
        }
        const el = new El(m[0], attrs);
        if (stack.length > 0) stack[stack.length - 1]!.addChild(el);
        else if (root) return null; // a second root
        else root = el;
        if (s.startsWith("/>", i)) i += 2;
        else {
          i += 1;
          stack.push(el);
        }
      } else {
        const end = s.indexOf("<", i);
        const raw = s.slice(i, end < 0 ? s.length : end);
        if (stack.length === 0) {
          if (raw.trim() !== "") return null; // text outside the root
        } else stack[stack.length - 1]!.addText(decode(raw));
        i = end < 0 ? s.length : end;
      }
    }
    if (stack.length > 0) return null;
    return root;
  } catch {
    return null;
  }
};
