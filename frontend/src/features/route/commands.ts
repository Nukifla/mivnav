// The route feature's command contribution — the route-editor launcher, plus
// GO (moved here from `chrome/commands.ts` since a chart mode's launcher
// belongs to the feature that owns the mode). GO is available only while
// route-edit is active and carries no keybinding. Undo/Redo are gone with the
// autorouting-only redesign: corrections are list actions (delete/reorder/Flip).

import { defineCommand, type Command } from "../../core/chrome/command";
import type { CommandDeps } from "../../core/chrome/commands";
import { betaAutorouting } from "../../core/serverConfig";
import type { Route } from "../../core/routes";
import type { ParseResult, PromptSpec } from "../../core/chrome/command";
import type { RoutesModel } from "./index";
import { followName } from "./follow";

/** The saved, followable route a typed name picks: an exact (case-blind)
 * name, else the ONE route whose name contains it. Pure — the "Follow
 * route…" prompt's parse. */
export function pickRouteByName(routes: readonly Route[], raw: string): ParseResult<Route> {
  const q = raw.trim().toLowerCase();
  const usable = routes.filter((r) => r.waypoints.length > 0);
  if (!q) return { ok: false, error: "Type a route name" };
  const exact = usable.filter((r) => followName(r).toLowerCase() === q);
  if (exact.length === 1) return { ok: true, value: exact[0]! };
  const hits = usable.filter((r) => followName(r).toLowerCase().includes(q));
  if (hits.length === 1) return { ok: true, value: hits[0]! };
  if (hits.length === 0) return { ok: false, error: "No saved route by that name" };
  const names = hits.slice(0, 3).map(followName).join(", ");
  return { ok: false, error: `${hits.length} routes match: ${names}${hits.length > 3 ? ", …" : ""}` };
}

/** Is the route editor the active mode? Gates the in-editor commands (and their
 * keybindings) so they neither clutter the palette nor fire outside the editor. */
const editing = (deps: CommandDeps): boolean => deps.activeMode() === "route-edit";

/** The route-editor launcher, and — while editing — Undo and GO. */
export function routeCommands(deps: CommandDeps, model: RoutesModel): Command[] {
  return [
    defineCommand({
      id: "mode-route",
      label: deps.activeMode() === "route-edit" ? "Close route editor" : "Edit route",
      group: "Chart modes",
      hint: "Plan a route by tapping waypoints",
      keywords: ["waypoint", "navigate", "plan", "leg"],
      // The editor is the auto-router: hidden with "Beta autorouting" off.
      enabled: betaAutorouting,
      run: (ctx) => {
        deps.toggleMode("route-edit");
        ctx.close();
      },
    }),
    // Seeds a BLANK draft regardless of any route being followed (the
    // followed one keeps tracking) — same `newRoute` the route list's button calls.
    defineCommand({
      id: "route-new",
      label: "New route",
      group: "Chart modes",
      hint: "Start a fresh blank route in the editor",
      keywords: ["route", "new", "blank", "plan", "create", "waypoint"],
      // The editor is the auto-router: hidden with "Beta autorouting" off.
      enabled: betaAutorouting,
      run: (ctx) => {
        model.newRoute();
        ctx.close();
      },
    }),
    // Following, beta-independent (./follow.ts): pick a route by name; skip
    // waypoints and stop while one is followed.
    defineCommand({
      id: "route-follow",
      label: "Follow route…",
      group: "Navigation",
      hint: "Start following a saved route from the nearest leg ahead",
      keywords: ["follow", "go", "navigate", "activate", "start", "route", "autopilot"],
      enabled: () => model.routes().some((r) => r.waypoints.length > 0),
      run: (ctx) => {
        const names = model
          .routes()
          .filter((r) => r.waypoints.length > 0)
          .slice(0, 4)
          .map(followName);
        ctx.prompt({
          label: "Route name",
          placeholder: names[0] ?? "Route name",
          hint: names.length ? `Saved: ${names.join(", ")}${model.routes().length > 4 ? ", …" : ""}` : undefined,
          parse: (raw) => pickRouteByName(model.routes(), raw),
          submit: (route: Route) => {
            void model.follow(route);
            ctx.close();
          },
        } as PromptSpec<never>);
      },
    }),
    defineCommand({
      id: "route-next-wp",
      label: "Next waypoint",
      group: "Navigation",
      hint: "Skip to the followed route's next waypoint",
      keywords: ["skip", "advance", "waypoint", "route", "follow"],
      enabled: () => {
        const l = model.followLeg();
        return !!l && l.index < l.route.waypoints.length - 1;
      },
      run: (ctx) => {
        void model.skipWaypoint(1);
        ctx.close();
      },
    }),
    defineCommand({
      id: "route-prev-wp",
      label: "Previous waypoint",
      group: "Navigation",
      hint: "Go back to the followed route's previous waypoint",
      keywords: ["back", "waypoint", "route", "follow"],
      enabled: () => {
        const l = model.followLeg();
        return !!l && l.index > 0;
      },
      run: (ctx) => {
        void model.skipWaypoint(-1);
        ctx.close();
      },
    }),
    defineCommand({
      id: "route-stop",
      label: "Stop following",
      group: "Navigation",
      hint: "Stop following the route (it stays saved)",
      keywords: ["stop", "follow", "route", "cancel", "clear"],
      enabled: model.following,
      run: (ctx) => {
        void model.stopFollowing();
        ctx.close();
      },
    }),
    // Flushes the pending auto-save and names the nearest waypoint the active
    // leg (invariant #8) — same `saveAndFollow` the sheet's GO button drives.
    defineCommand({
      id: "route-go",
      label: "Follow this route (GO)",
      group: "Chart modes",
      hint: "Start following the route being edited",
      keywords: ["go", "follow", "activate", "start", "route"],
      enabled: () => editing(deps),
      run: (ctx) => {
        void model.saveAndFollow();
        ctx.close();
      },
    }),
  ];
}
