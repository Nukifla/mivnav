// The pure decision behind "Go here"'s confirm-before-replace: whether the first
// tap arms or acts. The button's wiring is in HitCarousel.tsx; the RULE is this
// gate, tested here without the DOM.
//
// Also `createNoteState` (#87-fork): the reactive state behind a NoteBlock's
// TXTDSC/NTXTDS toggle, pulled out of the JSX specifically so its "each side
// loads at most once, however often the language is flipped" contract is
// checkable here rather than only by eyeballing the component. Driven the same
// way ./detail.test.ts drives `createHitDetail` — a `createRoot` harness plus a
// `settled()` microtask flush, since createResource's fetch is a promise.
//
// NB: needs `--conditions=browser` (the `test` script) for solid-js's browser
// export, whose createEffect actually runs — see ./detail.test.ts.

import { describe, expect, test } from "bun:test";
import { batch, createRoot, createSignal } from "solid-js";
import { copyStatusLabel, createHitNotes, createNoteState, goHereGate, noteError } from "./HitCarousel";
import type { InfoDetail, InfoHit, InfoNote } from "./types";

describe("copyStatusLabel (the copy row's verdict)", () => {
  test("idle says nothing — the row is showing its own value", () => {
    expect(copyStatusLabel("idle")).toBeUndefined();
  });

  test("a failure is WORDED, never a silent no-op", () => {
    // The whole point on a plain-HTTP boat: if both clipboard paths are out,
    // the mariner has to learn it here rather than by pasting a stale position.
    expect(copyStatusLabel("copied")).toBe("Copied");
    expect(copyStatusLabel("failed")).toBe("Copy failed");
  });
});

describe("goHereGate (Go here two-tap arm)", () => {
  test("not following → proceed on the first tap, armed or not", () => {
    expect(goHereGate(false, false)).toBe("proceed");
    expect(goHereGate(false, true)).toBe("proceed");
  });

  test("following → arm on the first tap (nothing armed yet)", () => {
    expect(goHereGate(true, false)).toBe("arm");
  });

  test("following and already armed → proceed on the confirming second tap", () => {
    expect(goHereGate(true, true)).toBe("proceed");
  });
});

const settled = () => new Promise((r) => setTimeout(r, 0));

/** A TXTDSC+NTXTDS note stand-in that counts each side's fetches, so a test
 * can assert "at most once" rather than merely "eventually correct". */
function countingNote(): { note: InfoNote; primaryCalls: () => number; altCalls: () => number } {
  let primaryCalls = 0;
  let altCalls = 0;
  const note: InfoNote = {
    label: "Text description",
    load: () => {
      primaryCalls++;
      return Promise.resolve("international body");
    },
    alt: {
      label: "Text description (national language)",
      load: () => {
        altCalls++;
        return Promise.resolve("national body");
      },
    },
  };
  return { note, primaryCalls: () => primaryCalls, altCalls: () => altCalls };
}

function harness(note: InfoNote) {
  return createRoot((dispose) => ({ state: createNoteState(note), dispose }));
}

