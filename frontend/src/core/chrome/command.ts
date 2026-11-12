// The COMMAND registry — the ONE place a "thing you can do" is declared, read
// by the command palette, the accelerators (App.tsx), and the future
// shortcuts editor. Split rationale: docs/architecture/command-registry.md.

import type { Component } from "solid-js";

/** Ok/err over a parsed value — the shape ../coordinate.ts already speaks. A
 * prompt's parse returns this; `error` is shown inline and nothing commits. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** A command's second phase: one free-text field, parsed live, committed on a
 * valid Enter. The palette owns the prompt UI; the command owns parsing and
 * what to do with the answer. */
export interface PromptSpec<T = unknown> {
  /** The field's label / accessible name, e.g. "Coordinate". */
  label: string;
  /** Greyed example shown in the empty field. */
  placeholder?: string;
  /** A one-line hint under the field (accepted formats), optional. */
  hint?: string;
  /** PURE — no side effects. Drives both the inline error and whether Enter is
   * allowed to commit. */
  parse: (raw: string) => ParseResult<T>;
  /** Run the command with the parsed value. The palette closes afterward. */
  submit: (value: T) => void;
}

/** What a command is handed when it RUNS — effect capabilities only; the read
 * side is closed over by `enabled`/`label` at build time (see module doc). */
export interface CommandContext {
  /** Dismiss the palette. A one-shot command calls this itself when done. */
  close: () => void;
  /** Replace the command list with a single text prompt (this command's second
   * phase). Typed loosely so commands of different value types share one
   * context; each command's own `parse`/`submit` are internally consistent. */
  prompt: (spec: PromptSpec<never>) => void;
}

/** A keybinding as DATA (see module doc). `mod` is platform-primary, so ONE
 * declaration binds Cmd-K and Ctrl-K. A `mod`/`alt` binding is a CHORD (fires
 * even while a field/palette is focused); a bare-key binding is guarded (`dispatchKey`). */
export interface Keybinding {
  /** The KeyboardEvent.key to match. Single letters match case-insensitively
   * ("m" matches "m" AND Shift+m's "M"); named keys ("Escape") match exactly. */
  key: string;
  /** ⌘ on macOS / Ctrl elsewhere — matched as `metaKey || ctrlKey`. */
  mod?: boolean;
  alt?: boolean;
  /** Only significant for named keys / when explicitly required; a single-letter
   * binding matches its capital regardless (see `matchesKeybinding`). */
  shift?: boolean;
}

/** ONE command. Declared once; drives the palette entry, the keystroke and
 * the (future) shortcuts-editor row. */
export interface Command {
  /** Stable id — the palette's list key, the accelerator's handle, and the
   * shortcuts editor's key for a rebind. Stable across relabels so a rebind
   * survives a label change. */
  id: string;
  /** What the palette shows and what search matches first. Built from live state
   * at `buildCommands` time (a toggle labels itself "Show"/"Hide"). */
  label: string;
  /** The palette section / shortcuts-editor group this belongs to. */
  group: string;
  /** A one-line "what does this do" caption, dim under the label. Not searched
   * (that's `keywords`) — free to describe in words the query need not contain. */
  hint?: string;
  /** Extra search terms not in the label ("goto", "jump"). Matched, not shown. */
  keywords?: readonly string[];
  /** Optional glyph for the palette row / editor. Declared here as data; the
   * palette need not render it. */
  icon?: Component<{ size?: number | string; class?: string }>;
  /** The keystroke(s) that run this command — FIRST-CLASS and REBINDABLE.
   * Absent = palette/menu only. May declare several bindings for one action;
   * `commandKeybindings` normalizes to a list. */
  keybinding?: Keybinding | readonly Keybinding[];
  /** Availability predicate, closing over live accessors (like
   * `Instrument.when`). Absent = always available; `false` filters the
   * command from the palette AND its keybinding from `dispatchKey`. */
  enabled?: () => boolean;
  /** Whether the command appears in the palette's browsable list. Default true;
   * `false` = keybinding-only (Escape, the palette toggle) — still in the
   * registry for the shortcuts editor, just not offered as a searchable action. */
  palette?: boolean;
  /** Do it. Either finishes and calls `ctx.close()`, or calls `ctx.prompt(...)`. */
  run: (ctx: CommandContext) => void;
}

