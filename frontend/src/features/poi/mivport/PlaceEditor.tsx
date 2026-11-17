// The mivport place editor: kind, name, position (a pin on the chart), and
// every attribute mivport's registry has for the kind, grouped in sections
// that open for the kinds they matter to (the rest wait behind "Add …"),
// with fields that only apply when another says so (a price only with that
// fuel). Ported from the poi-testclient's place form (form.js); ./form.ts
// holds every rule, this only lays it out with the chrome tokens.

import Check from "lucide-solid/icons/check";
import MapPin from "lucide-solid/icons/map-pin";
import Plus from "lucide-solid/icons/plus";
import X from "lucide-solid/icons/x";
import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import { formatPosition } from "../../../core/info/pointProvider";
import { Button } from "../../../core/ui/Button";
import { roseSectorPath, roseLabelPoint, WIND_DIRS, GRADES, type Grade } from "./detail";
import {
  applies,
  buildEdit,
  changeSummary,
  choiceOptions,
  controlKind,
  formAttrs,
  formErrors,
  formLayout,
  GROUP_LABELS,
  hintOf,
  isCurrency,
  kindGroups,
  kindLabel,
  labelOf,
  nextChip,
  nextGrade,
  parseNumber,
  ROWS,
  sectionShown,
  valueLabel,
  type FormItem,
  type FormSection,
  type PlaceDraft,
  type PlaceOrigin,
} from "./form";
import { GRADE_CLASS } from "./MivportDetail";
import type { MivportAttr, MivportRegistry } from "./types";

const fieldCls =
  "w-full rounded-md border border-line bg-chrome-2 px-2.5 py-1.5 text-xs text-fg placeholder:text-fg-3 focus-ring pointer-coarse:py-2 pointer-coarse:text-sm";
const chipCls =
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs focus-ring pointer-coarse:min-h-10 pointer-coarse:px-3";
const segCls =
  "rounded-md px-2.5 py-1 text-xs focus-ring pointer-coarse:min-h-10 pointer-coarse:px-3 border";

export interface PlaceEditorProps {
  registry: MivportRegistry;
  origin: PlaceOrigin;
  draft: PlaceDraft;
  onDraft: (d: PlaceDraft) => void;
  /** Hide the editor and set the position on the chart. */
  onPin: () => void;
  onCancel: () => void;
  /** Resolves an error to show, or undefined when saved. */
  onSave: () => Promise<string | undefined>;
}

