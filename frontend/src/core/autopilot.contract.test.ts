import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAutopilotClient, type AutopilotClient, type Direction } from "./autopilot";

// Cross-language drift guard for the AUTOPILOT WIRE CONTRACT.
//
// autopilot.ts hand-writes the method + path (+ body key) of every pilot
// command, mirroring the routes in backend/mivnav/features/autopilot/routes.py
// and the direction split in that module (moved there from
// backend/mivnav/api/autopilot.py by the Feature-abstraction restructuring —
// this test's own path reference had gone stale until this fix). This
// actuates STEERING: a backend rename that the frontend does not follow ships
// a command that 404s at the helm, silently, because autopilot.test.ts only
// checks the frontend against its own expectations. This test parses the
// backend as the source of truth and fails if the two drift — a route added,
// renamed, re-verbed, or a body key changed.
//
// It is the sibling of style/chartStyle.vectorLayers.test.ts: parse the Python,
// assert the TS matches. A broken parse throws (a red test), never passes.

const AUTOPILOT_PY = join(
  import.meta.dir,
  "../../../backend/mivnav/features/autopilot/routes.py",
);

interface BackendRoute {
  method: string;
  /** Full path including the router prefix, `{param}` placeholders intact. */
  path: string;
  /** The Pydantic model named as the endpoint's `body:` param, if any. */
  bodyModel?: string;
}

function readBackend(): string {
  return readFileSync(AUTOPILOT_PY, "utf8");
}

/** The router prefix (`APIRouter(prefix="/autopilot")`). */
function routerPrefix(src: string): string {
  const m = src.match(/APIRouter\(\s*prefix\s*=\s*"([^"]*)"/);
  if (!m) throw new Error(`could not find the APIRouter prefix in ${AUTOPILOT_PY}`);
  return m[1];
}

/** Every `@router.<verb>("<subpath>")` and the `body: <Model>` of the function
 * it decorates. Fails loud if the file yields nothing. */
function backendRoutes(src: string): BackendRoute[] {
  const prefix = routerPrefix(src);
  const decorator = /@router\.(get|post|put|delete)\(\s*"([^"]*)"\s*\)/g;
  const routes: BackendRoute[] = [];
  let m: RegExpExecArray | null;
  while ((m = decorator.exec(src))) {
    const [method, sub] = [m[1].toUpperCase(), m[2]];
    // The endpoint body model, if any, is the `body: X` param of the def that
    // immediately follows this decorator — look only as far as the next route.
    const rest = src.slice(m.index);
    const next = rest.slice(1).search(/@router\./);
    const chunk = next === -1 ? rest : rest.slice(0, next + 1);
    const bodyModel = chunk.match(/\bbody:\s*(\w+)/)?.[1];
    routes.push({ method, path: prefix + sub, bodyModel });
  }
  if (routes.length === 0) throw new Error(`no routes parsed from ${AUTOPILOT_PY}`);
  return routes;
}

/** The fields of a Pydantic model (its `name: type` lines), skipping
 * `model_config` and comments. */
function modelFields(src: string, model: string): string[] {
  const block = src.match(new RegExp(`class ${model}\\(BaseModel\\):([\\s\\S]*?)\\n\\n`));
  if (!block) throw new Error(`could not find model ${model} in ${AUTOPILOT_PY}`);
  return [...block[1].matchAll(/^\s{4}(\w+)\s*:/gm)]
    .map((f) => f[1])
    .filter((name) => name !== "model_config");
}

/** The Python direction tuple `_DIRECTIONS = ("port", "starboard")`. */
function backendDirections(src: string): string[] {
  const m = src.match(/_DIRECTIONS\s*=\s*\(([^)]*)\)/);
  if (!m) throw new Error(`could not find _DIRECTIONS in ${AUTOPILOT_PY}`);
  const names = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  if (names.length === 0) throw new Error("_DIRECTIONS parsed as empty");
  return names;
}

/** The frontend `Direction` union, parsed from autopilot.ts source (the type is
 * erased at runtime, so this mirrors the vectorLayers guard's approach). */
function frontendDirections(): string[] {
  const src = readFileSync(join(import.meta.dir, "autopilot.ts"), "utf8");
  const m = src.match(/export type Direction\s*=\s*([^;]+);/);
  if (!m) throw new Error("could not find `export type Direction` in autopilot.ts");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

interface WireCall {
  method: string;
  /** Path with the `/api` mount stripped and `{direction}` restored. */
  path: string;
  bodyKeys: string[];
}

/** Drive every client method through a recording fetch and read back the wire
 * shape it emits: method, path, and body keys. */
async function frontendWire(): Promise<WireCall[]> {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetch = (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) } as Response);
  };
  const c: AutopilotClient = createAutopilotClient({ fetch });
  // One call per client method — the whole command surface. If a method is
  // added to the interface without a line here, TS does not complain, but the
  // route-set equality below turns red (the new backend route is unmatched).
  await Promise.all([
    c.info(),
    c.engage(),
    c.disengage(),
    c.setState("auto"),
    c.setMode("wind"),
    c.setTarget(120),
    c.adjustTarget(-10),
    c.tack("port"),
    c.gybe("starboard"),
    c.startDodge(),
    c.stopDodge(),
    c.dodge(5),
  ]);
  return calls.map((call) => ({
    method: call.method,
    path: call.url
      .replace(/^\/api/, "")
      .replace(/\/(tack|gybe)\/(port|starboard)$/, "/$1/{direction}"),
    bodyKeys:
      call.body && typeof call.body === "object" ? Object.keys(call.body as object).sort() : [],
  }));
}

describe("autopilot wire contract stays in lockstep with the backend", () => {
  const src = readBackend();
  const routes = backendRoutes(src);

  test("the parse is non-trivial (guards against a vacuous pass)", () => {
    expect(routes.length).toBeGreaterThanOrEqual(12);
  });

  test("methods and paths match the backend routes exactly", async () => {
    const wire = await frontendWire();
    const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
    expect(wire.map(key).sort()).toEqual(routes.map(key).sort());
  });

  test("every request body carries exactly the backend model's fields", async () => {
    const wire = await frontendWire();
    const byPath = new Map(wire.map((w) => [`${w.method} ${w.path}`, w]));
    for (const route of routes) {
      const w = byPath.get(`${route.method} ${route.path}`);
      expect(w).toBeDefined();
      const expected = route.bodyModel ? modelFields(src, route.bodyModel).sort() : [];
      expect(w!.bodyKeys).toEqual(expected);
    }
  });

  test("the port/starboard direction set matches _DIRECTIONS", () => {
    const backend = backendDirections(src).sort();
    expect(frontendDirections().sort()).toEqual(backend);
    // and the client actually emits both, unchanged, into the split path
    for (const dir of backend as Direction[]) {
      const calls: string[] = [];
      const fetch = (url: string) => {
        calls.push(url);
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) } as Response);
      };
      const c = createAutopilotClient({ fetch });
      void c.tack(dir);
      expect(calls[0]).toBe(`/api/autopilot/tack/${dir}`);
    }
  });
});
