import { describe, expect, test } from "bun:test";
import {
  createCommandRegistry,
  defineCommand,
  dispatchKey,
  formatKeybinding,
  groupCommands,
  matchesKeybinding,
  paletteCommands,
  type Command,
  type CommandContext,
  type Keybinding,
} from "./command";

// No DOM under `bun test` (modes.test.ts's note); a KeyboardEvent is stubbed
// with only the fields dispatchKey/matchesKeybinding read, plus a preventDefault
// spy so we can assert the accelerator claimed the key.
function key(k: string, mods: Partial<Record<"mod" | "meta" | "ctrl" | "alt" | "shift", boolean>> = {}) {
  let prevented = false;
  const e = {
    key: k,
    metaKey: !!(mods.mod || mods.meta),
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    preventDefault: () => (prevented = true),
  };
  return { e: e as unknown as KeyboardEvent, prevented: () => prevented };
}

const NOOP_CTX: CommandContext = { close: () => {}, prompt: () => {} };
const GUARD = { typing: false, paletteOpen: false };

describe("defineCommand", () => {
  test("rejects a command with no id / label / group", () => {
    expect(() => defineCommand({ id: "", label: "x", group: "g", run: () => {} })).toThrow();
    expect(() => defineCommand({ id: "x", label: "", group: "g", run: () => {} })).toThrow();
    expect(() => defineCommand({ id: "x", label: "l", group: "", run: () => {} })).toThrow();
  });

  test("rejects a keybinding with no key", () => {
    expect(() =>
      defineCommand({ id: "x", label: "l", group: "g", keybinding: { key: "" }, run: () => {} }),
    ).toThrow();
  });
});

describe("createCommandRegistry", () => {
  const cmd = (id: string, kb?: Keybinding): Command => ({
    id,
    label: id,
    group: "g",
    keybinding: kb,
    run: () => {},
  });

  test("indexes by id", () => {
    const reg = createCommandRegistry([cmd("a"), cmd("b")]);
    expect(reg.byId("b")?.id).toBe("b");
    expect(reg.byId("nope")).toBeUndefined();
  });

  test("throws on a duplicate id", () => {
    expect(() => createCommandRegistry([cmd("a"), cmd("a")])).toThrow(/duplicate command id/);
  });

  test("throws on two commands bound to the same key (an ambiguous accelerator)", () => {
    expect(() =>
      createCommandRegistry([cmd("a", { key: "m" }), cmd("b", { key: "m" })]),
    ).toThrow(/same key/);
  });
});

describe("matchesKeybinding", () => {
  test("a single letter matches case-insensitively, incl. its Shift capital", () => {
    expect(matchesKeybinding({ key: "m" }, key("m").e)).toBe(true);
    expect(matchesKeybinding({ key: "m" }, key("M", { shift: true }).e)).toBe(true);
  });

  test("mod matches Cmd OR Ctrl; bare requires neither", () => {
    expect(matchesKeybinding({ key: "k", mod: true }, key("k", { meta: true }).e)).toBe(true);
    expect(matchesKeybinding({ key: "k", mod: true }, key("k", { ctrl: true }).e)).toBe(true);
    expect(matchesKeybinding({ key: "k", mod: true }, key("k").e)).toBe(false);
    expect(matchesKeybinding({ key: "k" }, key("k", { ctrl: true }).e)).toBe(false);
  });

  test("alt must match; a named key matches exactly", () => {
    expect(matchesKeybinding({ key: "m" }, key("m", { alt: true }).e)).toBe(false);
    expect(matchesKeybinding({ key: "Escape" }, key("Escape").e)).toBe(true);
    expect(matchesKeybinding({ key: "Escape" }, key("Enter").e)).toBe(false);
  });
});

describe("formatKeybinding", () => {
  test("renders the display chip", () => {
    expect(formatKeybinding({ key: "m" })).toBe("M");
    expect(formatKeybinding({ key: "k", mod: true })).toBe("⌘K");
    expect(formatKeybinding({ key: "Escape" })).toBe("Esc");
  });
});

