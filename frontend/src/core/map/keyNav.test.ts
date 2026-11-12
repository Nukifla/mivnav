// Keyboard chart navigation (docs/architecture/map-key-nav.md): "the arrow
// keys should move us around the map" — app-wide, but never at the expense of
// a text field, a control that uses the arrows itself, or a modal.

import { describe, expect, test } from "bun:test";
import {
  KEY_PAN_MAX_FRAME_MS,
  KEY_PAN_SPEED,
  KEY_PAN_STEP,
  chartKeyOf,
  createChartKeyNav,
  createKeyPan,
  freeChartKey,
  ownsChartKeys,
  type ChartKeyEvent,
  type FrameEnv,
  type KeyTargetElement,
} from "./keyNav";

/** A keydown stub that records `preventDefault`. */
function key(k: string, over: Partial<ChartKeyEvent> = {}) {
  const e = {
    key: k,
    defaultPrevented: false,
    target: el("BODY") as unknown as EventTarget,
    preventDefault() {
      e.defaultPrevented = true;
    },
    ...over,
  };
  return e;
}

/** A structural DOM element: tag, attributes, parent. */
function el(
  tagName: string,
  attrs: Record<string, string> = {},
  parent: KeyTargetElement | null = null,
  extra: Partial<KeyTargetElement> = {},
): KeyTargetElement {
  return { tagName, getAttribute: (n) => attrs[n] ?? null, parentElement: parent, ...extra };
}
const body = el("BODY");
const at = (e: KeyTargetElement) => e as unknown as EventTarget;
const FREE = { modalOpen: false };

/** A hand-cranked frame clock: `step(ms)` advances time and runs the frame. */
function frames() {
  let t = 0;
  let pending: (() => void) | undefined;
  let id = 0;
  const env: FrameEnv = {
    now: () => t,
    requestFrame: (fn) => {
      pending = fn;
      return ++id;
    },
    cancelFrame: () => {
      pending = undefined;
    },
  };
  return {
    env,
    step(ms = 16) {
      t += ms;
      const fn = pending;
      pending = undefined;
      fn?.();
    },
    run(ms: number, each = 16) {
      for (let done = 0; done < ms; done += each) this.step(each);
    },
    scheduled: () => pending !== undefined,
  };
}

function tracker() {
  const moves: [number, number][] = [];
  const total = () => moves.reduce<[number, number]>((a, m) => [a[0] + m[0], a[1] + m[1]], [0, 0]);
  return { moves, total, move: (dx: number, dy: number) => void moves.push([dx, dy]) };
}

describe("chartKeyOf — what a key spells", () => {
  test("arrows pan, + / = zoom in, - zooms out", () => {
    expect(chartKeyOf(key("ArrowLeft"))).toEqual({ kind: "pan", key: "ArrowLeft" });
    expect(chartKeyOf(key("ArrowDown"))).toEqual({ kind: "pan", key: "ArrowDown" });
    expect(chartKeyOf(key("+", { shiftKey: true }))).toEqual({ kind: "zoom", delta: 1 });
    expect(chartKeyOf(key("="))).toEqual({ kind: "zoom", delta: 1 });
    expect(chartKeyOf(key("-"))).toEqual({ kind: "zoom", delta: -1 });
  });

  test("a chord belongs to the browser / OS (Alt-Left is Back, Cmd-Plus is page zoom)", () => {
    expect(chartKeyOf(key("ArrowLeft", { altKey: true }))).toBeNull();
    expect(chartKeyOf(key("ArrowUp", { metaKey: true }))).toBeNull();
    expect(chartKeyOf(key("+", { ctrlKey: true }))).toBeNull();
    expect(chartKeyOf(key("-", { metaKey: true }))).toBeNull();
  });

  test("Shift-arrow is nothing: MapLibre's rotate/pitch, and the chart is north-up and flat", () => {
    expect(chartKeyOf(key("ArrowRight", { shiftKey: true }))).toBeNull();
  });

  test("other keys are not chart keys", () => {
    for (const k of ["a", "Enter", " ", "Escape", "PageDown", "Home", "Tab"]) expect(chartKeyOf(key(k))).toBeNull();
  });
});