// Hand-written, not a bare Array.isArray: its lib signature narrows to `any[]`
// (mutable), not assignable from `readonly Keybinding[]`.
function isKeybindingArray(kb: Keybinding | readonly Keybinding[]): kb is readonly Keybinding[] {
  return Array.isArray(kb);
}

/** Normalize a command's `keybinding` field (absent, one, or several) to a
 * list — the one place that shape decision is made, so dispatch, validation,
 * collision-detection and display all agree on it. */
export function commandKeybindings(cmd: Command): readonly Keybinding[] {
  if (!cmd.keybinding) return [];
  return isKeybindingArray(cmd.keybinding) ? cmd.keybinding : [cmd.keybinding];
}

/** Validate and freeze a command — throws rather than trusting review: a
 * non-empty id, a label, and every keybinding with an actual key. */
export function defineCommand(cmd: Command): Command {
  if (!cmd.id) throw new Error("command needs a non-empty id");
  if (!cmd.label) throw new Error(`command "${cmd.id}" needs a label`);
  if (!cmd.group) throw new Error(`command "${cmd.id}" needs a group`);
  if (commandKeybindings(cmd).some((kb) => !kb.key))
    throw new Error(`command "${cmd.id}" has a keybinding with no key`);
  return Object.freeze({ ...cmd });
}

export interface CommandRegistry {
  commands: readonly Command[];
  byId: (id: string) => Command | undefined;
}

/** Index an assembled command array. Catches a duplicate id and a duplicate
 * keybinding (an ambiguous accelerator the dispatcher would otherwise
 * resolve silently by array order). */
export function createCommandRegistry(commands: readonly Command[]): CommandRegistry {
  const dupe = firstDuplicate(commands.map((c) => c.id));
  if (dupe) throw new Error(`duplicate command id: "${dupe}"`);

  const keyDupe = firstDuplicate(commands.flatMap((c) => commandKeybindings(c).map(canonicalKeybinding)));
  if (keyDupe) throw new Error(`two commands bound to the same key: "${keyDupe}"`);

  const index = new Map(commands.map((c) => [c.id, c] as const));
  return { commands, byId: (id) => index.get(id) };
}

