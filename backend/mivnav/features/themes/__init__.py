# SPDX-License-Identifier: GPL-2.0-only
"""The ``themes`` feature: the 12 visual palettes, as data the boat serves.

Runtime-updatable is the point: nothing here is ``@lru_cache``\\ d, so
editing a theme JSON on the boat's Pi takes effect on the next request.
``~/.config/mivnav/themes/<id>.json`` shadows a built-in palette of the same
id. See docs/architecture/themes-runtime-updatable.md.
"""
