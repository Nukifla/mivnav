import Settings from "lucide-solid/icons/settings";
import GripVertical from "lucide-solid/icons/grip-vertical";
import Anchor from "lucide-solid/icons/anchor";
import Eye from "lucide-solid/icons/eye";
import EyeOff from "lucide-solid/icons/eye-off";
import Pencil from "lucide-solid/icons/pencil";
import Check from "lucide-solid/icons/check";
import {
  createSignal,
  For,
  Show,
  onCleanup,
  type Accessor,
  type Component,
  type JSX,
} from "solid-js";
import Sheet from "./Sheet";
import { useBackDismiss } from "./backStack";
import { ScrubPercent, Toggle } from "../ui/Controls";
import { isSettingEnabled, type SettingsRegistry } from "../settings/registry";
import { layerQuickPanel } from "../settings/device";
import { NO_BOAT_CTX, type SettingsCtx } from "../settings/ctx";
import type { MapLayer } from "./feature";
import { moveInOrder } from "../layers/mapLayerOrder";
import { dropTargetIndex } from "./dashboardDnd";
import type { ChartSettings } from "../style/settings";

// Layers quick-panel: chart-detail cascade plus the generic map-layer
// registry (toggle/opacity/reorder). Own-ship is `pinned`: never draggable,
// never toggled off, always topmost. See docs/architecture/layers-panel.md.

export interface LayersPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reg: SettingsRegistry<SettingsCtx>;
  settings: Accessor<ChartSettings>;
  onSettings: (patch: Partial<ChartSettings>) => void;
  /** Stack order bottom -> top, assembled by App (`orderMapLayers`);
   * rendered top-first. */
  layers: readonly MapLayer[];
  /** Reorderable (non-pinned) ids, bottom -> top; own-ship is excluded by
   * construction (it's pinned). */
  onReorder: (ids: string[]) => void;
  onMoreSettings: () => void;
  /** A device signal, not a `ChartSettings` field — since the grid's
   * deep-Settings twin was removed this panel is its only surface. */
  showGrid: boolean;
  onShowGrid: (value: boolean) => void;
}

/** App -> panel seam: fields are wired to props over getters (stay reactive)
 * rather than stubbed. See docs/architecture/layers-panel.md. */
export function layersPanelCtx(props: LayersPanelProps): SettingsCtx {
  return {
    get settings() {
      return props.settings();
    },
    onSettings: (patch) => props.onSettings(patch),
    debugLayers: false,
    onDebugLayers: () => {},
    debugTiles: false,
    onDebugTiles: () => {},
    debugCells: false,
    onDebugCells: () => {},
    fpsDebug: false,
    onFpsDebug: () => {},
    get showGrid() {
      return props.showGrid;
    },
    onShowGrid: (value) => props.onShowGrid(value),
    sets: [],
    disabledSets: [],
    onToggleSet: () => {},
    catalogError: "",
    onRetryCatalog: () => {},
    chrome: (() => ({})) as unknown as SettingsCtx["chrome"],
    onChrome: () => {},
    applyLayout: () => {},
    ...NO_BOAT_CTX,
  };
}

