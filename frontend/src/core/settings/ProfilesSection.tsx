import { createEffect, createSignal, For, Show, type Component } from "solid-js";
import Bookmark from "lucide-solid/icons/bookmark";
import { AccordionSection } from "../ui/Accordion";
import { Button } from "../ui/Button";
import { Note } from "../ui/Text";
import {
  createLayouts,
  createProfiles,
  layoutNameFromProfile,
  profileNameError,
  type Profile,
} from "../profiles";
import type { ChartSettings } from "../style/settings";

interface ProfilesSectionProps {
  settings: ChartSettings;
  /** A loaded profile is a *complete* ChartSettings, so patching with all
   * fields is a replacement — no separate "replace everything" prop needed. */
  onSettings: (patch: Partial<ChartSettings>) => void;
  /** `SettingsCtx.applyLayout`: how a profile's referenced layout reaches the
   * board/rail arrangement. This section never touches `chrome`/`Registry`
   * directly, only resolves a name and hands the blob up. */
  applyLayout: (blob: unknown) => void;
}

const savedOn = (updated: number) =>
  updated > 0 ? new Date(updated * 1000).toLocaleDateString() : "";

/**
 * Named snapshots of the display settings, kept on the boat's server.
 * Presentation only — rules live in `createProfiles`. This file's own call:
 * both destructive actions (overwrite, delete) are two-step and in-panel,
 * since on a moving boat the wrong button is one lurch away.
 */
