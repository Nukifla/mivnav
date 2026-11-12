# SPDX-License-Identifier: GPL-2.0-only
"""The GNSS-lost watch, on the always-on server.

:class:`~mivnav.signalk.service.SignalKService` marks the snapshot
``fixLost`` once the own ship has sent no position for
:attr:`.config.GnssConfig.delay_s` while SignalK is connected;
:class:`.publisher.GnssPublisher` raises and clears that on SignalK as
``notifications.navigation.gnss.fixLost``, so it reaches every display and
keeps watching with every browser closed — the collision publisher's
pattern. The two *link* alarms (a screen losing the mivnav server, the
server losing SignalK) can only be raised in the browser.

No re-exports, for the reason :mod:`mivnav.collision` gives:
``mivnav.config.model`` imports ``.config``.
"""