describe("createNoteState (#87-fork TXTDSC/NTXTDS toggle)", () => {
  test("defaults to the primary (international) variant, closed, nothing fetched", () => {
    const { note, primaryCalls, altCalls } = countingNote();
    const { state, dispose } = harness(note);
    expect(state.open()).toBe(false);
    expect(state.lang()).toBe("primary");
    expect(state.active().label).toBe("Text description");
    expect(primaryCalls()).toBe(0);
    expect(altCalls()).toBe(0);
    dispose();
  });

  test("opening fetches the primary body once, even across repeated open/close", async () => {
    const { note, primaryCalls } = countingNote();
    const { state, dispose } = harness(note);

    state.toggleOpen(); // open
    await settled();
    expect(state.active().body()).toBe("international body");
    expect(primaryCalls()).toBe(1);

    state.toggleOpen(); // close
    state.toggleOpen(); // reopen
    await settled();
    expect(state.active().body()).toBe("international body");
    expect(primaryCalls()).toBe(1); // latched — no re-fetch
    dispose();
  });

  test("toggling language while open fetches the other side independently, and reuses it on the way back", async () => {
    const { note, primaryCalls, altCalls } = countingNote();
    const { state, dispose } = harness(note);
    state.toggleOpen();
    await settled();
    expect(primaryCalls()).toBe(1);

    state.toggleLang(); // → alt (national)
    await settled();
    expect(state.lang()).toBe("alt");
    expect(state.active().label).toBe("Text description (national language)");
    expect(state.active().body()).toBe("national body");
    expect(altCalls()).toBe(1);
    expect(primaryCalls()).toBe(1); // untouched by the switch

    state.toggleLang(); // → back to primary
    await settled();
    expect(state.lang()).toBe("primary");
    expect(state.active().body()).toBe("international body");
    expect(primaryCalls()).toBe(1); // still just the one fetch, reused
    expect(altCalls()).toBe(1); // ditto for the national side
    dispose();
  });

  test("toggling language while closed marks the preference but fetches nothing until opened", async () => {
    const { note, primaryCalls, altCalls } = countingNote();
    const { state, dispose } = harness(note);

    state.toggleLang(); // → alt, but the note is still collapsed
    await settled();
    expect(state.lang()).toBe("alt");
    expect(primaryCalls()).toBe(0);
    expect(altCalls()).toBe(0);

    state.toggleOpen(); // now open, wants whatever `lang` currently is (alt)
    await settled();
    expect(state.active().body()).toBe("national body");
    expect(altCalls()).toBe(1);
    expect(primaryCalls()).toBe(0); // international was never requested
    dispose();
  });

  test("a note with no `alt` (NTXTDS-only, or TXTDSC-only) never resolves to a second variant", async () => {
    let calls = 0;
    const note: InfoNote = {
      label: "Text description (national language)",
      load: () => {
        calls++;
        return Promise.resolve("only body");
      },
    };
    const { state, dispose } = harness(note);
    state.toggleOpen();
    state.toggleLang(); // no-op on `active()` — there is nothing to switch to
    await settled();
    expect(state.active().label).toBe("Text description (national language)");
    expect(state.active().body()).toBe("only body");
    expect(calls).toBe(1);
    dispose();
  });
});

describe("noteError (what a failed note says on screen)", () => {
  test("a provider's own prose is shown verbatim", () => {
    expect(noteError(new Error("This chart set doesn’t include the note DKNO7001.TXT."))).toBe(
      "This chart set doesn’t include the note DKNO7001.TXT.",
    );
  });

  test("a rejection with nothing useful falls back to the generic line", () => {
    expect(noteError(new Error("   "))).toBe("Couldn’t load this note.");
    expect(noteError("boom")).toBe("Couldn’t load this note.");
    expect(noteError(undefined)).toBe("Couldn’t load this note.");
  });
});

describe("createNoteState — a structured (component) body", () => {
  test("a load resolving to a Component keeps the component itself (not called as a signal updater)", async () => {
    let rendered = 0;
    const Body = () => {
      rendered++;
      return null;
    };
    const { state, dispose } = harness({ label: "Place details", load: () => Promise.resolve(Body) });
    state.toggleOpen();
    await settled();
    expect(state.active().body()).toBe(Body);
    expect(rendered).toBe(0); // storing it must not invoke it
    dispose();
  });
});

