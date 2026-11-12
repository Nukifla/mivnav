import { describe, expect, test } from "bun:test";
import {
  buildCommands,
  filterCommands,
  gotoCoordinateCommand,
  inlineCoordinateCommand,
  type Command,
  type CommandContext,
  type CommandDeps,
  type GotoTarget,
  type PromptSpec,
} from "./commands";
import { DEFAULT_SETTINGS, type ChartSettings } from "../style/settings";

const cmds: Command[] = [
  { id: "goto", label: "Go to coordinate", keywords: ["jump", "position"], run: () => {} },
  { id: "night", label: "Toggle night mode", run: () => {} },
  { id: "measure", label: "Measure distance", run: () => {} },
];

describe("filterCommands", () => {
  test("an empty query returns everything in declared order", () => {
    expect(filterCommands(cmds, "").map((c) => c.id)).toEqual(["goto", "night", "measure"]);
    expect(filterCommands(cmds, "   ").map((c) => c.id)).toEqual(["goto", "night", "measure"]);
  });

  test("a label substring matches", () => {
    expect(filterCommands(cmds, "night").map((c) => c.id)).toEqual(["night"]);
  });

  test("a keyword matches even though it is not in the label", () => {
    expect(filterCommands(cmds, "jump").map((c) => c.id)).toEqual(["goto"]);
    expect(filterCommands(cmds, "position").map((c) => c.id)).toEqual(["goto"]);
  });

  test("a scattered subsequence matches", () => {
    expect(filterCommands(cmds, "gtc").map((c) => c.id)).toContain("goto");
  });

  test("case insensitive", () => {
    expect(filterCommands(cmds, "GO TO").map((c) => c.id)).toEqual(["goto"]);
  });

  test("no match yields an empty list", () => {
    expect(filterCommands(cmds, "zzz")).toEqual([]);
  });

  test("a prefix outranks a mere substring", () => {
    const list: Command[] = [
      { id: "a", label: "Undo move", run: () => {} },
      { id: "b", label: "Move here", run: () => {} },
    ];
    // "move" is a prefix of b and a substring of a → b first.
    expect(filterCommands(list, "move").map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("gotoCoordinateCommand", () => {
  /** Drive `run` and capture the prompt it opens. */
  function open(cmd: Command) {
    let prompted: PromptSpec<never> | undefined;
    let closed = false;
    const ctx: CommandContext = {
      close: () => {
        closed = true;
      },
      prompt: (spec) => {
        prompted = spec;
      },
    };
    cmd.run(ctx);
    return { prompt: prompted, closed: () => closed };
  }

  test("run opens a prompt rather than acting immediately", () => {
    const cmd = gotoCoordinateCommand({ onGoto: () => {} });
    const { prompt, closed } = open(cmd);
    expect(prompt).toBeDefined();
    expect(prompt?.label).toBe("Coordinate");
    expect(closed()).toBe(false); // nothing happens until the coordinate is entered
  });

  test("a valid coordinate goes to the map and closes", () => {
    let went: GotoTarget | undefined;
    const cmd = gotoCoordinateCommand({ onGoto: (t) => (went = t) });
    const { prompt, closed } = open(cmd);

    const parsed = prompt!.parse("55.5, 10.5");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) prompt!.submit(parsed.value);

    expect(went).toEqual({ lng: 10.5, lat: 55.5 });
    expect(closed()).toBe(true);
  });

  test("an invalid coordinate parses to an error and never moves the map", () => {
    let went: GotoTarget | undefined;
    const cmd = gotoCoordinateCommand({ onGoto: (t) => (went = t) });
    const { prompt } = open(cmd);

    const parsed = prompt!.parse("not a coordinate");
    expect(parsed.ok).toBe(false);
    expect(went).toBeUndefined();
  });

  test("carries the useful search keywords", () => {
    const cmd = gotoCoordinateCommand({ onGoto: () => {} });
    expect(filterCommands([cmd], "jump").map((c) => c.id)).toEqual(["goto-coordinate"]);
    expect(filterCommands([cmd], "position").map((c) => c.id)).toEqual(["goto-coordinate"]);
  });
});

describe("inlineCoordinateCommand", () => {
  /** Run a one-shot command and report what it did. */
  function run(cmd: Command) {
    let closed = false;
    cmd.run({ close: () => (closed = true), prompt: () => {} });
    return closed;
  }

  test("a query that parses as a coordinate yields a go-to result", () => {
    let went: GotoTarget | undefined;
    const cmd = inlineCoordinateCommand("55.5, 10.5", (t) => (went = t));
    expect(cmd).not.toBeNull();
    // The label reads the fix back in marine DDM.
    expect(cmd!.label).toBe("Go to 55°30.0′N 010°30.0′E");
    expect(run(cmd!)).toBe(true); // closes on select
    expect(went).toEqual({ lng: 10.5, lat: 55.5 });
  });

  test("a non-coordinate query yields nothing", () => {
    expect(inlineCoordinateCommand("night palette", () => {})).toBeNull();
    expect(inlineCoordinateCommand("", () => {})).toBeNull();
    expect(inlineCoordinateCommand("soundings", () => {})).toBeNull();
  });

  test("distinct fixes get distinct ids (so the listbox keys them apart)", () => {
    const a = inlineCoordinateCommand("55.5, 10.5", () => {});
    const b = inlineCoordinateCommand("56.5, 10.5", () => {});
    expect(a!.id).not.toBe(b!.id);
  });
});

describe("buildCommands", () => {
  /** A deps stub over a mutable ChartSettings and spies for the rest. */
  function harness(
    overrides: Partial<ChartSettings> = {},
    env: { hasFix?: boolean; hasAutopilot?: boolean } = {},
  ) {
    let settings: ChartSettings = { ...DEFAULT_SETTINGS, ...overrides };
    let mode: string | null = null;
    let debug = false;
    let palette = false;
    let routes = false;
    let centre = 0;
    let board = 0;
    let pilot = 0;
    const deps: CommandDeps = {
      onGoto: () => {},
      settings: () => settings,
      setSettings: (patch) => (settings = { ...settings, ...patch }),
      toggleWindUnit: () =>
        (settings = { ...settings, windUnit: settings.windUnit === "ms" ? "kn" : "ms" }),
      openSettings: () => {},
      openRoutes: () => (routes = true),
      centreBoat: () => (centre += 1),
      hasFix: () => env.hasFix ?? false,
      openDashboard: () => (board += 1),
      openAutopilot: () => {
        board += 1;
        pilot += 1;
      },
      hasAutopilot: () => env.hasAutopilot ?? false,
      toggleMode: (id) => (mode = mode === id ? null : id),
      leaveMode: () => (mode = null),
      activeMode: () => mode,
      togglePalette: () => (palette = !palette),
      debugLayers: () => debug,
      setDebugLayers: (v) => (debug = v),
    };
    return {
      deps,
      settings: () => settings,
      mode: () => mode,
      debug: () => debug,
      palette: () => palette,
      routes: () => routes,
      centre: () => centre,
      board: () => board,
      pilot: () => pilot,
    };
  }

  /** Run the command with the given id; fails loudly if it is absent. */
  function invoke(cmds: Command[], id: string) {
    const cmd = cmds.find((c) => c.id === id);
    if (!cmd) throw new Error(`no command ${id}`);
    cmd.run({ close: () => {}, prompt: () => {} });
  }

  test("a toggle command flips the underlying setting", () => {
    const h = harness({ showText: true });
    invoke(buildCommands(h.deps), "toggle-text");
    expect(h.settings().showText).toBe(false);
    // And back — reading the fresh state each build.
    invoke(buildCommands(h.deps), "toggle-text");
    expect(h.settings().showText).toBe(true);
  });

  test("a toggle labels itself Show/Hide from the current state", () => {
    const on = buildCommands(harness({ showText: true }).deps);
    expect(on.find((c) => c.id === "toggle-text")!.label).toBe("Hide text labels");
    const off = buildCommands(harness({ showText: false }).deps);
    expect(off.find((c) => c.id === "toggle-text")!.label).toBe("Show text labels");
  });

  test("a palette command sets the S-52 table", () => {
    const h = harness({ palette: "day" });
    invoke(buildCommands(h.deps), "palette-night");
    expect(h.settings().palette).toBe("modern-paper-2-night-red");
    invoke(buildCommands(h.deps), "palette-dusk");
    expect(h.settings().palette).toBe("modern-paper-2-night-dim");
    invoke(buildCommands(h.deps), "palette-day");
    expect(h.settings().palette).toBe("modern-paper-2");
  });

  test("debug layers routes through App's own signal, not ChartSettings", () => {
    const h = harness();
    invoke(buildCommands(h.deps), "toggle-debug-layers");
    expect(h.debug()).toBe(true);
  });

  test("the palette toggle is keybinding-only (Ctrl/Cmd-K, not in the palette list)", () => {
    const h = harness();
    const cmd = buildCommands(h.deps).find((c) => c.id === "toggle-palette")!;
    expect(cmd.keybinding).toEqual([
      { key: "k", mod: true },
      { key: " ", mod: true },
    ]);
    expect(cmd.palette).toBe(false);
    cmd.run({ close: () => {}, prompt: () => {} });
    expect(h.palette()).toBe(true);
  });

  test("exit-mode is available only while a mode is active, and leaves it", () => {
    const h = harness();
    const idle = buildCommands(h.deps).find((c) => c.id === "exit-mode")!;
    expect(idle.enabled!()).toBe(false); // nothing to leave
    h.deps.toggleMode("measure"); // now in a mode (a feature launcher would do this)
    const active = buildCommands(h.deps).find((c) => c.id === "exit-mode")!;
    expect(active.enabled!()).toBe(true);
    active.run({ close: () => {}, prompt: () => {} });
    expect(h.mode()).toBeNull();
  });

  test("every seeded command declares a group (the palette section / editor row)", () => {
    for (const c of buildCommands(harness().deps)) expect(c.group).toBeTruthy();
  });

  test("toggle-wind-unit swaps the unit and labels itself by the target unit", () => {
    const ms = buildCommands(harness({ windUnit: "ms" }).deps).find(
      (c) => c.id === "toggle-wind-unit",
    )!;
    expect(ms.label).toBe("Show wind speed in knots");
    const kn = buildCommands(harness({ windUnit: "kn" }).deps).find(
      (c) => c.id === "toggle-wind-unit",
    )!;
    expect(kn.label).toBe("Show wind speed in m/s");

    const h = harness({ windUnit: "ms" });
    invoke(buildCommands(h.deps), "toggle-wind-unit");
    expect(h.settings().windUnit).toBe("kn");
  });

  test("the three CPA commands each set the boat's mode (the rail's 3-way segment)", () => {
    for (const mode of ["off", "show", "tell"] as const) {
      const h = harness();
      const set: string[] = [];
      const before = h.settings();
      invoke(buildCommands({ ...h.deps, setCpaMode: (m) => set.push(m) }), `cpa-${mode}`);
      expect(set).toEqual([mode]);
      // Boat-wide server config, not this device's settings.
      expect(h.settings()).toEqual(before);
    }
  });

  test("without a setCpaMode the CPA commands are left out", () => {
    const ids = buildCommands(harness().deps).map((c) => c.id);
    expect(ids.filter((id) => id.startsWith("cpa-"))).toEqual([]);
  });

  test("open-routes opens the route-list surface", () => {
    const h = harness();
    expect(h.routes()).toBe(false);
    invoke(buildCommands(h.deps), "open-routes");
    expect(h.routes()).toBe(true);
  });

  test("centre-boat bumps the request and is gated on a fix", () => {
    const noFix = buildCommands(harness({}, { hasFix: false }).deps).find(
      (c) => c.id === "centre-boat",
    )!;
    expect(noFix.enabled!()).toBe(false); // no fix → nothing to centre on
    const h = harness({}, { hasFix: true });
    const withFix = buildCommands(h.deps).find((c) => c.id === "centre-boat")!;
    expect(withFix.enabled!()).toBe(true);
    withFix.run({ close: () => {}, prompt: () => {} });
    expect(h.centre()).toBe(1);
  });

  test("open-dashboard bumps the board request (open-only, always available)", () => {
    const h = harness();
    const cmd = buildCommands(h.deps).find((c) => c.id === "open-dashboard")!;
    expect(cmd.enabled).toBeUndefined(); // always offered
    cmd.run({ close: () => {}, prompt: () => {} });
    expect(h.board()).toBe(1);
  });

  test("open-autopilot opens the board on the Pilot tab, gated on a pilot", () => {
    const none = buildCommands(harness({}, { hasAutopilot: false }).deps).find(
      (c) => c.id === "open-autopilot",
    )!;
    expect(none.enabled!()).toBe(false); // no pilot → not offered
    const h = harness({}, { hasAutopilot: true });
    const cmd = buildCommands(h.deps).find((c) => c.id === "open-autopilot")!;
    expect(cmd.enabled!()).toBe(true);
    cmd.run({ close: () => {}, prompt: () => {} });
    expect(h.board()).toBe(1);
    expect(h.pilot()).toBe(1);
  });

  test("the seeded ids and keybindings are unique (the registry would throw otherwise)", () => {
    const cmds = buildCommands(harness().deps);
    const ids = cmds.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = cmds
      .filter((c) => c.keybinding)
      .map((c) => JSON.stringify(c.keybinding));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
