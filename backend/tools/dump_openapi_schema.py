#!/usr/bin/env python
# SPDX-License-Identifier: GPL-2.0-only
"""Dump the backend's OpenAPI schema — NO running server needed.

Imports `mivnav.api.app` (the FastAPI app FastAPI itself builds the schema
from route declarations, so this is exactly what `GET /openapi.json` would
serve, without paying for a live server) and calls its own `.openapi()`.

Used by `just openapi-schema` (writes `frontend/tools/openapi/schema.json`,
a gitignored build intermediate) and by the frontend's own drift test
(`frontend/src/api.generated.test.ts`), which shells out to this script
directly to get a FRESH schema to compare the committed
`src/api.generated.ts` against — so a route/body change that isn't
reflected in a regenerated `api.generated.ts` fails `just check`, not just
`bun run api`.

    uv run python tools/dump_openapi_schema.py [output-file]

No argument: writes to stdout. `app`, not `served_app` — `served_app` only
mounts `app` under `/api` for production serving (see api/app.py); `app`'s
own paths ("/config", "/routes", …) are the ones every route module and the
frontend actually declare and call against.
"""

from __future__ import annotations

import json
import sys

from mivnav import plugins

# The schema (and so the frontend's committed api.generated.ts) describes the
# core API only — never whatever plugins this checkout happens to have.
plugins.disable()

from mivnav.api.app import app  # noqa: E402


def main() -> None:
    text = json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n"
    if len(sys.argv) > 1:
        with open(sys.argv[1], "w") as f:
            f.write(text)
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
