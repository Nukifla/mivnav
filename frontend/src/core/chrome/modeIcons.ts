import AnchorIcon from "lucide-solid/icons/anchor";
import Ruler from "lucide-solid/icons/ruler";
import Spline from "lucide-solid/icons/spline";
import Wrench from "lucide-solid/icons/wrench";
import type { LucideIcon } from "lucide-solid";

// Shared by rail (desktop) and phone tool stack; Mode carries no icon of its
// own (registry.ts), so unrecognised ids fall back to Wrench. A plugin adds
// its modes' icons (`MivnavPlugin.modeIcons`, src/plugins.ts).
const MODE_ICON: Record<string, LucideIcon> = {
  anchor: AnchorIcon,
  measure: Ruler,
  "route-draw": Spline,
};

export function registerModeIcon(id: string, icon: LucideIcon): void {
  MODE_ICON[id] = icon;
}

export const modeIcon = (id: string): LucideIcon => MODE_ICON[id] ?? Wrench;
