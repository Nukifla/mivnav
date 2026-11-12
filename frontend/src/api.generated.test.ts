/**
 * THE DRIFT GUARD for `api.generated.ts` — the same shape as
 * `themes/index.test.ts`'s "byte-for-byte the same values" check, adapted to
 * a source that lives in Python rather than committed JSON.
 *
 * `api.generated.ts` is produced by two steps (see `tools/openapi/generate.ts`):
 * `just openapi-schema` dumps `mivnav.api.app.openapi()` to a gitignored JSON
 * file, then `bun run api` runs it through `openapi-typescript`. Editing a
 * route/pydantic model without re-running both leaves the frontend typing
 * against a stale contract — invisible until a real mismatch 422s at runtime.
 *
 * This test closes that gap WITHOUT needing the gitignored intermediate file
 * to exist: it shells out to the same `dump_openapi_schema.py` that
 * `just openapi-schema` calls (via `uv run python`, from `backend/`) to get a
 * FRESH schema straight from the source, runs it through the exact same
 * `generate()` `bun run api` uses, and compares the result to the committed
 * file byte-for-byte.
 *
 * Spawning `uv run python` from a frontend test is new for this tree (every
 * other generated-file test reads a local file or a network fetch instead —
 * see CLAUDE.md's generator notes) but not a stretch: `just check` already
 * requires both toolchains, runs `test-backend` (which syncs the backend venv)
 * BEFORE `test-frontend`, and the whole point of this generator is that the
 * two languages share one contract. A missing/broken `uv` fails this ONE test
 * with the subprocess's own stderr, not the rest of the suite.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenAPI3 } from "openapi-typescript";
import { generate } from "../tools/openapi/generate";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SRC_DIR, "..", "..");
const BACKEND_DIR = join(REPO_ROOT, "backend");
const GENERATED_FILE = join(SRC_DIR, "api.generated.ts");

/** Fresh schema straight from `mivnav.api.app`, via the exact script
 * `just openapi-schema` runs — no running server, no gitignored intermediate
 * file required. */
function dumpSchemaFresh(): OpenAPI3 {
  const result = Bun.spawnSync({
    cmd: ["uv", "run", "python", "tools/dump_openapi_schema.py"],
    cwd: BACKEND_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `uv run python tools/dump_openapi_schema.py (in ${BACKEND_DIR}) failed:\n${result.stderr.toString("utf8")}`,
    );
  }
  return JSON.parse(result.stdout.toString("utf8")) as OpenAPI3;
}

describe("api.generated.ts", () => {
  test("byte-for-byte the same as a fresh `just openapi-schema && bun run api`", async () => {
    const schema = dumpSchemaFresh();
    const fresh = await generate(schema);
    const committed = readFileSync(GENERATED_FILE, "utf8");
    // Deliberately a plain string diff, not a semantic one: this must fail on
    // an openapi-typescript version bump or a flag change too, not just a
    // backend contract change — both mean the committed file no longer
    // matches what `bun run api` would produce today.
    expect(fresh).toEqual(committed);
  });
});
