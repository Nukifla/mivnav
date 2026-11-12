// Settings → Charts → Screens: which devices may show the boat's licensed
// o-charts (at most five — core/ochartsDevice.ts), this screen's place among
// them, and the way back into the registration prompt after it was closed.

import { Show, type Component } from "solid-js";
import MonitorSmartphone from "lucide-solid/icons/monitor-smartphone";
import { AccordionSection } from "../ui/Accordion";
import { Button } from "../ui/Button";
import { Toggle } from "../ui/Controls";
import { DeviceSlots } from "../chrome/DeviceRegistration";
import { ochartsDevice, type OchartsDevice } from "../ochartsDevice";

export const OCHARTS_SCREENS_SCOPE = "ocharts-screens";

const OchartsScreensSection: Component<{ device?: OchartsDevice }> = (props) => {
  const d = props.device ?? ochartsDevice;
  const s = () => d.status();
  return (
    <AccordionSection value={OCHARTS_SCREENS_SCOPE} title="Screens" icon={MonitorSmartphone}>
      <Show
        when={s()?.gate}
        fallback={
          <p class="text-xs text-fg-2">
            No licensed o-charts are installed, so every screen shows every chart — nothing to
            register.
          </p>
        }
      >
        <p class="text-xs text-fg-2">
          Up to {s()?.max} screens can show the boat's o-charts; other screens show only the free
          charts. Any screen can remove another to take its place.
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <span>
            <Show
              when={s()?.registered}
              fallback={<>This screen is not registered.</>}
            >
              This screen is registered as <span class="font-medium">{s()?.device?.name}</span>
              <Show when={!s()?.allowed}> — the licence agreement needs accepting again</Show>.
            </Show>
          </span>
          <Show when={!s()?.allowed}>
            <Button variant="primary" onClick={() => d.openPrompt()}>
              {s()?.registered ? "Review agreement" : "Register this screen"}
            </Button>
          </Show>
        </div>
        <div class="text-xs text-fg-2">
          {s()?.count} of {s()?.max} registered
        </div>
        <DeviceSlots device={d} version={s()?.count} />
        <Toggle
          label="Ask to register when the app opens"
          checked={!d.promptHidden()}
          onChange={(on) => d.setPromptHidden(!on)}
        />
      </Show>
    </AccordionSection>
  );
};

export default OchartsScreensSection;