describe("ownsChartKeys — the focused control keeps its own arrows", () => {
  test("body, the map canvas and a plain button own nothing", () => {
    expect(ownsChartKeys(at(body))).toBe(false);
    expect(ownsChartKeys(null)).toBe(false);
    const map = el("DIV", { role: "region" }, body);
    expect(ownsChartKeys(at(el("CANVAS", {}, el("DIV", {}, map))))).toBe(false);
    expect(ownsChartKeys(at(el("BUTTON", { "aria-pressed": "true" }, el("DIV", {}, body))))).toBe(false);
    expect(ownsChartKeys(at(el("A", {}, body)))).toBe(false);
  });

  test("typing: input, textarea, select, contenteditable — also when the key lands on a child", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) expect(ownsChartKeys(at(el(tag, {}, body)))).toBe(true);
    const editable = el("DIV", {}, body, { isContentEditable: true });
    expect(ownsChartKeys(at(editable))).toBe(true);
    expect(ownsChartKeys(at(el("SPAN", {}, editable)))).toBe(true);
  });

  test("ARIA widgets that navigate with arrows, on the element or an ancestor", () => {
    for (const role of ["slider", "listbox", "option", "menu", "menuitem", "tab", "tablist", "radio", "radiogroup", "combobox", "spinbutton", "tree", "grid", "toolbar"]) {
      expect(ownsChartKeys(at(el("DIV", { role }, body)))).toBe(true);
    }
    // A Kobalte tab trigger is a <button role="tab"> inside the tablist.
    const tablist = el("DIV", { role: "tablist" }, body);
    expect(ownsChartKeys(at(el("BUTTON", {}, tablist)))).toBe(true);
    // The slider thumb inside the weather ruler.
    expect(ownsChartKeys(at(el("SPAN", {}, el("DIV", { role: "slider" }, body))))).toBe(true);
  });

  test("a trigger that opens a list or menu on ArrowDown (aria-haspopup)", () => {
    expect(ownsChartKeys(at(el("BUTTON", { "aria-haspopup": "listbox" }, body)))).toBe(true);
    expect(ownsChartKeys(at(el("BUTTON", { "aria-haspopup": "menu" }, body)))).toBe(true);
    expect(ownsChartKeys(at(el("BUTTON", { "aria-haspopup": "false" }, body)))).toBe(false);
  });

  test("roles with no arrow behaviour do not block (dialog, group, region, status)", () => {
    for (const role of ["dialog", "group", "region", "status", "button"]) {
      expect(ownsChartKeys(at(el("BUTTON", {}, el("DIV", { role }, body))))).toBe(false);
    }
  });

  test("focus inside a scrolling panel: the arrows scroll it", () => {
    const panel = el("DIV", { "data-scroller": "1" }, body);
    const button = el("BUTTON", {}, el("DIV", {}, panel));
    const scrolls = (e: KeyTargetElement) => e.getAttribute?.("data-scroller") === "1";
    expect(ownsChartKeys(at(button), scrolls)).toBe(true);
    expect(ownsChartKeys(at(button), () => false)).toBe(false);
    // <body>/<html> are never asked — the app shell does not scroll.
    expect(ownsChartKeys(at(body), () => true)).toBe(false);
  });
});

describe("freeChartKey — the routing decision", () => {
  test("a plain arrow with focus on the page pans", () => {
    expect(freeChartKey(key("ArrowUp"), FREE)).toEqual({ kind: "pan", key: "ArrowUp" });
  });

  test("already claimed (Kobalte slider/menu/tabs, palette list, lightbox): not ours", () => {
    expect(freeChartKey(key("ArrowUp", { defaultPrevented: true }), FREE)).toBeNull();
  });

  test("an IME composing keeps its arrows", () => {
    expect(freeChartKey(key("ArrowLeft", { isComposing: true }), FREE)).toBeNull();
    expect(freeChartKey(key("ArrowLeft", { keyCode: 229 }), FREE)).toBeNull();
  });

  test("a modal surface open blocks every chart key, wherever focus is", () => {
    expect(freeChartKey(key("ArrowUp"), { modalOpen: true })).toBeNull();
    expect(freeChartKey(key("+"), { modalOpen: true })).toBeNull();
  });

  test("typing '-' or moving the caret in a field is text, not the chart", () => {
    const input = at(el("INPUT", {}, body));
    expect(freeChartKey(key("-", { target: input }), FREE)).toBeNull();
    expect(freeChartKey(key("ArrowLeft", { target: input }), FREE)).toBeNull();
  });

  test("a slider that forgot preventDefault still keeps its arrows (the weather ruler)", () => {
    const slider = at(el("DIV", { role: "slider" }, body));
    expect(freeChartKey(key("ArrowRight", { target: slider }), FREE)).toBeNull();
  });

  test("auto-repeat is still a chart key (holding pans on)", () => {
    expect(freeChartKey(key("ArrowUp", { repeat: true }), FREE)).not.toBeNull();
  });
});

