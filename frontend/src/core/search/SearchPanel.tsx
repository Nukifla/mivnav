import { Search } from "@kobalte/core/search";
import SearchIcon from "lucide-solid/icons/search";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  Show,
  type Component,
} from "solid-js";
import { search as runSearch, type SearchResult } from "./client";
import { formatCoordinate, parseCoordinate } from "../coordinate";
import { prefersReducedMotion } from "../media";
import { createEnterExit } from "../chrome/useEnterExit";
import { useBackDismiss } from "../chrome/backStack";
import { HitIcon } from "../info/HitIcon";
import type { InfoHit, InfoProvider } from "../info/types";
import type { GeoPoint } from "../chrome/geo";

// See docs/architecture/search-panel.md: overlay reached from both the
// command palette and Ctrl/Cmd-F; results are server-sorted nearest-first
// and `center` is read untracked so panning doesn't retrigger the search.

const DEBOUNCE_MS = 250;

export interface SearchPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A result was picked. App decides go-to vs. info-panel selection based on
   * `source` — this file deliberately never branches on it (see module doc). */
  onSelect: (r: SearchResult) => void;
  /** Every registered info provider, forwarded to `HitIcon` to resolve an icon. */
  providers: readonly InfoProvider[];
  /** Maps a result to the `InfoHit` its icon is drawn for; `undefined` when the
   * source has no registered provider yet, in which case the row shows no icon. */
  toInfoHit: (r: SearchResult) => InfoHit | undefined;
  /** Chart view centre, sent with every request for server-side nearest-first
   * sort. `undefined` before the map has reported one. */
  center?: GeoPoint;
  /** Extra results PREPENDED ahead of the coordinate result and the real
   * search results, unconditionally (not query-filtered) — a caller's own
   * synthesized rows, the same shape `coordinateResult` below is but built
   * outside this file (e.g. App's "Choose on map", shown only while the panel
   * is open in "pick a route To" mode). Defaults to none; this file never
   * inspects what it's given beyond rendering it, per the no-source-branching
   * rule above. */
  pinned?: SearchResult[];
}

/** "harbourmaster" → "Harbourmaster". Display formatting only — `category` is
 * whatever raw string the source wrote (e.g. `mivnav.ingest.tags.POI_CATEGORIES`). */