const ProfilesSection: Component<ProfilesSectionProps> = (props) => {
  const state = createProfiles((settings) => props.onSettings(settings));
  // Read-only picker list here; layouts are created/renamed/deleted from the
  // Layouts bar (DashboardEditor.tsx) — this section only REFERENCES one.
  const layouts = createLayouts();
  const [name, setName] = createSignal("");
  // "" means no layout selected for the NEXT save. Seeded from `load` and
  // from typing an EXISTING profile's name below, so "load, tweak, Replace"
  // can't silently drop that profile's own layout reference.
  const [layoutSel, setLayoutSel] = createSignal("");
  /** Which destructive action is one click from happening: the name being
   * overwritten, or `delete:<name>`. */
  const [confirm, setConfirm] = createSignal("");

  const trimmed = () => name().trim();
  const exists = () => state.profiles().some((p) => p.name === trimmed());
  const nameError = () => (trimmed() ? profileNameError(trimmed()) : null);
  const canSave = () => !state.busy() && !!trimmed() && !nameError();

  // Typing an existing profile's name seeds the layout picker from ITS
  // selection, so overwriting-by-typing still carries the layout forward.
  // Only reacts to the name changing, not to picking a different layout after.
  createEffect(() => {
    const match = state.profiles().find((p) => p.name === trimmed());
    if (match) setLayoutSel(layoutNameFromProfile(match.settings) ?? "");
  });

  // Surfaces a stored `layoutName` this device can't currently see (deleted,
  // renamed, still loading) rather than failing silently.
  const missingLayout = (l: string) => !!l && !layouts.layouts().some((y) => y.name === l);

  const save = async () => {
    await state.save(name(), props.settings, layoutSel() || null);
    setConfirm("");
  };

  const load = (profile: Profile) => {
    state.load(profile);
    setName(profile.name); // so "load, tweak, save back into it" is one click
    const layoutName = layoutNameFromProfile(profile.settings);
    setLayoutSel(layoutName ?? "");
    if (layoutName) {
      const layout = layouts.layouts().find((l) => l.name === layoutName);
      if (layout) props.applyLayout(layout.arrangement);
      // else: dangling reference — settings still load, `missingLayout` flags it.
    }
  };

  const remove = async (profile: Profile) => {
    await state.remove(profile);
    setConfirm("");
  };

  const isDefault = (profile: Profile) => state.defaultName() === profile.name;

  return (
    <AccordionSection value="profiles" title="Profiles" icon={Bookmark}>
      <div class="flex gap-2">
        <input
          class="w-full rounded border border-line px-2 py-1 focus:border-accent focus:outline-none"
          placeholder="Profile name"
          value={name()}
          onInput={(e) => {
            setName(e.currentTarget.value);
            setConfirm("");
          }}
        />
        <Show
          when={exists() && confirm() !== trimmed()}
          fallback={
            <Button
              variant="primary"
              size="md"
              class="shrink-0"
              disabled={!canSave()}
              onClick={() => void save()}
            >
              {exists() ? "Replace" : "Save"}
            </Button>
          }
        >
          <Button
            variant="tinted"
            tone="notice"
            size="md"
            class="shrink-0"
            disabled={state.busy()}
            onClick={() => setConfirm(trimmed())}
          >
            Overwrite…
          </Button>
        </Show>
      </div>
      <Show when={nameError()}>
        <p class="text-xs text-notice">{nameError()}</p>
      </Show>

      {/* "" means this profile doesn't touch the dashboard/rail arrangement;
          layouts are edited from Dashboard.tsx's Layouts bar, this is a picker. */}
      <label class="flex items-center gap-2 text-xs text-fg-2">
        <span class="shrink-0">Layout</span>
        <select
          class="w-full rounded border border-line bg-chrome px-2 py-1 focus:border-accent focus:outline-none"
          value={layoutSel()}
          onChange={(e) => setLayoutSel(e.currentTarget.value)}
        >
          <option value="">— none —</option>
          <For each={layouts.layouts()}>{(l) => <option value={l.name}>{l.name}</option>}</For>
          {/* Kept selectable rather than silently swapped to "none", so Save
              doesn't quietly erase a dangling reference. */}
          <Show when={missingLayout(layoutSel())}>
            <option value={layoutSel()}>{layoutSel()} (missing)</option>
          </Show>
        </select>
      </label>
      <Show when={missingLayout(layoutSel())}>
        <p class="text-xs text-notice">
          Layout "{layoutSel()}" no longer exists — saving will keep this reference; pick another or
          "— none —" to clear it.
        </p>
      </Show>

      <Note>
        Captures the visual chart settings, and optionally which dashboard Layout to show — not display
        density or which chart sets show.
      </Note>

      <Show
        when={!state.offline()}
        fallback={
          <div class="space-y-1">
            <p class="text-xs text-notice">
              Profiles live on the boat's server, which is not reachable. Your current settings
              are unaffected.
            </p>
            <Button disabled={state.loading()} onClick={() => void state.refresh()}>
              Retry
            </Button>
          </div>
        }
      >
        <Show
          when={state.profiles().length > 0}
          fallback={<Note>{state.loading() ? "Loading…" : "No saved profiles yet."}</Note>}
        >
          <ul class="space-y-1">
            <For each={state.profiles()}>
              {(profile) => (
                <li class="flex items-center justify-between gap-2 rounded border border-line-2 p-2">
                  <div class="min-w-0">
                    <div class="flex items-center gap-1">
                      <span class="truncate font-medium">{profile.name}</span>
                      <Show when={isDefault(profile)}>
                        <span class="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                          Default
                        </span>
                      </Show>
                    </div>
                    <Show when={savedOn(profile.updated)}>
                      <div class="text-xs text-fg-2">saved {savedOn(profile.updated)}</div>
                    </Show>
                  </div>
                  <span class="flex shrink-0 gap-1">
                    <Button class="font-medium" disabled={state.busy()} onClick={() => load(profile)}>
                      Load
                    </Button>
                    <Show
                      when={isDefault(profile)}
                      fallback={
                        <Button
                          class="font-medium"
                          disabled={state.busy()}
                          title="Make this the default new devices start from"
                          onClick={() => void state.setDefault(profile)}
                        >
                          Use for new devices
                        </Button>
                      }
                    >
                      <Button
                        variant="tinted"
                        tone="accent"
                        class="font-medium"
                        disabled={state.busy()}
                        title="Stop new devices from adopting this"
                        onClick={() => void state.clearDefault(profile)}
                      >
                        Unset
                      </Button>
                    </Show>
                    <Show
                      when={confirm() === `delete:${profile.name}`}
                      fallback={
                        <Button
                          variant="tinted"
                          tone="alarm"
                          disabled={state.busy()}
                          onClick={() => setConfirm(`delete:${profile.name}`)}
                        >
                          Delete
                        </Button>
                      }
                    >
                      <Button variant="danger" disabled={state.busy()} onClick={() => void remove(profile)}>
                        Really delete
                      </Button>
                    </Show>
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>

      <Show when={state.error()}>
        <p class="text-xs text-alarm">{state.error()}</p>
      </Show>
      <Show when={state.status()}>
        <p class="text-xs text-ok">{state.status()}</p>
      </Show>
    </AccordionSection>
  );
};

export default ProfilesSection;
