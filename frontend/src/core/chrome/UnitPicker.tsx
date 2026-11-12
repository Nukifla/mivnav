// Display-unit picker for a SignalK-path widget. A NATIVE <select> of the
// units valid for the path's quantity (core/units.ts) — native so it is never
// trapped behind a modal sheet on a phone — plus a "Custom label…" escape to
// free text. An unknown quantity (no/odd `meta.units`) is free text only,
// exactly the old behaviour. The stored value is the unit's id, or the label.

import { createMemo, createResource, createSignal, Show, type Component } from "solid-js";
import { enumerateSignalKPaths } from "../signalk";
import { findUnit, quantityFor } from "../units";

const CUSTOM = "__custom__";

export const UnitPicker: Component<{
  /** The SignalK path the unit is for. */
  path: string;
  /** The path's SI `meta.units` when the caller already has it (add flow). */
  siUnits?: string;
  /** Current stored value: a unit id/alias, a custom label, or "" (default). */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Class for the select/input (the form's field style). */
  class: string;
}> = (props) => {
  const [list] = createResource(
    () => (props.siUnits ? false : true),
    () => enumerateSignalKPaths(),
  );
  const si = (): string | undefined =>
    props.siUnits ?? list()?.find((p) => p.path === props.path.trim())?.units;
  const quantity = createMemo(() => quantityFor(si())?.quantity);
  // A value that names a unit of the quantity shows selected; any other
  // non-blank text is a custom label.
  const [forceCustom, setForceCustom] = createSignal(false);
  const selected = (): string => {
    const q = quantity();
    if (!q) return CUSTOM;
    if (forceCustom()) return CUSTOM;
    if (props.value.trim() === "") return "";
    return findUnit(q, props.value)?.id ?? CUSTOM;
  };

  return (
    <Show
      when={quantity()}
      fallback={
        <input
          type="text"
          value={props.value}
          placeholder={props.placeholder}
          onInput={(e) => props.onChange(e.currentTarget.value)}
          class={props.class}
        />
      }
    >
      {(q) => (
        <>
          <select
            value={selected()}
            onChange={(e) => {
              const v = e.currentTarget.value;
              if (v === CUSTOM) {
                setForceCustom(true);
                // keep an existing label; drop a unit id so it isn't mistaken
                if (findUnit(q(), props.value) || props.value.trim() === "") props.onChange("");
              } else {
                setForceCustom(false);
                props.onChange(v);
              }
            }}
            class={props.class}
          >
            {(() => {
              const def = q().units.find((u) => u.id === q().defaultUnit);
              return <option value="" selected={selected() === ""}>Default ({def?.label ?? q().defaultUnit})</option>;
            })()}
            {q().units.map((u) => (
              <option value={u.id} selected={selected() === u.id}>{u.label}</option>
            ))}
            <option value={CUSTOM} selected={selected() === CUSTOM}>Custom label (raw {q().si})…</option>
          </select>
          <Show when={selected() === CUSTOM}>
            <input
              type="text"
              value={props.value}
              placeholder={`label for raw ${q().si}`}
              onInput={(e) => props.onChange(e.currentTarget.value)}
              class={props.class}
            />
          </Show>
        </>
      )}
    </Show>
  );
};
