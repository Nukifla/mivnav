# SPDX-License-Identifier: GPL-2.0-only
"""Notices source and region ids — bare constants with NO imports, so the
config slice (:mod:`.config`, loaded by ``mivnav.config.model``), the
catalog and the normaliser can all name them without an import cycle
through ``mivnav.config``."""

#: The Danish Niord source (``DatasetConfig.implementation``).
SOURCE_DK_NIORD = "dk-niord"
#: Its regions (``params.regions``): Danish waters, Greenland.
REGION_DK = "dk"
REGION_GL = "gl"
