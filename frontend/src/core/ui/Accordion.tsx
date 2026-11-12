import { Accordion as KAccordion } from "@kobalte/core/accordion";
import ChevronDown from "lucide-solid/icons/chevron-down";
import type { LucideIcon } from "lucide-solid";
import { createContext, Show, useContext, type Component, type JSX } from "solid-js";
import { prefersReducedMotion } from "../media";

// CSS *animation*, not transition: Kobalte keeps Content mounted through a
// close animation (solid-presence watches animationend), which a transition
// never gets the chance to run for.
const ACCORDION_ANIM_CSS = `
@keyframes mivnav-acc-down {
  from { height: 0; }
  to { height: var(--kb-accordion-content-height); }
}
@keyframes mivnav-acc-up {
  from { height: var(--kb-accordion-content-height); }
  to { height: 0; }
}
.mivnav-acc-content[data-expanded] { animation: mivnav-acc-down var(--duration-collapse) ease-out; }
.mivnav-acc-content[data-closed] { animation: mivnav-acc-up var(--duration-collapse) ease-out; }
@media (prefers-reduced-motion: reduce) {
  .mivnav-acc-content[data-expanded],
  .mivnav-acc-content[data-closed] { animation: none; }
}
`;

interface AccordionProps {
  /** Section values expanded on first render. */
  defaultValue?: string[];
  children: JSX.Element;
}

/** Styled wrapper over Kobalte's Accordion. `multiple`, deliberately: a
 * settings surface should never yank a section closed because you opened
 * another one. */
export const Accordion: Component<AccordionProps> = (props) => (
  <>
    {/* Keyframes for the expand/collapse, inlined so the animation is
        self-contained to this component. */}
    <style>{ACCORDION_ANIM_CSS}</style>
    <KAccordion
      multiple
      defaultValue={props.defaultValue}
      class="divide-y divide-line-2 border-y border-line-2"
    >
      {/* An explicit Accordion root always means collapsible items, even nested
          inside a settings pane that declared flat chrome for its own level. */}
      <SectionChromeProvider chrome="accordion">{props.children}</SectionChromeProvider>
    </KAccordion>
  </>
);

/** How a section wears its chrome: `accordion` / `headed` / `bare`, declared
 * by the PANE, {@link AccordionSection} adapts. See docs/architecture/accordion-chrome.md. */
export type SectionChrome = "accordion" | "headed" | "bare";

// An ACCESSOR, not a raw `SectionChrome`: Solid's Context.Provider captures
// `value` only on first render, so a raw value froze/doubled headings across
// categories. See docs/architecture/accordion-chrome.md.
const SectionChromeContext = createContext<() => SectionChrome>((): SectionChrome => "accordion");

/** Declare the chrome every {@link AccordionSection} below this point wears. */
export const SectionChromeProvider: Component<{
  chrome: SectionChrome;
  children: JSX.Element;
}> = (props) => (
  <SectionChromeContext.Provider value={() => props.chrome}>
    {props.children}
  </SectionChromeContext.Provider>
);

interface AccordionSectionProps {
  /** Stable identity for `defaultValue` — not shown. */
  value: string;
  title: string;
  icon: LucideIcon;
  children: JSX.Element;
}

export const AccordionSection: Component<AccordionSectionProps> = (props) => {
  // `chrome` is an ACCESSOR, read inside `Show`s so a chrome change reaches
  // an already-mounted section too, not just a freshly created one.
  const chrome = useContext(SectionChromeContext);
  return (
    <Show when={chrome() !== "accordion"} fallback={<CollapsibleSection {...props} />}>
      <section class="space-y-3">
        <Show when={chrome() === "headed"}>
          <h3 class="flex items-center gap-2 font-medium text-fg-2">
            <props.icon size={16} aria-hidden="true" class="shrink-0" />
            <span>{props.title}</span>
          </h3>
        </Show>
        <div class="space-y-3">{props.children}</div>
      </section>
    </Show>
  );
};

const CollapsibleSection: Component<AccordionSectionProps> = (props) => (
  <KAccordion.Item value={props.value}>
    <KAccordion.Header>
      {/* pointer-coarse bumps to the 44px minimum (InfoPanel/ModePill match) —
          under a finger this is the ONLY way to reach a collapsed section. */}
      <KAccordion.Trigger class="group flex min-h-9 w-full cursor-pointer items-center gap-2 rounded text-left font-medium outline-none active:bg-chrome-2 focus-visible:ring-2 focus-visible:ring-accent pointer-coarse:min-h-11">
        <props.icon size={16} aria-hidden="true" class="shrink-0 text-fg-2" />
        <span class="flex-1">{props.title}</span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          class="shrink-0 text-fg-3 transition-transform group-data-[expanded]:rotate-180"
        />
      </KAccordion.Trigger>
    </KAccordion.Header>
    {/* overflow-hidden so the animated height actually clips the content; the
        marker class (gated on the reduced-motion accessor) is what the injected
        keyframes hook onto. */}
    <KAccordion.Content
      class="overflow-hidden"
      classList={{ "mivnav-acc-content": !prefersReducedMotion() }}
    >
      {/* pl-6 lines the controls up under the header text, past the icon. */}
      <div class="space-y-3 pb-3 pl-6">{props.children}</div>
    </KAccordion.Content>
  </KAccordion.Item>
);
