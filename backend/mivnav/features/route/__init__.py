# SPDX-License-Identifier: GPL-2.0-only
"""Sailing routes: the ``/routes`` HTTP surface, the route/active-leg store,
and route following (write/auto-advance to SignalK).

Deliberately no re-exports here: ``mivnav.config.model`` imports ``.config``,
which runs this ``__init__.py`` first, so an eager re-export chain would
drag half the feature into the middle of ``mivnav.config.model``'s own
initialization. Import submodules directly (``.store``, ``.client``, ...);
see docs/architecture/feature-package-boundaries.md for the module map.
"""
