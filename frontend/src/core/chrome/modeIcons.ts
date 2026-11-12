import AnchorIcon from "lucide-solid/icons/anchor";
import CloudSun from "lucide-solid/icons/cloud-sun";
import RouteIcon from "lucide-solid/icons/route";
import Ruler from "lucide-solid/icons/ruler";
import Spline from "lucide-solid/icons/spline";
import Waypoints from "lucide-solid/icons/waypoints";
import Wrench from "lucide-solid/icons/wrench";
import type { LucideIcon } from "lucide-solid";

// Shared by rail (desktop) and phone tool stack; Mode carries no icon of its
// own (registry.ts), so unrecognised ids fall back to Wrench.
const MODE_ICON: Readonly<Record<string, LucideIcon>> = {
  anchor: AnchorIcon,
  measure: Ruler,
  "route-edit": RouteIcon,
  "route-draw": Spline,
  routeTest: Waypoints,
  weather: CloudSun,
};

export const modeIcon = (id: string): LucideIcon => MODE_ICON[id] ?? Wrench;