function firstDuplicate(ids: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

/** Is this command available right now? Absent `enabled` = yes. */
export const commandAvailable = (cmd: Command): boolean => cmd.enabled?.() ?? true;

/** The commands the palette offers: available AND not keybinding-only. */
export function paletteCommands(commands: readonly Command[]): Command[] {
  return commands.filter((c) => c.palette !== false && commandAvailable(c));
}

/** Group a command list by `group`, in first-seen group order — the shape the
 * shortcuts editor lists, and the palette could section by. */
export function groupCommands(
  commands: readonly Command[],
): { group: string; commands: Command[] }[] {
  const groups: { group: string; commands: Command[] }[] = [];
  const byName = new Map<string, Command[]>();
  for (const cmd of commands) {
    let bucket = byName.get(cmd.group);
    if (!bucket) {
      bucket = [];
      byName.set(cmd.group, bucket);
      groups.push({ group: cmd.group, commands: bucket });
    }
    bucket.push(cmd);
  }
  return groups;
}

/** Filter and rank the command list for a query — pure (command.test.ts).
 * Case-insensitive subsequence match over label + keywords; ranks exact >
 * prefix > substring > keyword/subsequence; ties keep registry order (stable sort). */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...commands];
  const scored: { cmd: Command; score: number; i: number }[] = [];
  commands.forEach((cmd, i) => {
    const score = scoreCommand(cmd, q);
    if (score > 0) scored.push({ cmd, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.cmd);
}

/** Higher is better; 0 means no match at all. */
function scoreCommand(cmd: Command, q: string): number {
  const label = cmd.label.toLowerCase();
  if (label === q) return 100;
  if (label.startsWith(q)) return 80;
  if (label.includes(q)) return 60;
  if ((cmd.keywords ?? []).some((k) => k.toLowerCase().includes(q))) return 40;
  if (isSubsequence(q, label)) return 20;
  return 0;
}

/** Are the characters of `q` found in `text`, in order but not necessarily
 * adjacent? "gtc" ⊆ "go to coordinate". */
function isSubsequence(q: string, text: string): boolean {
  let i = 0;
  for (const ch of text) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return i === q.length;
}

/** Does this keyboard event match this binding? Pure (tested with a plain
 * event stub). A single-letter binding matches case-insensitively and
 * IGNORES shift (Shift+m yields "M"); a named key matches exactly. */
export function matchesKeybinding(kb: Keybinding, e: KeyboardEvent): boolean {
  const single = kb.key.length === 1;
  const keyMatch = single ? e.key.toLowerCase() === kb.key.toLowerCase() : e.key === kb.key;
  if (!keyMatch) return false;
  if (!!kb.mod !== (e.metaKey || e.ctrlKey)) return false;
  if (!!kb.alt !== e.altKey) return false;
  if (kb.shift !== undefined && kb.shift !== e.shiftKey) return false;
  return true;
}

/** A modifier-carrying binding is a CHORD — safe to fire in a text field / with
 * the palette open. Shift alone does NOT make a chord (Shift+letter is text). */
const isChord = (kb: Keybinding): boolean => !!(kb.mod || kb.alt);

/** The display chip: `{key:"m"}`→"M", `{key:"k",mod:true}`→"⌘K",
 * `{key:"Escape"}`→"Esc". The same idiom as Rail.tsx's / Launcher.tsx's ⌘K. */
export function formatKeybinding(kb: Keybinding): string {
  const mods = [kb.mod && "⌘", kb.alt && "⌥", kb.shift && "⇧"].filter(Boolean).join("");
  const key =
    kb.key === " "
      ? "Space"
      : kb.key.length === 1
        ? kb.key.toUpperCase()
        : kb.key === "Escape"
          ? "Esc"
          : kb.key;
  return mods + key;
}

/** A canonical string for dedup — order-independent modifiers + the key. */
function canonicalKeybinding(kb: Keybinding): string {
  return [kb.mod ? "mod" : "", kb.alt ? "alt" : "", kb.shift ? "shift" : "", kb.key.toLowerCase()]
    .filter(Boolean)
    .join("+");
}

/** The guard state `dispatchKey` needs — supplied by App from the live signals. */
export interface KeyGuard {
  /** `isTypingTarget(e.target)` — focus is in a field where keys are text. */
  typing: boolean;
  /** The palette is open (it IS a text field, and owns its own Escape). */
  paletteOpen: boolean;
}

/** THE ONE key→action site. First matching (available) command's keybinding
 * wins; a bare-key binding is suppressed while typing or with the palette
 * open, but a modifier CHORD (Ctrl-K) fires regardless — even from inside its own input. */
export function dispatchKey(
  commands: readonly Command[],
  e: KeyboardEvent,
  guard: KeyGuard,
  ctx: CommandContext,
): Command | null {
  for (const cmd of commands) {
    if (!commandAvailable(cmd)) continue;
    for (const kb of commandKeybindings(cmd)) {
      if (!matchesKeybinding(kb, e)) continue;
      if (!isChord(kb) && (guard.typing || guard.paletteOpen)) continue;
      e.preventDefault();
      cmd.run(ctx);
      return cmd;
    }
  }
  return null;
}
