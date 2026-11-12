import { Dynamic } from "solid-js/web";
import { For, Show, Switch, Match, type JSX } from "solid-js";
import { AccordionSection, SectionChromeProvider } from "../ui/Accordion";
import { Slider, Toggle } from "../ui/Controls";
import { Segmented } from "../ui/SegmentedControl";
import {
  isSettingEnabled,
  type Setting,
  type SettingsCategory,
  type SettingsRegistry,
  type SettingsSection,
} from "./registry";

// Composed renderer for the settings registry: walks one CATEGORY's sections
// and settings in order, emitting each through the SHARED primitives in
// Controls.tsx so a generated control is byte-for-byte the hand-authored one
// it replaced. `custom`/render-only sections are escape hatches receiving the
// live `ctx`. Every binding calls `setting.read(ctx)` INSIDE the JSX
// expression so Solid tracks the backing signal directly — no store, no memo.

/** One generated control, dispatched on its `control.kind`. */
function SettingControl<C>(props: {
  reg: SettingsRegistry<C>;
  setting: Setting<C>;
  ctx: C;
}): JSX.Element {
  const s = () => props.setting;
  const disabled = () => !isSettingEnabled(props.reg, props.setting, props.ctx);
  // read/write are guaranteed present for a generated (non-custom) control by
  // `defineSetting`; the `!` is that invariant, not a hope.
  const read = () => props.setting.read!(props.ctx);
  const write = (v: boolean | number | string) => props.setting.write!(props.ctx, v);

  return (
    <Switch>
      <Match when={s().control.kind === "toggle"}>
        {/* `help` becomes the toggle's hint — the one place a switch carries a
            consequence its label cannot (matches "OpenStreetMap on land"). */}
        <Toggle
          label={s().label}
          hint={s().help}
          checked={read() as boolean}
          disabled={disabled()}
          onChange={(v) => write(v)}
        />
      </Match>

      <Match when={s().control.kind === "number"}>
        {(() => {
          const c = () => s().control as Extract<Setting<C>["control"], { kind: "number" }>;
          return (
            <Show
              when={c().as === "field"}
              fallback={
                <Slider
                  label={s().label}
                  value={read() as number}
                  min={c().min}
                  max={c().max}
                  step={c().step}
                  format={c().format ?? String}
                  swatch={c().swatch}
                  disabled={disabled()}
                  onChange={(v) => write(v)}
                />
              }
            >
              {/* COMMITS ON BLUR, not per-drag-frame: a boat number is a
                  network write. Guard mirrors the old Field's onCommit:
                  finite and within [min, max], else dropped. */}
              <label class="block">
                <span class="text-xs text-fg-2">{s().label}</span>
                <input
                  type="number"
                  step={c().step}
                  min={c().min}
                  max={c().max}
                  class="mt-1 w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none disabled:opacity-40"
                  disabled={disabled()}
                  value={String(read() as number)}
                  onChange={(e) => {
                    const v = Number(e.currentTarget.value);
                    if (Number.isFinite(v) && v >= c().min && v <= c().max) write(v);
                  }}
                />
                <Show when={s().help}>
                  {(help) => <span class="text-xs text-fg-3">{help()}</span>}
                </Show>
              </label>
            </Show>
          );
        })()}
      </Match>

      <Match when={s().control.kind === "enum"}>
        {(() => {
          const c = () => s().control as Extract<Setting<C>["control"], { kind: "enum" }>;
          return (
            <Show
              when={(c().as ?? "segmented") === "segmented"}
              fallback={
                <label class="flex flex-col gap-2">
                  <span class="font-medium">{s().label}</span>
                  <select
                    class="rounded-md border border-line bg-chrome px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40"
                    value={read() as string}
                    disabled={disabled()}
                    onChange={(e) => write(e.currentTarget.value)}
                  >
                    <For each={c().options}>
                      {(opt) => <option value={opt}>{c().labels?.[opt] ?? opt}</option>}
                    </For>
                  </select>
                </label>
              }
            >
              {/* Same idiom as the weather-field picker. `capitalize` items
                  reproduce the former bespoke `PaletteControl` verbatim. */}
              <Segmented
                value={read() as string}
                onChange={(v) => write(v)}
                label={s().label}
                options={c().options.map((opt) => ({
                  value: opt,
                  label: c().labels?.[opt] ?? opt,
                }))}
                itemLabelClass="capitalize"
              />
            </Show>
          );
        })()}
      </Match>

      <Match when={s().control.kind === "text"}>
        {(() => {
          const c = () => s().control as Extract<Setting<C>["control"], { kind: "text" }>;
          return (
            <label class="flex flex-col gap-1">
              <span class="font-medium">{s().label}</span>
              <input
                type="text"
                class="rounded-md border border-line bg-chrome px-2 py-1.5 text-sm"
                placeholder={c().placeholder}
                value={read() as string}
                disabled={disabled()}
                onInput={c().live ? (e) => write(e.currentTarget.value) : undefined}
                onChange={c().live ? undefined : (e) => write(e.currentTarget.value)}
              />
              <Show when={s().help}>
                {(help) => <span class="text-xs text-fg-2">{help()}</span>}
              </Show>
            </label>
          );
        })()}
      </Match>

      <Match when={s().control.kind === "custom"}>
        {/* ESCAPE HATCH: the setting renders itself, handed the live ctx. */}
        <Dynamic
          component={(s().control as Extract<Setting<C>["control"], { kind: "custom" }>).component}
          setting={props.setting}
          ctx={props.ctx}
          disabled={disabled()}
        />
      </Match>
    </Switch>
  );
}

/** One generated section: an accordion pane, optional intro prose, then its
 * settings — each indented under `pl-4` when it has a cascade master, exactly as
 * the hand-authored sub-toggles were. */
function GeneratedSection<C>(props: {
  reg: SettingsRegistry<C>;
  section: SettingsSection<C>;
  ctx: C;
}): JSX.Element {
  const items = props.reg.settingsFor(props.section.id);
  return (
    <AccordionSection value={props.section.id} title={props.section.title} icon={props.section.icon!}>
      <Show when={props.section.intro}>{(intro) => <>{intro()}</>}</Show>
      <For each={items}>
        {(setting) => (
          <Show
            when={setting.dependsOn}
            fallback={<SettingControl reg={props.reg} setting={setting} ctx={props.ctx} />}
          >
            {/* The indent IS the cascade: a sub-setting sits under its master. */}
            <div class="pl-4">
              <SettingControl reg={props.reg} setting={setting} ctx={props.ctx} />
            </div>
          </Show>
        )}
      </For>
    </AccordionSection>
  );
}

/**
 * ONE CATEGORY'S PANE — every section that named this category, in order.
 * The pane DECLARES the section chrome (single section renders bare; more
 * than one each gets a static subheading), not each section — so a
 * contribution joining a pane adds a heading and never restructures it.
 */
export function CategoryPane<C>(props: {
  reg: SettingsRegistry<C>;
  category: SettingsCategory;
  ctx: C;
}): JSX.Element {
  const sections = () =>
    props.reg.sectionsFor(props.category.id).filter((s) => !s.hidden?.(props.ctx));
  return (
    <SectionChromeProvider chrome={sections().length > 1 ? "headed" : "bare"}>
      <div class="space-y-6">
        <For each={sections()}>
          {(section) => (
            <Show
              when={section.render}
              fallback={<GeneratedSection reg={props.reg} section={section} ctx={props.ctx} />}
            >
              {(render) => <Dynamic component={render()} ctx={props.ctx} />}
            </Show>
          )}
        </For>
      </div>
    </SectionChromeProvider>
  );
}
