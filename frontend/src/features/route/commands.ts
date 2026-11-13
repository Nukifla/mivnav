// The route feature's command contribution: following a saved route by name,
// skipping waypoints and stopping. The route editor's launcher, "New route"
// and GO belong to the autorouting plugin, which owns that editor.

import { defineCommand, type Command } from "../../core/chrome/command";
import type { CommandDeps } from "../../core/chrome/commands";
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

/** The follow commands: pick a route by name; skip waypoints and stop while
 * one is followed. (The route editor's own launcher and GO are the
 * autorouting plugin's.) */
export function routeCommands(_deps: CommandDeps, model: RoutesModel): Command[] {
  return [
    // Following (./follow.ts): pick a route by name; skip
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
  ];
}
