# SPDX-License-Identifier: GPL-2.0-only
"""The collision (CPA/TCPA) watch, on the always-on server.

The assessment rides every SignalK snapshot (:func:`.assess.assess`, hooked
into :class:`~mivnav.signalk.service.SignalKService`), so every screen shows
the same threat; :class:`.publisher.CollisionPublisher` raises and clears it
on SignalK as ``notifications.navigation.closestApproach.<vessel>`` so the
alarm also reaches the MFD (via the N2K emitter), KIP and Freeboard, and
keeps watching with every browser closed. See docs/architecture/cpa-backend.md.

No re-exports, for the reason :mod:`mivnav.features.route` gives:
``mivnav.config.model`` imports ``.config``.
"""
