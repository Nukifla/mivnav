import { Search } from "@kobalte/core/search";
import ChevronLeft from "lucide-solid/icons/chevron-left";
import CornerDownLeft from "lucide-solid/icons/corner-down-left";
import SearchIcon from "lucide-solid/icons/search";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  Switch,
  Match,
  type Component,
} from "solid-js";
import {
  commandKeybindings,
  filterCommands,
  formatKeybinding,
  inlineCoordinateCommand,
  type Command,
  type CommandContext,
  type GotoTarget,
  type PromptSpec,
} from "./commands";
import { prefersReducedMotion } from "../media";
import { Kbd } from "../ui/Kbd";
import { createEnterExit } from "./useEnterExit";
import { useBackDismiss } from "./backStack";

// Searchable command overlay (Ctrl/Cmd-K, rail-foot launcher). Two phases:
// BROWSE (Kobalte `Search`, filtered via ./commands.ts) and PROMPT (a value
// field). Not a Dialog: nesting Search in one gives two Escape/portal layers.

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The registry (`buildCommands`), assembled in App.tsx and prop-drilled. */
  commands: readonly Command[];
  /** The go-to seam, for the INLINE coordinate result: when the search text
   * parses as a fix, a "Go to …" command is surfaced on top of the list and this
   * moves the map on select (same seam the two-step command uses). */
  onCoordinate: (t: GotoTarget) => void;
}

/** Same command objects in the same order (the inline "Go to <fix>" is minted
 * per query, so a typed query still always yields a fresh list). */
const sameCommands = (a: Command[], b: Command[]): boolean =>
  a.length === b.length && a.every((c, i) => c === b[i]);

const CommandPalette: Component<CommandPaletteProps> = (props) => {
  const [query, setQuery] = createSignal("");
  // Non-null ⇒ phase 2 (the spec carries parse + submit for the command's value).
  const [prompt, setPrompt] = createSignal<PromptSpec<never> | null>(null);

  // Ranked command matches, with a live "Go to <fix>" prepended whenever the
  // query itself parses as a coordinate, so it ranks first.
  // `props.commands` re-filters whenever any command's `enabled()` input
  // ticks (live boat data, polls), producing a new but usually identical
  // array — measured: every option node replaced within two 5 s polls. Keep
  // the old one then, so Kobalte doesn't rebuild the listbox's items under
  // the pointer and drop a tap.
  const filtered = createMemo(
    () => {
      const q = query();
      const matches = filterCommands(props.commands, q);
      const inline = inlineCoordinateCommand(q, props.onCoordinate);
      return inline ? [inline, ...matches] : matches;
    },
    undefined,
    { equals: sameCommands },
  );

  // Every open starts clean: empty query, browse phase.
  createEffect(() => {
    if (props.open) {
      setQuery("");
      setPrompt(null);
    }
  });

  const close = () => props.onOpenChange(false);
  useBackDismiss(() => props.open, close);

  // Shares the sheets' pre→open→closing stage machine (./useEnterExit.ts)
  // rather than a fourth copy with its own fallback timer; no `closeProperty`
  // since the exit animates both opacity and transform.
  const reduce = prefersReducedMotion;
  const ee = createEnterExit({ open: () => props.open });
  const rendered = ee.rendered;
  const stage = ee.stage;

  // Capture-phase, ahead of Kobalte's Search (which swallows Escape on its
  // force-open listbox). In a prompt, steps BACK to the list; else closes.
  createEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (prompt()) {
        setQuery("");
        setPrompt(null);
      } else close();
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  const runCommand = (cmd: Command | null) => {
    if (!cmd) return;
    const ctx: CommandContext = {
      close,
      prompt: (spec) => setPrompt(() => spec),
    };
    cmd.run(ctx);
  };

  return (
    <Show when={rendered()}>
      {/* mousedown (not click) so a drag starting on a result and releasing on
          the backdrop doesn't close under the pointer; top-third alignment
          avoids fighting the on-screen keyboard on a phone. */}
      <div
        class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
        style={{
          opacity: stage() === "open" ? 1 : 0,
          transition: reduce() ? "none" : "opacity var(--duration-fast) ease-out",
        }}
        onMouseDown={close}
      >
        <div
          class="w-full max-w-[560px] overflow-hidden rounded-xl border border-line bg-chrome"
          style={{
            "box-shadow": "0 18px 50px var(--color-shadow)",
            opacity: stage() === "open" ? 1 : 0,
            transform: `scale(${stage() === "open" ? 1 : 0.97})`,
            "transform-origin": "top center",
            transition: reduce()
              ? "none"
              : "opacity var(--duration-fast) ease-out, transform var(--duration-fast) ease-out",
          }}
          onTransitionEnd={ee.handleTransitionEnd}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <Switch>
            <Match when={prompt()}>
              {(spec) => (
                <PromptView
                  spec={spec()}
                  onCancel={() => {
                    setQuery("");
                    setPrompt(null);
                  }}
                />
              )}
            </Match>
            <Match when={!prompt()}>
              <BrowseView filtered={filtered()} onInput={setQuery} onRun={runCommand} />
            </Match>
          </Switch>
        </div>
      </div>
    </Show>
  );
};