export const PlaceEditor: Component<PlaceEditorProps> = (props) => {
  const reg = () => props.registry;
  const d = () => props.draft;
  const byKey = createMemo(() => new Map(reg().attrs.map((a) => [a.key, a])));
  const layout = createMemo(() => formLayout(reg(), d().kind));
  const present = createMemo(() => new Set(formAttrs(reg(), d().kind).map((a) => a.key)));
  const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set());
  const [kindOpen, setKindOpen] = createSignal(false);
  const [kindQuery, setKindQuery] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const errors = createMemo(() => formErrors(reg(), d().kind, d().values, props.origin.attrs));
  const built = createMemo(() => buildEdit(reg(), props.origin, d()));
  const isNew = () => props.origin.ref === undefined;

  const setValue = (key: string, v: unknown) => props.onDraft({ ...d(), values: { ...d().values, [key]: v } });
  const value = (key: string) => d().values[key];
  const shows = (key: string) => applies(key, d().values, props.origin.attrs, present());

  const save = async () => {
    setError("");
    if (Object.keys(errors()).length) {
      setError("Check the marked fields.");
      return;
    }
    setBusy(true);
    try {
      const why = await props.onSave();
      if (why) setError(why);
    } finally {
      setBusy(false);
    }
  };

  // ---- controls

  const Chip: Component<{ attr: MivportAttr }> = (p) => {
    const h = () => hintOf(p.attr.key);
    const v = () => value(p.attr.key);
    const label = () => h()?.label ?? labelOf(p.attr.key);
    return (
      <button
        type="button"
        class={`${chipCls} ${
          v() === true
            ? "border-ok bg-ok/10 text-fg"
            : v() === false
              ? "border-alarm/60 text-fg-2 line-through"
              : "border-line text-fg-2"
        }`}
        aria-label={`${label()}: ${v() === true ? "yes" : v() === false ? "no" : "not known"}`}
        title={v() === true ? "Tap for no" : v() === false ? "Tap for not known" : "Tap for yes"}
        onClick={() => setValue(p.attr.key, nextChip(v()))}
      >
        <Show when={v() === true} fallback={<Show when={v() === false} fallback={<Plus size={12} />}><X size={12} /></Show>}>
          <Check size={12} />
        </Show>
        {v() === false ? (h()?.no ?? `No ${label().toLowerCase()}`) : label()}
      </button>
    );
  };

  /** One of a few: tapping the chosen one again clears it ("not known"). */
  const Choice: Component<{ attr: MivportAttr }> = (p) => (
    <div class="flex flex-wrap gap-1" role="radiogroup" aria-label={labelOf(p.attr.key)}>
      <For each={choiceOptions(p.attr)}>
        {([v, label]) => {
          const on = () => value(p.attr.key) === v;
          return (
            <button
              type="button"
              role="radio"
              aria-checked={on()}
              class={`${segCls} ${on() ? "border-accent bg-accent/15 font-semibold text-fg" : "border-line text-fg-2"}`}
              onClick={() => setValue(p.attr.key, on() ? null : v)}
            >
              {label}
            </button>
          );
        }}
      </For>
    </div>
  );

  const Select: Component<{ attr: MivportAttr }> = (p) => (
    <select
      class={fieldCls}
      aria-label={labelOf(p.attr.key)}
      value={typeof value(p.attr.key) === "string" ? (value(p.attr.key) as string) : ""}
      onChange={(e) => setValue(p.attr.key, e.currentTarget.value || null)}
    >
      <option value="">–</option>
      <For each={p.attr.values ?? []}>{(v) => <option value={v}>{valueLabel(p.attr.key, v)}</option>}</For>
    </select>
  );

  const Multi: Component<{ attr: MivportAttr }> = (p) => {
    const list = () => (Array.isArray(value(p.attr.key)) ? (value(p.attr.key) as string[]) : []);
    return (
      <div class="flex flex-wrap gap-1" role="group" aria-label={labelOf(p.attr.key)}>
        <For each={p.attr.values ?? []}>
          {(v) => {
            const on = () => list().includes(v);
            return (
              <button
                type="button"
                aria-pressed={on()}
                class={`${chipCls} ${on() ? "border-accent bg-accent/15 text-fg" : "border-line text-fg-2"}`}
                onClick={() => setValue(p.attr.key, on() ? list().filter((x) => x !== v) : [...list(), v])}
              >
                <Show when={on()}>
                  <Check size={12} />
                </Show>
                {valueLabel(p.attr.key, v)}
              </button>
            );
          }}
        </For>
      </div>
    );
  };

  const currencies = (() => {
    try {
      return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("currency") ?? [];
    } catch {
      return [];
    }
  })();
  const COMMON = ["EUR", "DKK", "NOK", "SEK", "GBP", "USD", "CHF", "PLN", "ISK", "TRY"];

  const Currency: Component<{ attr: MivportAttr }> = (p) => {
    const v = () => (typeof value(p.attr.key) === "string" ? (value(p.attr.key) as string) : "");
    return (
      <Show
        when={currencies.length > 0}
        fallback={
          <input
            class={`${fieldCls} uppercase`}
            maxLength={3}
            placeholder="e.g. NOK"
            aria-label={labelOf(p.attr.key)}
            value={v()}
            onInput={(e) => setValue(p.attr.key, e.currentTarget.value.toUpperCase())}
          />
        }
      >
        <select
          class={fieldCls}
          aria-label={labelOf(p.attr.key)}
          value={v()}
          onChange={(e) => setValue(p.attr.key, e.currentTarget.value || null)}
        >
          <option value="">–</option>
          <optgroup label="Common">
            <For each={COMMON.filter((c) => currencies.includes(c))}>{(c) => <option value={c}>{c}</option>}</For>
          </optgroup>
          <optgroup label="All currencies">
            <For each={[...(v() && isCurrency(v()) && !currencies.includes(v()) ? [v()] : []), ...currencies.filter((c) => !COMMON.includes(c))]}>
              {(c) => <option value={c}>{c}</option>}
            </For>
          </optgroup>
        </select>
      </Show>
    );
  };

  /** A number: the text is kept as typed, the value parsed from it. */
  const NumberField: Component<{ attr: MivportAttr; aria?: string; placeholder?: string }> = (p) => {
    const initial = value(p.attr.key);
    const [text, setText] = createSignal(typeof initial === "number" || typeof initial === "string" ? String(initial) : "");
    const unit = () => hintOf(p.attr.key)?.unit;
    return (
      <span class="relative block">
        <input
          type="text"
          inputmode={p.attr.type === "int" ? "numeric" : "decimal"}
          class={`${fieldCls} ${unit() ? "pr-7" : ""}`}
          aria-label={p.aria ?? labelOf(p.attr.key)}
          placeholder={p.placeholder ?? hintOf(p.attr.key)?.placeholder}
          value={text()}
          onInput={(e) => {
            setText(e.currentTarget.value);
            setValue(p.attr.key, parseNumber(e.currentTarget.value));
          }}
        />
        <Show when={unit()}>
          <span class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-fg-3" aria-hidden="true">
            {unit()}
          </span>
        </Show>
      </span>
    );
  };

  const Text: Component<{ attr: MivportAttr; multiline: boolean }> = (p) => {
    const h = () => hintOf(p.attr.key);
    const v = () => (typeof value(p.attr.key) === "string" ? (value(p.attr.key) as string) : "");
    return (
      <Show
        when={p.multiline}
        fallback={
          <input
            class={fieldCls}
            inputmode={h()?.inputmode}
            maxLength={p.attr.max_len}
            placeholder={h()?.placeholder}
            aria-label={labelOf(p.attr.key)}
            autocomplete="off"
            value={v()}
            onInput={(e) => setValue(p.attr.key, e.currentTarget.value)}
          />
        }
      >
        <textarea
          class={`${fieldCls} min-h-20`}
          rows={3}
          maxLength={p.attr.max_len}
          placeholder={h()?.placeholder}
          aria-label={labelOf(p.attr.key)}
          value={v()}
          onInput={(e) => setValue(p.attr.key, e.currentTarget.value)}
        />
      </Show>
    );
  };

  /** The shelter rose: tap a direction (where the wind comes from) for the
   * next grade. */
  const Wind: Component<{ attr: MivportAttr }> = (p) => {
    const grades = () => {
      const v = value(p.attr.key);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
    };
    const gradeList = () => (p.attr.values?.length ? p.attr.values : [...GRADES]);
    const cycle = (dir: string) => {
      const next = nextGrade(gradeList(), grades()[dir]);
      const out = { ...grades() };
      if (next === undefined) delete out[dir];
      else out[dir] = next;
      setValue(p.attr.key, Object.keys(out).length ? out : null);
    };
    return (
      <div class="flex items-center gap-3">
        <svg viewBox="-60 -60 120 120" class="size-36 shrink-0" role="group" aria-label={labelOf(p.attr.key)}>
          <For each={WIND_DIRS}>
            {(dir) => {
              const g = () => grades()[dir] as Grade | undefined;
              return (
                <path
                  d={roseSectorPath(dir)}
                  role="button"
                  tabindex="0"
                  aria-label={`${dir}: ${g() ?? "not known"}`}
                  class={`cursor-pointer ${g() && GRADE_CLASS[g()!] ? `${GRADE_CLASS[g()!]} stroke-chrome` : "fill-chrome-2 stroke-line"}`}
                  stroke-width="0.8"
                  onClick={() => cycle(dir)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      cycle(dir);
                    }
                  }}
                />
              );
            }}
          </For>
          <For each={WIND_DIRS}>
            {(dir) => {
              const at = roseLabelPoint(dir);
              return (
                <text x={at.x} y={at.y + 3} text-anchor="middle" class="pointer-events-none fill-fg-2 text-[9px]">
                  {dir}
                </text>
              );
            }}
          </For>
        </svg>
        <div class="space-y-1 text-[11px] text-fg-2">
          <p>Tap a direction (where the wind comes from) to grade it; tap again for the next grade.</p>
          <p>{gradeList().join(" → ")} → not known</p>
          <Button disabled={!Object.keys(grades()).length} onClick={() => setValue(p.attr.key, null)}>
            Clear
          </Button>
        </div>
      </div>
    );
  };

  const Control: Component<{ attr: MivportAttr; aria?: string; placeholder?: string }> = (p) => {
    switch (controlKind(p.attr)) {
      case "chip":
        return <Chip attr={p.attr} />;
      case "choice":
        return <Choice attr={p.attr} />;
      case "select":
        return <Select attr={p.attr} />;
      case "multi":
        return <Multi attr={p.attr} />;
      case "wind":
        return <Wind attr={p.attr} />;
      case "currency":
        return <Currency attr={p.attr} />;
      case "number":
        return <NumberField attr={p.attr} aria={p.aria} placeholder={p.placeholder} />;
      case "textarea":
        return <Text attr={p.attr} multiline />;
      default:
        return <Text attr={p.attr} multiline={false} />;
    }
  };

  const FieldError: Component<{ keys: string[] }> = (p) => (
    <Show when={p.keys.map((k) => errors()[k]).find(Boolean)}>
      {(msg) => <p class="text-[11px] text-alarm">{msg()}</p>}
    </Show>
  );

  const Item: Component<{ item: FormItem; sectionTitle: string }> = (p) => {
    const it = p.item;
    if (it.type === "chips") {
      return (
        <div class="space-y-1">
          <div class="flex flex-wrap gap-1.5">
            <For each={it.keys}>{(k) => <Chip attr={byKey().get(k)!} />}</For>
          </div>
          <p class="text-[11px] text-fg-3">Tap once for yes, twice for no.</p>
        </div>
      );
    }
    if (it.type === "row") {
      const row = ROWS[it.row];
      const shown = () => it.keys.filter(shows);
      return (
        <Show when={shown().length > 0}>
          <div class="space-y-1">
            <span class="text-xs text-fg-2">{row.label}</span>
            <div class="flex items-end gap-1.5">
              <For each={shown()}>
                {(k, i) => (
                  <>
                    <Show when={row.range && i() > 0}>
                      <span class="pb-2 text-fg-3" aria-hidden="true">
                        –
                      </span>
                    </Show>
                    <label class="min-w-0 flex-1">
                      <Show when={!row.range}>
                        <span class="block text-[11px] text-fg-3">{hintOf(k)?.sub ?? labelOf(k)}</span>
                      </Show>
                      <Control
                        attr={byKey().get(k)!}
                        aria={labelOf(k)}
                        placeholder={row.range ? hintOf(k)?.sub : undefined}
                      />
                    </label>
                  </>
                )}
              </For>
            </div>
            <FieldError keys={it.keys} />
          </div>
        </Show>
      );
    }
    const label = labelOf(it.key);
    return (
      <Show when={shows(it.key)}>
        <div class={`space-y-1 ${hintOf(it.key)?.narrow ? "max-w-40" : ""}`}>
          <Show when={label !== p.sectionTitle}>
            <span class="block text-xs text-fg-2">{label}</span>
          </Show>
          <Control attr={byKey().get(it.key)!} />
          <FieldError keys={[it.key]} />
        </div>
      </Show>
    );
  };

  const Section: Component<{ section: FormSection }> = (p) => (
    <section class="space-y-2 border-t border-line-2 pt-2">
      <h3 class="text-[11px] font-semibold uppercase tracking-wide text-fg-2">{p.section.title}</h3>
      <For each={p.section.items}>{(it) => <Item item={it} sectionTitle={p.section.title} />}</For>
    </section>
  );

  const shownSections = () =>
    layout().sections.filter((s) => sectionShown(s, layout().sections, d().values, opened()));
  const hiddenSections = () =>
    layout().sections.filter((s) => !sectionShown(s, layout().sections, d().values, opened()));

  const pickKind = (k: string) => {
    setKindOpen(false);
    setKindQuery("");
    if (k !== d().kind) props.onDraft({ ...d(), kind: k });
  };

  return (
    <form
      class="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Show when={!props.origin.isCore && !isNew()}>
        <p class="text-[11px] text-fg-2">
          This creates a mivport place linked to the OpenStreetMap element. Name and position keep coming from
          OpenStreetMap unless you fill them in.
        </p>
      </Show>

      {/* Kind */}
      <div class="space-y-1">
        <span class="text-xs text-fg-2">Kind</span>
        <button
          type="button"
          class="flex w-full items-center justify-between gap-2 rounded-md border border-line bg-chrome-2 px-2.5 py-1.5 text-left focus-ring pointer-coarse:min-h-11"
          aria-expanded={kindOpen()}
          onClick={() => setKindOpen(!kindOpen())}
        >
          <span class="min-w-0">
            <span class="block truncate text-sm font-semibold text-fg">{kindLabel(reg(), d().kind)}</span>
            <span class="block text-[11px] text-fg-3">
              {GROUP_LABELS[reg().kinds.find((k) => k.name === d().kind)?.group ?? ""] ?? ""}
            </span>
          </span>
          <span class="shrink-0 text-xs text-accent">{kindOpen() ? "Close" : "Change"}</span>
        </button>
        <Show when={kindOpen()}>
          <div class="space-y-2 rounded-md border border-line-2 p-2">
            <input
              type="search"
              class={fieldCls}
              placeholder="Search kinds"
              aria-label="Search kinds"
              value={kindQuery()}
              onInput={(e) => setKindQuery(e.currentTarget.value)}
            />
            <div class="max-h-64 space-y-2 overflow-y-auto">
              <For each={kindGroups(reg(), kindQuery())}>
                {(g) => (
                  <div class="space-y-1">
                    <p class="text-[11px] font-semibold uppercase tracking-wide text-fg-3">
                      {GROUP_LABELS[g.group] ?? g.group}
                    </p>
                    <div class="flex flex-wrap gap-1">
                      <For each={g.kinds}>
                        {(k) => (
                          <button
                            type="button"
                            class={`${segCls} ${k.name === d().kind ? "border-accent bg-accent/15 font-semibold text-fg" : "border-line text-fg-2"}`}
                            onClick={() => pickKind(k.name)}
                          >
                            {k.label}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>

      {/* Name */}
      <label class="block space-y-1">
        <span class="text-xs text-fg-2">Name</span>
        <input
          class={fieldCls}
          maxLength={200}
          autocomplete="off"
          placeholder={props.origin.osmName ? `${props.origin.osmName} (from OpenStreetMap)` : "Name, if it has one"}
          value={d().name}
          onInput={(e) => props.onDraft({ ...d(), name: e.currentTarget.value })}
        />
      </label>

      {/* Description and any other top-block field */}
      <For each={layout().main}>
        {(k) => (
          <div class="space-y-1">
            <span class="block text-xs text-fg-2">{labelOf(k)}</span>
            <Control attr={byKey().get(k)!} />
            <FieldError keys={[k]} />
          </div>
        )}
      </For>

      {/* Position */}
      <div class="space-y-1">
        <span class="text-xs text-fg-2">Position</span>
        <div class="flex items-center justify-between gap-2 rounded-md border border-line-2 px-2.5 py-1.5">
          <span class="flex min-w-0 items-center gap-1.5 text-xs text-fg">
            <MapPin size={14} class="shrink-0 text-fg-3" />
            <Show
              when={d().pos}
              fallback={
                <span class="text-fg-3">{props.origin.osmName !== undefined ? "From OpenStreetMap" : "Not set"}</span>
              }
            >
              {(p) => (
                <span class="font-mono">
                  {formatPosition({ lat: p().lat, lng: p().lon })}
                  <Show when={!isNew() && !d().posMoved}>
                    <span class="font-sans text-fg-3"> · unchanged</span>
                  </Show>
                </span>
              )}
            </Show>
          </span>
          <Button size="md" onClick={() => props.onPin()}>
            {d().pos ? "Move pin" : "Set on chart"}
          </Button>
        </div>
      </div>

      {/* Sections */}
      <For each={shownSections()}>{(s) => <Section section={s} />}</For>
      <Show when={hiddenSections().length > 0}>
        <div class="flex flex-wrap items-center gap-1.5 border-t border-line-2 pt-2">
          <span class="text-xs text-fg-3">Add</span>
          <For each={hiddenSections()}>
            {(s) => (
              <button
                type="button"
                class={`${chipCls} border-line text-fg-2 hover:border-accent hover:text-accent`}
                onClick={() => setOpened(new Set([...opened(), s.id]))}
              >
                <Plus size={12} />
                {s.title}
              </button>
            )}
          </For>
        </div>
      </Show>

      {/* Footer */}
      <div class="sticky bottom-0 -mx-4 space-y-1.5 border-t border-line-2 bg-chrome px-4 pb-1 pt-2">
        <p class="truncate text-[11px] text-fg-2" title={changeSummary(built().labels)}>
          {isNew() ? "New place" : changeSummary(built().labels)}
        </p>
        <Show when={error()}>
          <p class="text-xs text-alarm">{error()}</p>
        </Show>
        <div class="flex justify-end gap-2">
          <Button size="md" onClick={() => props.onCancel()}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={busy() || (props.origin.isCore && !built().request)}
          >
            {busy() ? "Saving…" : isNew() ? "Add place" : "Save"}
          </Button>
        </div>
      </div>
    </form>
  );
};
