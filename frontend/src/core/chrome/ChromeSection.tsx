import Gauge from "lucide-solid/icons/gauge";
import { type Accessor, type Component } from "solid-js";
import { AccordionSection } from "../ui/Accordion";
import { Slider } from "../ui/Controls";
import { setDensity, type ChromeConfig } from "./config";
import { DEFAULT_DENSITY, DESK, HELM } from "./registry";

// see docs/architecture/chrome-registry.md (`ChromeSection.tsx` — the density slider)

interface ChromeSectionProps {
  /** This device's config, already through `bootChrome` (boot.ts). */
  chrome: Accessor<ChromeConfig>;
  /** Structural updater, the way `setChrome((c) => …)` is in App.tsx. */
  onChrome: (updater: (cfg: ChromeConfig) => ChromeConfig) => void;
}

/** `0` → "Desk", `DEFAULT_DENSITY` (the midpoint) → "Helm", `1` → "Helm+",
 * anything else → a percentage — the slider's own value label, reached by
 * `getValueLabel` inside the shared `Slider`. */
const formatDensity = (value: number): string =>
  value <= DESK
    ? "Desk"
    : value >= HELM
      ? "Helm+"
      : value === DEFAULT_DENSITY
        ? "Helm"
        : `${Math.round(value * 100)}%`;

/**
 * Density is a SETTING, not a breakpoint (invariant #10): a helm tablet is
 * wide and coarse, and no media query can see a glove.
 */
const ChromeSection: Component<ChromeSectionProps> = (props) => (
  <AccordionSection value="chrome" title="Display density" icon={Gauge}>
    <Slider
      label="Density"
      value={props.chrome().density}
      min={DESK}
      max={HELM}
      step={0.05}
      format={formatDensity}
      onChange={(density) => props.onChrome((c) => setDensity(c, density))}
    />
    <p class="text-xs text-fg-2">
      Desk is a mouse at the nav station; helm is a gloved hand at the wheel — bigger tiles and
      touch targets. A setting on this screen, not a guess from its size.
    </p>
  </AccordionSection>
);

export default ChromeSection;