describe("createNoteState — an inline note (display: 'inline')", () => {
  test("is open from the start and loads on creation, with no toggle to reach it", async () => {
    let calls = 0;
    const note: InfoNote = {
      label: "Place details",
      display: "inline",
      load: () => {
        calls++;
        return Promise.resolve("inline body");
      },
    };
    const { state, dispose } = harness(note);
    expect(state.inline).toBe(true);
    expect(state.open()).toBe(true);
    await settled();
    expect(state.active().body()).toBe("inline body");
    expect(calls).toBe(1);
    dispose();
  });

  test("still loads at most once — a stray toggleOpen neither collapses it nor re-fetches", async () => {
    const { note, primaryCalls, altCalls } = countingNote();
    const { state, dispose } = harness({ ...note, display: "inline" });
    await settled();
    state.toggleOpen();
    state.toggleOpen();
    await settled();
    expect(state.open()).toBe(true);
    expect(primaryCalls()).toBe(1);
    // The alt side stays lazy until the language is actually switched.
    expect(altCalls()).toBe(0);
    state.toggleLang();
    await settled();
    expect(state.active().body()).toBe("national body");
    expect(altCalls()).toBe(1);
    dispose();
  });

  test("a failed inline load surfaces the provider's prose (rendered in place of the body)", async () => {
    const { state, dispose } = harness({
      label: "Place details",
      display: "inline",
      load: () => Promise.reject(new Error("No details downloaded for this place.")),
    });
    await settled();
    expect(noteError(state.active().body.error)).toBe("No details downloaded for this place.");
    dispose();
  });

  test("the default (and explicit 'collapsed') is unchanged: closed, nothing fetched", async () => {
    for (const display of [undefined, "collapsed"] as const) {
      const { note, primaryCalls } = countingNote();
      const { state, dispose } = harness({ ...note, display });
      await settled();
      expect(state.inline).toBe(false);
      expect(state.open()).toBe(false);
      expect(primaryCalls()).toBe(0);
      dispose();
    }
  });
});

describe("createHitNotes — a note belongs to its hit", () => {
  // The bug: the desktop panel reuses ONE HitSlide and swaps its hit in place.
  // Its notes were mapped BY POSITION (`Index`), and each block captured its
  // note once, so after tapping B with A open the title said B while the
  // inline note body — slot 0's state, created for A — still showed A.
  const hitOf = (id: string): InfoHit => ({
    providerId: "poi",
    id,
    priority: "regulated",
    precision: "point",
    title: id,
  });
  function world() {
    const calls: string[] = [];
    const noteFor = (id: string): InfoNote => ({
      label: "Place details",
      display: "inline",
      load: () => {
        calls.push(id);
        return Promise.resolve(`body ${id}`);
      },
    });
    // A fresh record (and fresh note objects) on every resolve, as the
    // providers hand out.
    const detailOf = (id: string): InfoDetail => ({ sections: [], notes: [noteFor(id)] });
    const [hit, setHit] = createSignal<InfoHit | undefined>(hitOf("A"));
    const [detail, setDetail] = createSignal<InfoDetail | undefined>(detailOf("A"));
    const { notes, dispose } = createRoot((dispose) => ({ notes: createHitNotes(hit, detail), dispose }));
    const body = () => notes()[0]?.active().body();
    /** What `createHitDetail` does on a swap: the old record is withdrawn at
     * once, the new one lands a moment later. */
    const show = async (id: string) => {
      batch(() => {
        setHit(hitOf(id));
        setDetail(undefined);
      });
      await settled();
      setDetail(detailOf(id));
      await settled();
    };
    return { calls, notes, body, show, setHit, setDetail, detailOf, dispose };
  }

  test("A → B in place: B loads its own note and shows B; back to A shows A, never B", async () => {
    const w = world();
    await settled();
    expect(w.body()).toBe("body A");

    await w.show("B");
    expect(w.calls).toEqual(["A", "B"]);
    expect(w.body()).toBe("body B");

    await w.show("A");
    expect(w.body()).toBe("body A");
    w.dispose();
  });

  test("swapped with NO gap (a record for B arriving in the same beat as the hit) still reloads", async () => {
    const w = world();
    await settled();
    batch(() => {
      w.setHit(hitOf("B"));
      w.setDetail(w.detailOf("B"));
    });
    await settled();
    expect(w.calls).toEqual(["A", "B"]);
    expect(w.body()).toBe("body B");
    w.dispose();
  });

  test("the SAME hit re-resolving (a live tick: new record, new note objects) keeps its state and never reloads", async () => {
    const w = world();
    await settled();
    const before = w.notes()[0];
    for (let i = 0; i < 3; i++) {
      w.setHit(hitOf("A")); // a fresh hit object for the same subject
      w.setDetail(w.detailOf("A"));
      await settled();
    }
    expect(w.notes()[0]).toBe(before);
    expect(w.calls).toEqual(["A"]);
    expect(w.body()).toBe("body A");
    w.dispose();
  });

  test("no record, no notes", async () => {
    const w = world();
    w.setDetail(undefined);
    await settled();
    expect(w.notes()).toEqual([]);
    w.dispose();
  });
});