describe("dispatchKey — the ONE key→action site", () => {
  // (a) a declared command with a keybinding fires its run when that key is
  //     pressed, and NOT when a text field is focused.
  test("a keybinding fires its run; a bare key is suppressed while typing", () => {
    let ran = 0;
    const cmds = [
      defineCommand({ id: "measure", label: "Measure", group: "g", keybinding: { key: "m" }, run: () => ran++ }),
    ];
    const hit = key("m");
    expect(dispatchKey(cmds, hit.e, GUARD, NOOP_CTX)?.id).toBe("measure");
    expect(ran).toBe(1);
    expect(hit.prevented()).toBe(true);

    // In a field, the bare key is text, not a shortcut — no fire, no preventDefault.
    const typed = key("m");
    expect(dispatchKey(cmds, typed.e, { typing: true, paletteOpen: false }, NOOP_CTX)).toBeNull();
    expect(ran).toBe(1);
    expect(typed.prevented()).toBe(false);
  });

  test("a modifier CHORD fires even while typing / with the palette open", () => {
    let ran = 0;
    const cmds = [
      defineCommand({ id: "palette", label: "Palette", group: "g", keybinding: { key: "k", mod: true }, run: () => ran++ }),
    ];
    const hit = key("k", { meta: true });
    expect(dispatchKey(cmds, hit.e, { typing: true, paletteOpen: true }, NOOP_CTX)?.id).toBe("palette");
    expect(ran).toBe(1);
  });

  test("a disabled command's keybinding does not fire", () => {
    let ran = 0;
    const cmds = [
      defineCommand({
        id: "exit",
        label: "Exit",
        group: "g",
        keybinding: { key: "Escape" },
        enabled: () => false,
        run: () => ran++,
      }),
    ];
    expect(dispatchKey(cmds, key("Escape").e, GUARD, NOOP_CTX)).toBeNull();
    expect(ran).toBe(0);
  });

  // (c) a REBOUND keybinding (a different key in the declaration) dispatches
  //     correctly — this is exactly the future shortcuts-editor path: change the
  //     declaration's keybinding, nothing else, and the accelerator follows.
  test("rebinding a command to a different key routes the new key to its run", () => {
    let ran = 0;
    const run = () => ran++;
    // The editor would produce this: same id/label/group, a NEW keybinding.
    const rebound = [defineCommand({ id: "measure", label: "Measure", group: "g", keybinding: { key: "d" }, run })];
    // The old key no longer fires it…
    expect(dispatchKey(rebound, key("m").e, GUARD, NOOP_CTX)).toBeNull();
    // …the new one does.
    expect(dispatchKey(rebound, key("d").e, GUARD, NOOP_CTX)?.id).toBe("measure");
    expect(ran).toBe(1);
  });
});

describe("paletteCommands / groupCommands — what the palette derives", () => {
  const cmds = [
    defineCommand({ id: "a", label: "A", group: "Nav", run: () => {} }),
    defineCommand({ id: "b", label: "B", group: "Nav", enabled: () => false, run: () => {} }),
    defineCommand({ id: "c", label: "C", group: "App", palette: false, keybinding: { key: "k", mod: true }, run: () => {} }),
    defineCommand({ id: "d", label: "D", group: "App", run: () => {} }),
  ];

  // (b) the palette lists the registered commands, respects `enabled?`, and drops
  //     keybinding-only entries.
  test("palette list excludes disabled and keybinding-only commands", () => {
    expect(paletteCommands(cmds).map((c) => c.id)).toEqual(["a", "d"]);
  });

  test("commands group by `group`, in first-seen order", () => {
    const groups = groupCommands(paletteCommands(cmds));
    expect(groups.map((g) => g.group)).toEqual(["Nav", "App"]);
    expect(groups[0].commands.map((c) => c.id)).toEqual(["a"]);
    expect(groups[1].commands.map((c) => c.id)).toEqual(["d"]);
  });
});
