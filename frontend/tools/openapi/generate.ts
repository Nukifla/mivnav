/**
 * OpenAPI TypeScript generator: emits `src/api.generated.ts` — the request
 * (and, once the backend follow-on lands, response) types for `/api/*`,
 * generated from the backend's own OpenAPI schema rather than hand-mirrored.
 *
 * ## Why two steps, not one `bun run` like the other generators
 *
 * `tools/mid-table` and `tools/themes` each read their source directly (an
 * HTTP fetch, a `readdirSync` over committed JSON) from plain TypeScript.
 * This generator's source is `mivnav.api.app.openapi()` — FastAPI's own
 * schema, built from the route/pydantic declarations, which only Python can
 * produce. So the pipeline is two commands:
 *
 *   1. `just openapi-schema` — imports `mivnav.api.app` (NO running server;
 *      see `backend/tools/dump_openapi_schema.py`) and writes
 *      `tools/openapi/schema.json`, a gitignored build intermediate (same
 *      role as `tools/s52-colors/.cache/`) — not a source of truth itself.
 *   2. `bun run api` (this file) reads that JSON and runs it through
 *      `openapi-typescript`, writing the COMMITTED `src/api.generated.ts`.
 *
 * `generate()` is exported so `../../src/api.generated.test.ts` can call the
 * exact same transform against a FRESHLY dumped schema (that test shells out
 * to step 1 itself — see its header for why that's safe here) and diff it
 * against the committed file, the same "byte-for-byte, re-run after
 * changing the source" drift check `themes/build-theme-bundle.ts` uses.
 *
 * Regenerate:  just openapi-schema && cd frontend && bun run api
 * Validate:    cd frontend && bun test src/api.generated.test.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString, COMMENT_HEADER, type OpenAPI3 } from "openapi-typescript";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));

/** Written by `just openapi-schema`; gitignored (see `../../.gitignore`). */
export const SCHEMA_FILE = join(TOOL_DIR, "schema.json");
const OUT_FILE = join(TOOL_DIR, "..", "..", "src", "api.generated.ts");

/** Schema JSON -> the exact TypeScript source `bun run api` writes. Pure
 * (given a schema object), so the drift test can call it against a freshly
 * dumped schema without touching `SCHEMA_FILE` or `OUT_FILE`. */
export async function generate(schema: OpenAPI3): Promise<string> {
  return `${COMMENT_HEADER}${astToString(await openapiTS(schema))}`;
}

if (import.meta.main) {
  const schema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as OpenAPI3;
  const out = await generate(schema);
  writeFileSync(OUT_FILE, out);
  console.log(`wrote ${OUT_FILE}`);
}