describe("createKeyPan — held keys to per-frame deltas", () => {
  test("a held arrow moves every frame at the pan speed, in its direction", () => {
    const f = frames();
    const t = tracker();
    const pan = createKeyPan(t.move, f.env);
    pan.press("ArrowRight");
    f.run(1008); // 63 frames of 16 ms
    const [dx, dy] = t.total();
    expect(dx).toBeCloseTo((KEY_PAN_SPEED * 1008) / 1000, 5);
    expect(dy).toBe(0);
    expect(t.moves.length).toBe(63); // one move per frame: smooth, not stepped
    pan.release("ArrowRight");
    f.run(200);
    expect(t.total()[0]).toBeCloseTo(dx, 5); // stops on release
    expect(f.scheduled()).toBe(false); // and the loop ends
  });

  test("a quick tap still moves the minimum step, then stops", () => {
    const f = frames();
    const t = tracker();
    const pan = createKeyPan(t.move, f.env);
    pan.press("ArrowUp");
    f.step(16);
    pan.release("ArrowUp"); // lifted long before the step is done
    f.run(1000);
    expect(t.total()[0]).toBe(0);
    expect(t.total()[1]).toBeCloseTo(-KEY_PAN_STEP, 5);
    expect(pan.active()).toBe(false);
  });

  test("three quick taps are three steps, even when they overlap", () => {
    const f = frames();
    const t = tracker();
    const pan = createKeyPan(t.move, f.env);
    for (let i = 0; i < 3; i++) {
      pan.press("ArrowRight");
      pan.release("ArrowRight");
      f.step(16); // the next tap lands long before the last step is done
    }
    f.run(2000);
    expect(t.total()[0]).toBeCloseTo(3 * KEY_PAN_STEP, 5);
  });

  test("two arrows held pan diagonally; opposite arrows cancel", () => {
    const f = frames();
    const t = tracker();
    const pan = createKeyPan(t.move, f.env);
    pan.press("ArrowRight");
    pan.press("ArrowDown");
    f.run(320);
    const [dx, dy] = t.total();
    expect(dx).toBeGreaterThan(KEY_PAN_STEP);
    expect(dy).toBeCloseTo(dx, 5);
    pan.stop();

    const u = tracker();
    const both = createKeyPan(u.move, f.env);
    both.press("ArrowLeft");
    both.press("ArrowRight");
    f.run(320);
    expect(u.moves).toEqual([]);
  });

  test("auto-repeat keydowns do not restart or stack the pan", () => {
    const f = frames();
    const a = tracker();
    const once = createKeyPan(a.move, f.env);
    once.press("ArrowLeft");
    f.run(480);
    once.stop();

    const b = tracker();
    const repeated = createKeyPan(b.move, f.env);
    repeated.press("ArrowLeft");
    for (let i = 0; i < 30; i++) {
      f.step(16);
      repeated.press("ArrowLeft");
    }
    expect(b.total()[0]).toBeCloseTo(a.total()[0], 5);
  });

  test("a stalled frame is clamped — no giant jump after a hitch", () => {
    const f = frames();
    const t = tracker();
    const pan = createKeyPan(t.move, f.env);
    pan.press("ArrowRight");
    f.step(5000);
    expect(t.total()[0]).toBeCloseTo((KEY_PAN_SPEED * KEY_PAN_MAX_FRAME_MS) / 1000, 5);
  });

  test("stop() ends it dead, unfinished step included (blur: the keyup never comes)", () => {
    const f = frames();
    const t = tracker();
    const pan = createKeyPan(t.move, f.env);
    pan.press("ArrowRight");
    f.step(16);
    pan.stop();
    const moved = t.total()[0];
    f.run(500);
    expect(t.total()[0]).toBe(moved);
    expect(pan.active()).toBe(false);
  });
});

