# SPDX-License-Identifier: GPL-2.0-only
"""The server's own software: which version is running, how it was
installed, and the release updater it can hand off to.

Not a feature (no data provider, no ``/providers`` row) and not composition
either: pure mechanics the ``/system`` router (``mivnav.api.system``) wires
up. The updater itself is ``deploy/update.sh``, run by systemd as the
template unit ``mivnav-update@<arg>.service`` — this package only *starts*
it and reads the status file it writes; it never touches a release
directory itself.
"""

from mivnav.system.install import InstallInfo, SystemPaths, current_version, install_info
from mivnav.system.updates import (
    IN_PROGRESS_STATES,
    LatestRelease,
    ReleaseCheck,
    UpdateChecker,
    UpdateStatus,
    compare_versions,
    parse_version,
    read_status,
    start_unit,
    update_unit,
    valid_target,
)

__all__ = [
    "IN_PROGRESS_STATES",
    "InstallInfo",
    "LatestRelease",
    "ReleaseCheck",
    "SystemPaths",
    "UpdateChecker",
    "UpdateStatus",
    "compare_versions",
    "current_version",
    "install_info",
    "parse_version",
    "read_status",
    "start_unit",
    "update_unit",
    "valid_target",
]