/** Phase 1: the searchable command list. */
const BrowseView: Component<{
  filtered: Command[];
  onInput: (q: string) => void;
  onRun: (cmd: Command | null) => void;
}> = (props) => {
  let input: HTMLInputElement | undefined;
  createEffect(() => input?.focus());

  // Tab/Shift+Tab move the highlight instead of leaving the field.
  // stopPropagation (capture phase) is required: Kobalte's own Tab handler
  // runs unconditionally regardless of preventDefault, closing the listbox.
  createEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      e.stopPropagation();
      input?.dispatchEvent(
        new KeyboardEvent("keydown", { key: e.shiftKey ? "ArrowUp" : "ArrowDown", bubbles: true }),
      );
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  const item =
    "group flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-fg focus-ring data-[highlighted]:bg-accent data-[highlighted]:text-accent-fg";

  return (
    <Search<Command>
      open
      onOpenChange={() => {}}
      // Search gets an already-filtered, already-ranked list — ../commands.ts owns ranking.
      options={props.filtered}
      onInputChange={props.onInput}
      onChange={props.onRun}
      optionValue="id"
      optionLabel="label"
      optionTextValue="label"
      placement="bottom"
      sameWidth
      gutter={6}
      itemComponent={(p) => (
        <Search.Item item={p.item} class={item}>
          <div class="flex min-w-0 flex-1 flex-col">
            <Search.ItemLabel class="truncate">{p.item.rawValue.label}</Search.ItemLabel>
            <Show when={p.item.rawValue.hint}>
              {(hint) => (
                <span class="truncate text-xs text-fg-3 group-data-[highlighted]:text-accent-fg/80">
                  {hint()}
                </span>
              )}
            </Show>
          </div>
          {/* Derived from the command's first-class keybinding (../command.ts) so
              chip and accelerator can never drift; shows only the first when a
              command has several. */}
          <Show when={commandKeybindings(p.item.rawValue)[0]}>
            {(kb) => (
              <Kbd class="ml-auto shrink-0 text-[10px] group-data-[highlighted]:text-accent-fg/80">
                {formatKeybinding(kb())}
              </Kbd>
            )}
          </Show>
        </Search.Item>
      )}
    >
      <Search.Control class="flex items-center gap-2 border-b border-line-2 px-3.5">
        <SearchIcon size={17} class="shrink-0 text-fg-3" aria-hidden="true" />
        <Search.Input
          ref={input}
          aria-label="Search commands"
          placeholder="Type a command…"
          class="w-full bg-transparent py-3 text-[15px] text-fg placeholder:text-fg-3 focus:outline-none"
        />
      </Search.Control>
      <Search.Portal>
        <Search.Content
          class="z-[60] rounded-lg border border-line bg-chrome p-1.5"
          style={{ "box-shadow": "0 18px 50px var(--color-shadow)" }}
          // Input keeps focus (list navigates via arrow keys); closing must not yank it.
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <Search.Listbox class="max-h-[46vh] space-y-0.5 overflow-y-auto" />
          <Search.NoResult class="px-2.5 py-3 text-sm text-fg-3">No matching command</Search.NoResult>
        </Search.Content>
      </Search.Portal>
    </Search>
  );
};

/** Phase 2: one text field, parsed live, committed on a valid Enter. */
const PromptView: Component<{ spec: PromptSpec<never>; onCancel: () => void }> = (props) => {
  let input: HTMLInputElement | undefined;
  createEffect(() => input?.focus());

  const [text, setText] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);

  const submit = () => {
    const result = props.spec.parse(text());
    if (result.ok) props.spec.submit(result.value);
    else setError(result.error);
  };

  return (
    <form
      class="p-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div class="mb-1.5 flex items-center gap-1.5">
        <button
          type="button"
          aria-label="Back to commands"
          class="-ml-1 flex items-center rounded p-1 text-fg-3 hover:text-fg"
          onClick={props.onCancel}
        >
          <ChevronLeft size={15} aria-hidden="true" />
        </button>
        <label class="block font-mono text-[11px] font-semibold tracking-[0.06em] text-fg-3">
          {props.spec.label.toUpperCase()}
        </label>
      </div>
      <div
        class="flex items-center gap-2 rounded-md border px-3"
        classList={{ "border-alarm": !!error(), "border-line-2": !error() }}
      >
        <input
          ref={input}
          value={text()}
          placeholder={props.spec.placeholder}
          // Clears a stale error the moment the input could be valid again.
          onInput={(e) => {
            setText(e.currentTarget.value);
            setError(null);
          }}
          class="w-full bg-transparent py-3 text-[15px] text-fg placeholder:text-fg-3 focus:outline-none"
        />
        <button
          type="submit"
          aria-label="Go"
          class="flex shrink-0 items-center gap-1 rounded bg-accent px-2.5 py-1 text-xs font-semibold text-accent-fg hover:brightness-110"
        >
          Go
          <CornerDownLeft size={13} aria-hidden="true" />
        </button>
      </div>
      <Show
        when={error()}
        fallback={
          <Show when={props.spec.hint}>
            <p class="mt-1.5 text-xs text-fg-3">{props.spec.hint}</p>
          </Show>
        }
      >
        {(msg) => (
          <p class="mt-1.5 text-xs text-alarm" role="alert">
            {msg()}
          </p>
        )}
      </Show>
    </form>
  );
};

export default CommandPalette;
