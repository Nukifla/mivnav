// The ANCHOR mode's surface: a non-modal bottom sheet on the phone, a
// floating card beside the tool stack on the desktop — either way the chart
// stays live under it, so the watch circle can be seen while it is tuned.

import type { Accessor, Component } from "solid-js";
import AnchorIcon from "lucide-solid/icons/anchor";
import X from "lucide-solid/icons/x";
import Sheet, { SHEET_Z } from "../../core/chrome/Sheet";
import { AnchorControl, type AnchorControlProps } from "./ui";

/** Bottom-right, left of the tool stack (MapView's `bottom-[84px] right-2.5`). */
const DESKTOP_CLASS = "right-16 bottom-[84px] w-[360px] border border-line";

const AnchorSheet: Component<{
  control: AnchorControlProps;
  active: Accessor<boolean>;
  onClose: () => void;
}> = (props) => (
  <Sheet
    open={props.active()}
    onOpenChange={(o) => {
      if (!o) props.onClose();
    }}
    title="Anchor watch"
    // Swipe-down dismisses like the X: closing the sheet never stops the
    // watch — the plugin keeps it, and the ANC tile and alarm stay up.
    dismissable
    z={SHEET_Z.mode}
    desktop={{ kind: "floating-card", class: DESKTOP_CLASS }}
  >
    <div class="mb-2 flex items-center justify-between">
      <span class="flex items-center gap-2 font-semibold">
        <AnchorIcon size={18} /> Anchor watch
      </span>
      <button
        type="button"
        aria-label="Close anchor watch"
        class="grid size-9 shrink-0 place-items-center rounded-md text-fg-2 hover:bg-chrome-2 pointer-coarse:size-11"
        onClick={() => props.onClose()}
      >
        <X size={18} />
      </button>
    </div>
    <AnchorControl {...props.control} />
  </Sheet>
);

export default AnchorSheet;
