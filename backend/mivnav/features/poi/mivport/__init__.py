# SPDX-License-Identifier: GPL-2.0-only
"""mivport (the sailors' place database, github.com/Nukifla/mivport) as a
built-in POI source beside OpenStreetMap:

- :mod:`.source` bakes a region from mivport's offline exports, caught up
  through ``/v1/changes``, with every place's details, reviews and photos
  kept on the boat;
- :mod:`.routes` serves them offline (``/poi/mivport/...``);
- :mod:`.config` is the ``Config.mivport`` slice.
"""