const LayersPanel: Component<LayersPanelProps> = (props) => {
  // The Android/gesture Back button dismisses the panel rather than leaving the
  // app. See ./backStack.ts.
  useBackDismiss(() => props.open, () => props.onOpenChange(false));
  const ctx: SettingsCtx = layersPanelCtx(props);

  // Pure and stable — the registry does not change over the panel's life.
  const groups = layerQuickPanel(props.reg);

  // TOP-of-stack first: `props.layers` is bottom → top, the list reads top → down.
  const display = () => [...props.layers].reverse();
  // The reorderable (non-pinned) ids in DISPLAY order — the array the drag moves.
  const rowIds = () => display().filter((l) => !l.pinned).map((l) => l.id);

  const [editing, setEditing] = createSignal(false);
  const [dragId, setDragId] = createSignal<string | null>(null);
  // The insertion gap among the reorderable rows (0..n) under the pointer, or null.
  const [dropGap, setDropGap] = createSignal<number | null>(null);

  const detach = (): void => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
  };
  const reset = (): void => {
    setDragId(null);
    setDropGap(null);
    detach();
  };
  // Hit-test the row under the pointer and turn it into an insertion gap.
  const hit = (y: number): void => {
    const el = document.elementFromPoint(
      // x is irrelevant for a vertical list; probe the row column's centre-ish.
      (document.querySelector("[data-layer-row]") as HTMLElement | null)?.getBoundingClientRect()
        .left ?? 0,
      y,
    );
    const row = el?.closest<HTMLElement>("[data-layer-row]");
    if (!row) return;
    const idx = Number(row.dataset.layerIndex);
    const r = row.getBoundingClientRect();
    setDropGap(y - r.top > r.height / 2 ? idx + 1 : idx);
  };
  const onMove = (e: PointerEvent): void => {
    if (!dragId()) return;
    if (e.cancelable) e.preventDefault();
    hit(e.clientY);
  };
  const onUp = (): void => {
    const id = dragId();
    const gap = dropGap();
    if (id != null && gap != null) {
      const ids = rowIds();
      const from = ids.indexOf(id);
      if (from >= 0) {
        const to = dropTargetIndex(from, gap);
        const nextDisplay = moveInOrder(ids, from, to);
        // Persist bottom → top (the display order reversed).
        if (nextDisplay.join() !== ids.join()) props.onReorder([...nextDisplay].reverse());
      }
    }
    reset();
  };
  const onCancel = (): void => reset();
  const startDrag = (id: string, e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setDragId(id);
    setDropGap(rowIds().indexOf(id));
    try {
      (e.currentTarget as Element | null)?.setPointerCapture?.(e.pointerId);
    } catch {
      /* best-effort; the window listeners drive the drag regardless */
    }
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };
  onCleanup(reset);

  const Group: Component<{ title: string; children: JSX.Element; action?: JSX.Element }> = (gp) => (
    <section class="space-y-3.5">
      <div class="flex items-center justify-between">
        <h3 class="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-fg-3">
          {gp.title}
        </h3>
        {gp.action}
      </div>
      {gp.children}
    </section>
  );

  // `index` is position among reorderable rows (drag hit-test); pinned rows
  // pass -1. A hidden layer dims its label/% field but keeps both live —
  // you can still scrub a hidden layer's opacity, and the eye brings it back.
  const Row: Component<{ layer: MapLayer; index: number }> = (rp) => {
    const l = () => rp.layer;
    const isDragging = () => dragId() === l().id;
    const hasOpacity = () => !!(l().opacity && l().setOpacity);
    // Cascade parent off (Text→names) → the layer can't be shown; grey its eye.
    const enabled = () => (l().enabled ? l().enabled!() : true);
    const hidden = () => !l().pinned && !l().visible();
    return (
      <div
        data-layer-row
        data-layer-index={rp.index}
        class="rounded-md transition-colors"
        classList={{
          "opacity-40": isDragging(),
          // A drop line above/below this row while another is dragged over its gap.
          "border-t-2 border-accent": editing() && !isDragging() && dropGap() === rp.index,
        }}
      >
        <div class="flex items-center gap-2">
          <Show when={editing() && !l().pinned}>
            <button
              type="button"
              aria-label={`Reorder ${l().label}`}
              class="shrink-0 cursor-grab touch-none rounded p-1 text-fg-3 hover:text-fg active:cursor-grabbing focus-ring"
              style={{ "touch-action": "none" }}
              onPointerDown={(e) => startDrag(l().id, e)}
            >
              <GripVertical size={18} aria-hidden="true" />
            </button>
          </Show>
          <Show
            when={!l().pinned}
            fallback={
              // Own-ship: pinned, never toggled off — an anchor badge in the eye's
              // slot, not a pressable eye.
              <span
                class="shrink-0 p-1.5 text-fg-3 pointer-coarse:p-2"
                title="Pinned on top — always visible"
                aria-hidden="true"
              >
                <Anchor size={18} />
              </span>
            }
          >
            <button
              type="button"
              aria-label={`${l().visible() ? "Hide" : "Show"} ${l().label}`}
              aria-pressed={l().visible()}
              disabled={!enabled()}
              class="shrink-0 rounded p-1.5 focus-ring pointer-coarse:p-2 disabled:cursor-not-allowed disabled:opacity-40"
              classList={{
                "text-fg hover:text-accent": l().visible(),
                "text-fg-3 hover:text-fg": !l().visible(),
              }}
              onClick={() => l().setVisible(!l().visible())}
            >
              <Show when={l().visible()} fallback={<EyeOff size={18} aria-hidden="true" />}>
                <Eye size={18} aria-hidden="true" />
              </Show>
            </button>
          </Show>
          <span
            class="min-w-0 flex-1 truncate text-sm font-medium transition-opacity"
            classList={{ "opacity-40": hidden() }}
          >
            {l().label}
          </span>
          <Show when={l().pinned}>
            <span class="shrink-0 text-[11px] text-fg-3">Always on top</span>
          </Show>
          <Show when={hasOpacity()}>
            <div classList={{ "opacity-40": hidden() }}>
              <ScrubPercent
                value={l().opacity!()}
                step={0.05}
                aria-label={`${l().label} opacity`}
                onChange={(v) => l().setOpacity!(v)}
              />
            </div>
          </Show>
        </div>
      </div>
    );
  };

  return (
    <Sheet
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Layers"
      modal
      fullscreen
      desktop={{ kind: "edge-drawer", side: "right" }}
    >
      <div class="space-y-6">
        {/* Map layers — the generic registry, rendered uniformly. Placed first so
            the actual layer toggles sit at the top; the Edit button reveals the
            drag handles; own-ship stays pinned on top. */}
        <Show when={props.layers.length > 0}>
          <Group
            title="Map layers"
            action={
              <button
                type="button"
                aria-pressed={editing()}
                class="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide focus-ring"
                classList={{
                  "text-accent": editing(),
                  "text-fg-3 hover:text-fg": !editing(),
                }}
                onClick={() => {
                  reset();
                  setEditing((e) => !e);
                }}
              >
                <Show when={editing()} fallback={<Pencil size={13} aria-hidden="true" />}>
                  <Check size={13} aria-hidden="true" />
                </Show>
                {editing() ? "Done" : "Edit"}
              </button>
            }
          >
            <div class="space-y-4">
              <For each={display()}>
                {(layer) => {
                  // The row's index among reorderable rows (pinned → -1).
                  const idx = () => rowIds().indexOf(layer.id);
                  return <Row layer={layer} index={layer.pinned ? -1 : idx()} />;
                }}
              </For>
            </div>
          </Group>
        </Show>

        {/* Chart-detail cascade — reused from the settings registry so labels,
            help and the Text/Lights cascade come for free. Rendered below the
            map-layer list: these are the "other settings". */}
        <For each={groups}>
          {(group) => (
            <Show when={group.settings.length > 0}>
              <Group title={group.title}>
                <For each={group.settings}>
                  {(s) => (
                    <Toggle
                      label={s.label}
                      hint={s.help}
                      checked={s.read!(ctx) as boolean}
                      disabled={!isSettingEnabled(props.reg, s, ctx)}
                      onChange={(v) => s.write!(ctx, v)}
                    />
                  )}
                </For>
              </Group>
            </Show>
          )}
        </For>

        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md border border-line px-3 py-2.5 text-left text-sm font-semibold text-fg-2 hover:border-accent hover:text-accent active:brightness-95 focus-ring"
          onClick={() => {
            props.onOpenChange(false);
            props.onMoreSettings();
          }}
        >
          <Settings size={16} aria-hidden="true" class="shrink-0" />
          More settings
          <span class="ml-auto text-xs font-normal text-fg-3">thresholds · sources</span>
        </button>
      </div>
    </Sheet>
  );
};

export default LayersPanel;