function prettyCategory(category: string): string {
  const words = category.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A result with a guaranteed-string label — Kobalte's `optionLabel` needs one,
 * but `title` is nullable. */
interface DisplayResult extends SearchResult {
  displayTitle: string;
}

const SearchPanel: Component<SearchPanelProps> = (props) => {
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<SearchResult[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  // Last-picked result id, restored to the listbox highlight on reopen (see
  // ResultsView's mount effect). Doesn't reset on close: it's a remote-index
  // query, not a fixed list, so clearing it would force a needless re-query.
  const [highlightId, setHighlightId] = createSignal<string | undefined>();

  // A query parsing as a coordinate (../coordinate.ts) gets a synthetic
  // "Go to <fix>" result prepended, live and un-debounced — mirrors the
  // command palette's inlineCoordinateCommand but as a plain SearchResult.
  const coordinateResult = createMemo<SearchResult | null>(() => {
    const r = parseCoordinate(query());
    if (!r.ok) return null;
    return {
      id: `coordinate:${r.value.lat},${r.value.lng}`,
      source: "coordinate",
      region: "",
      category: null,
      title: formatCoordinate(r.value.lat, r.value.lng),
      text: null,
      lat: r.value.lat,
      lon: r.value.lng,
      data: {},
      updated_at: 0,
    };
  });

  // Timer + AbortController, both torn down in onCleanup (same idiom as
  // the weather plugin's mode.ts) so a fast retype can't land a stale response.
  createEffect(() => {
    const q = query();
    if (!q.trim()) {
      setResults([]);
      setLoading(false);
      setFailed(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    const ac = new AbortController();
    const timer = setTimeout(() => {
      // untrack: reading center reactively would retrigger this effect (and
      // refire the search) on every map pan tick.
      const center = untrack(() => props.center);
      runSearch(q, ac.signal, center)
        .then((r) => {
          setResults(r);
          setLoading(false);
        })
        .catch((err) => {
          if ((err as { name?: string })?.name !== "AbortError") {
            setFailed(true);
            setLoading(false);
          }
        });
    }, DEBOUNCE_MS);
    onCleanup(() => {
      clearTimeout(timer);
      ac.abort();
    });
  });

  const close = () => props.onOpenChange(false);
  useBackDismiss(() => props.open, close);

  const reduce = prefersReducedMotion;
  const ee = createEnterExit({ open: () => props.open });
  const rendered = ee.rendered;
  const stage = ee.stage;

  // Capture-phase: Kobalte's own Escape would just close the force-open
  // listbox and leave the panel sitting open (see CommandPalette.tsx).
  createEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  const select = (r: DisplayResult | null) => {
    if (!r) return;
    setHighlightId(r.id);
    props.onSelect(r);
    close();
  };

  return (
    <Show when={rendered()}>
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
          <ResultsView
            results={[
              ...(props.pinned ?? []),
              ...(coordinateResult() ? [coordinateResult()!] : []),
              ...results(),
            ]}
            query={query()}
            loading={loading()}
            failed={failed()}
            onInput={setQuery}
            onSelect={select}
            providers={props.providers}
            toInfoHit={props.toInfoHit}
            highlightId={highlightId()}
          />
        </div>
      </div>
    </Show>
  );
};

/** A separate component so it remounts every time `<Show>` mounts it (same
 * reason as CommandPalette.tsx's BrowseView) — a fresh Kobalte instance has
 * no controlled `inputValue`, so re-seeding below must be imperative. */
const ResultsView: Component<{
  results: SearchResult[];
  query: string;
  loading: boolean;
  failed: boolean;
  onInput: (q: string) => void;
  onSelect: (r: DisplayResult | null) => void;
  providers: readonly InfoProvider[];
  toInfoHit: (r: SearchResult) => InfoHit | undefined;
  /** Result id to restore the listbox highlight to (see SearchPanel's
   * `highlightId`); undefined on first open or a non-pick close. */
  highlightId?: string;
}> = (props) => {
  let input: HTMLInputElement | undefined;

  // Re-seed the last query, selected, so a keystroke replaces rather than
  // edits it. Then replay ArrowDown to restore the listbox highlight —
  // Kobalte has no controlled "highlighted key" prop, only key-driven nav.
  onMount(() => {
    if (!input) return;
    input.value = props.query;
    input.focus();
    input.select();
    if (props.highlightId) {
      const idx = items().findIndex((r) => r.id === props.highlightId);
      for (let i = 0; i <= idx; i++) {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      }
    }
  });

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

  const items = createMemo<DisplayResult[]>(() =>
    props.results.map((r) => ({ ...r, displayTitle: r.title?.trim() || "(untitled)" })),
  );

  const noResultsMessage = createMemo(() => {
    if (!props.query.trim()) return "Type to search";
    if (props.loading) return "Searching…";
    if (props.failed) return "Search failed";
    return "No results";
  });

  const item =
    "group flex cursor-pointer items-start gap-[7px] rounded-md px-2.5 py-2 text-sm text-fg focus-ring data-[highlighted]:bg-accent data-[highlighted]:text-accent-fg";

  return (
    <Search<DisplayResult>
      open
      onOpenChange={() => {}}
      options={items()}
      onInputChange={props.onInput}
      onChange={props.onSelect}
      optionValue="id"
      optionLabel="displayTitle"
      optionTextValue="displayTitle"
      placement="bottom"
      sameWidth
      gutter={6}
      itemComponent={(p) => {
        const hit = props.toInfoHit(p.item.rawValue);
        const providerLabel = hit && props.providers.find((pr) => pr.id === hit.providerId)?.label;
        // Drop hit.subtitle when it duplicates the category span already shown
        // (POI's subtitle is just its category); keep it for e.g. a vessel's
        // live "CPA 2nm, 5 min".
        const subtitle =
          hit?.subtitle && hit.subtitle !== p.item.rawValue.category ? hit.subtitle : undefined;
        const rightLabel = [providerLabel, subtitle].filter(Boolean).join(" · ") || undefined;
        return (
          <Search.Item item={p.item} class={item}>
            <Show when={hit} fallback={<div class="mt-px size-[15px] shrink-0" />}>
              {(h) => <HitIcon hit={h()} providers={props.providers} class="mt-px size-[15px] shrink-0" />}
            </Show>
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <Search.ItemLabel class="truncate">{p.item.rawValue.displayTitle}</Search.ItemLabel>
              <div class="flex items-baseline gap-2">
                <Show when={p.item.rawValue.category}>
                  {(cat) => (
                    <span class="truncate text-xs text-fg-3 group-data-[highlighted]:text-accent-fg/80">
                      {prettyCategory(cat())}
                    </span>
                  )}
                </Show>
                <Show when={rightLabel}>
                  <span class="ml-auto shrink-0 truncate text-[10px] uppercase tracking-wide text-fg-3 group-data-[highlighted]:text-accent-fg/80">
                    {rightLabel}
                  </span>
                </Show>
              </div>
            </div>
          </Search.Item>
        );
      }}
    >
      <Search.Control class="flex items-center gap-2 border-b border-line-2 px-3.5">
        <SearchIcon size={17} class="shrink-0 text-fg-3" aria-hidden="true" />
        <Search.Input
          ref={input}
          aria-label="Search"
          placeholder="Search…"
          class="w-full bg-transparent py-3 text-[15px] text-fg placeholder:text-fg-3 focus:outline-none"
        />
      </Search.Control>
      <Search.Portal>
        <Search.Content
          class="z-[60] rounded-lg border border-line bg-chrome p-1.5"
          style={{ "box-shadow": "0 18px 50px var(--color-shadow)" }}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <Search.Listbox class="max-h-[46vh] space-y-0.5 overflow-y-auto" />
          <Search.NoResult class="px-2.5 py-3 text-sm text-fg-3">
            {noResultsMessage()}
          </Search.NoResult>
        </Search.Content>
      </Search.Portal>
    </Search>
  );
};

export default SearchPanel;
