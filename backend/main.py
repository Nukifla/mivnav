# SPDX-License-Identifier: GPL-2.0-only
# Entrypoint shim so `uv run fastapi dev`/`fastapi run` finds the app.
# `served_app` is the full server (API under /api + built SPA at /); tests
# import the inner `app` (API at its root paths) directly.
from mivnav.api.app import served_app as app

__all__ = ["app"]
