import ChevronRight from "lucide-solid/icons/chevron-right";
import ShieldAlert from "lucide-solid/icons/shield-alert";
import Ship from "lucide-solid/icons/ship";
import type { Component } from "solid-js";
import { AccordionSection } from "../ui/Accordion";
import { Slider, Toggle } from "../ui/Controls";
import type { ChartSettings } from "../style/settings";
import { openSettingsCategory } from "./SettingsBrowser";

interface AisSectionProps {
  settings: ChartSettings;
  onSettings: (patch: Partial<ChartSettings>) => void;
}

/** Named `-Min` (not bare `formatDuration`) because `chrome/geo.ts` already
 * exports a `formatDuration` for *seconds* — same name, 60x-different unit,
 * a footgun otherwise. Not merged: that one has sub-minute/no-data cases. */
function formatDurationMin(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

const AisSection: Component<AisSectionProps> = (props) => (
  <AccordionSection value="ais" title="Vessels" icon={Ship}>
    {/* The predictor is the request's "heading line … based on its SOG": its
        length is a distance the boat will actually cover, so at the 1 h
        default the vector's length against the scale bar *is* the speed. */}
    <Slider
      label="Predictor"
      value={props.settings.predictorMinutes}
      min={0}
      max={120}
      step={5}
      format={(v) => (v === 0 ? "off" : formatDurationMin(v))}
      onChange={(value) => props.onSettings({ predictorMinutes: value })}
    />
    <p class="text-xs text-fg-2">
      How far ahead each vessel's course line reaches, at its current speed.
    </p>
    {/* Separate control, because it is a separate thing: the stick points where
        the bow points and has no length to configure. The gap between it and
        the predictor is leeway and tide. */}
    <Toggle
      label="Heading line"
      checked={props.settings.showHeadingLine}
      onChange={(value) => props.onSettings({ showHeadingLine: value })}
    />
    {/* Secondary by design; off by default. */}
    <Toggle
      label="Ghost target"
      checked={props.settings.showAisGhost}
      onChange={(value) => props.onSettings({ showAisGhost: value })}
    />
    <p class="text-xs text-fg-2">
      Draw a faded copy of each moving target where it should be now, given how long ago it last
      reported.
    </p>

    {/* Only the colouring's on/off is per device. The thresholds it colours
        by, Off/Show/Tell and sound are the boat's (settings/collision.tsx). */}
    <Toggle
      label="Collision colouring"
      checked={props.settings.showAisRisk}
      onChange={(value) => props.onSettings({ showAisRisk: value })}
    />
    <p class="text-xs text-fg-2">
      Colour each target red or yellow by how close it will pass, using the boat's collision
      alarm thresholds — red means the alarm fires. Grey means it can't be told: the target has
      sent no course, or this boat's own course or speed is unknown.
    </p>
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded border border-line px-2.5 py-2 text-left text-xs text-fg hover:bg-chrome-2 focus-ring"
      onClick={() => openSettingsCategory("server", "alarms")}
    >
      <ShieldAlert size={14} aria-hidden="true" class="shrink-0 text-fg-2" />
      <span class="flex-1">
        Collision alarm settings
        <span class="block text-fg-3">
          Off/Show/Tell, sound and thresholds — for the whole boat
        </span>
      </span>
      <ChevronRight size={14} aria-hidden="true" class="shrink-0 text-fg-3" />
    </button>
  </AccordionSection>
);

export default AisSection;
