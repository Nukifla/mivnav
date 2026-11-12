# SPDX-License-Identifier: GPL-2.0-only
"""The shallow-water watch, on the always-on server.

The assessment rides every SignalK snapshot (:class:`.watch.ShallowWatch`,
hooked into :class:`~mivnav.signalk.service.SignalKService` next to the
collision assessment), so every screen shows the same depth alarm;
:class:`.publisher.ShallowPublisher` raises and clears it on SignalK as
``notifications.environment.depth.shallowWater``, the same way the
collision alarm is published (:mod:`mivnav.collision`).

No re-exports: ``mivnav.config.model`` imports ``.config``.
"""