describe("createChartKeyNav — what App's keydown listener calls", () => {
  function nav() {
    const f = frames();
    const pans: [number, number][] = [];
    const zooms: number[] = [];
    const n = createChartKeyNav(f.env);
    const unbind = n.bind({ panBy: (dx, dy) => void pans.push([dx, dy]), zoomBy: (d) => void zooms.push(d) });
    return { f, pans, zooms, n, unbind };
  }

  test("a free arrow is claimed and pans the bound map", () => {
    const { f, pans, n } = nav();
    const e = key("ArrowRight");
    expect(n.keydown(e, FREE)).toBe(true);
    expect(e.defaultPrevented).toBe(true); // the page must not scroll too
    f.run(160);
    expect(pans.length).toBe(10);
    expect(pans.every(([dx, dy]) => dx > 0 && dy === 0)).toBe(true);
    n.keyup({ key: "ArrowRight" });
  });

  test("+ and - zoom one step each, repeat included", () => {
    const { zooms, n } = nav();
    n.keydown(key("+", { shiftKey: true }), FREE);
    n.keydown(key("="), FREE);
    n.keydown(key("-", { repeat: true }), FREE);
    expect(zooms).toEqual([1, 1, -1]);
  });

  test("not free: nothing moves and the event is left untouched for its owner", () => {
    const { f, pans, zooms, n } = nav();
    const cases = [
      key("ArrowUp", { target: at(el("INPUT", {}, body)) }),
      key("ArrowUp", { target: at(el("TEXTAREA", {}, body)) }),
      key("ArrowUp", { target: at(el("DIV", {}, body, { isContentEditable: true })) }),
      key("ArrowUp", { target: at(el("SELECT", {}, body)) }),
      key("ArrowUp", { target: at(el("SPAN", { role: "slider" }, body)) }),
      key("ArrowDown", { target: at(el("LI", { role: "option" }, el("UL", { role: "listbox" }, body))) }),
      key("ArrowDown", { target: at(el("DIV", { role: "menuitem" }, body)) }),
      key("ArrowRight", { target: at(el("BUTTON", { role: "tab" }, body)) }),
      key("ArrowDown", { target: at(el("BUTTON", { role: "radio" }, body)) }),
      key("ArrowUp", { altKey: true }),
      key("ArrowUp", { ctrlKey: true }),
      key("ArrowUp", { shiftKey: true }),
      key("-", { target: at(el("INPUT", {}, body)) }),
    ];
    for (const e of cases) {
      expect(n.keydown(e, FREE)).toBe(false);
      expect(e.defaultPrevented).toBe(false);
    }
    const claimed = key("ArrowUp", { defaultPrevented: true });
    expect(n.keydown(claimed, FREE)).toBe(false);
    expect(n.keydown(key("ArrowUp"), { modalOpen: true })).toBe(false);
    f.run(300);
    expect(pans).toEqual([]);
    expect(zooms).toEqual([]);
  });

  test("keyup always releases — also when focus has moved into a field meanwhile", () => {
    const { f, pans, n } = nav();
    n.keydown(key("ArrowLeft"), FREE);
    f.run(480); // well past the minimum step
    n.keyup({ key: "ArrowLeft" });
    const count = pans.length;
    f.run(300);
    expect(pans.length).toBe(count);
    expect(n.panning()).toBe(false);
  });

  test("a chord starting mid-hold stops the pan (macOS drops the keyup under Cmd)", () => {
    const { f, pans, n } = nav();
    n.keydown(key("ArrowLeft"), FREE);
    f.run(160);
    n.keydown(key("Tab", { metaKey: true }), FREE);
    const count = pans.length;
    f.run(500);
    expect(pans.length).toBe(count);
  });

  test("window blur stops the pan", () => {
    const { f, pans, n } = nav();
    n.keydown(key("ArrowDown"), FREE);
    f.run(160);
    n.release();
    const count = pans.length;
    f.run(500);
    expect(pans.length).toBe(count);
  });

  test("with no map bound a key is not handled and not claimed; unbind stops a pan", () => {
    const f = frames();
    const n = createChartKeyNav(f.env);
    const e = key("ArrowUp");
    expect(n.keydown(e, FREE)).toBe(false);
    expect(e.defaultPrevented).toBe(false);

    const pans: number[] = [];
    const unbind = n.bind({ panBy: (dx) => void pans.push(dx), zoomBy: () => {} });
    n.keydown(key("ArrowRight"), FREE);
    f.run(64);
    unbind();
    const count = pans.length;
    f.run(300);
    expect(pans.length).toBe(count);
    expect(n.keydown(key("ArrowRight"), FREE)).toBe(false);
  });
});
