// The notice-HTML parser: only the backend's allow-list survives, as a tree
// (never a string handed to innerHTML), text decoded, script content gone.

import { describe, expect, test } from "bun:test";
import { htmlText, parseNoticeHtml, type HtmlElement } from "./html";
import DETAIL from "./fixtures/detail.json";

const el = (n: unknown) => n as HtmlElement;

describe("parseNoticeHtml", () => {
  test("keeps allow-listed structure and decodes entities", () => {
    const nodes = parseNoticeHtml("<p><strong>Indtil videre</strong> etableres&nbsp;en tunnel &amp; mere</p>");
    expect(nodes).toHaveLength(1);
    expect(el(nodes[0]).tag).toBe("p");
    expect(el(el(nodes[0]).children[0]).tag).toBe("strong");
    expect(htmlText(nodes)).toBe("Indtil videre etableres en tunnel & mere");
  });

  test("drops unknown tags (keeping their text) and script/style content", () => {
    const nodes = parseNoticeHtml('<div onclick="x()">a<span>b</span></div><script>alert(1)</script><style>p{}</style>c');
    expect(htmlText(nodes)).toBe("abc");
    expect(nodes.every((n) => typeof n === "string")).toBe(true);
  });

  test("attributes: only safe hrefs and spans survive", () => {
    const [a, bad, td] = parseNoticeHtml(
      '<a href="https://dma.dk/x" onclick="evil()" style="x">ok</a><a href="javascript:alert(1)">no</a><table><tr><td colspan="2" class="z">c</td></tr></table>',
    ).filter((n) => typeof n !== "string") as HtmlElement[];
    expect(a.attrs).toEqual({ href: "https://dma.dk/x" });
    expect(bad.attrs).toEqual({});
    const cell = el(el(td.children[0]).children[0]);
    expect(cell.tag).toBe("td");
    expect(cell.attrs).toEqual({ colspan: "2" });
  });

  test("unclosed elements close at the end; stray closers are ignored", () => {
    const nodes = parseNoticeHtml("<ul><li>one<li>two</ul></b>tail");
    expect(htmlText(nodes)).toBe("onetwotail");
    expect(el(nodes[0]).tag).toBe("ul");
  });

  test("the real fixture's position table parses into rows", () => {
    const nodes = parseNoticeHtml(DETAIL.parts[0].details.da);
    const table = nodes.find((n) => typeof n !== "string" && n.tag === "table") as HtmlElement;
    const tbody = el(table.children[0]);
    expect(tbody.tag).toBe("tbody");
    expect(tbody.children).toHaveLength(4);
    // Inter-block whitespace dropped: every child of the body is a row.
    expect(tbody.children.every((r) => typeof r !== "string" && r.tag === "tr")).toBe(true);
  });

  test("null / empty input is no nodes", () => {
    expect(parseNoticeHtml(null)).toEqual([]);
    expect(parseNoticeHtml("")).toEqual([]);
  });
});

describe("glueCoordinates", () => {
  test("degree and minutes stay together; the halves may still break", () => {
    expect(htmlText(parseNoticeHtml("<td>54° 38,433'N - 011° 22,183'E</td>"))).toBe(
      "54°\u00a038,433'N\u00a0- 011°\u00a022,183'E",
    );
  });
});
