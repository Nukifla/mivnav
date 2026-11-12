# SPDX-License-Identifier: GPL-2.0-only
"""Anchor watch, as a front-end to SignalK's anchoralarm plugin (anchor.md).

Only the write half lives here; the read half is
:mod:`mivnav.signalk.anchor`, embedded in the tracker for the same reason
the autopilot's is (docs/architecture/feature-package-boundaries.md).
"""
