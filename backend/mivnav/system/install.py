# SPDX-License-Identifier: GPL-2.0-only
"""Which version is running, and whether this is a release install the
updater can manage or a source checkout it must leave alone.

A release bundle carries a top-level ``VERSION`` file (the tag without its
``v``); a source checkout has none and reports ``"dev"``. The release
directory is found the same way ``mivnav.api.app`` finds ``frontend/dist``
— ``Path(__file__).resolve().parents[N]`` — which resolves *through* the
``/opt/mivnav/current`` symlink to ``/opt/mivnav/releases/<version>``. That
resolved path is also the install-kind test: code living under the releases
root is a release install.

Every location is a field of :class:`SystemPaths` so a test can point it
all at a temporary tree; nothing here is read at import time.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

#: The release directory of the running code: ``backend/mivnav/system/`` is
#: three levels below it (the same root ``mivnav.api.app`` serves the SPA from).
APP_DIR = Path(__file__).resolve().parents[3]

#: Where ``deploy/install.sh`` unpacks releases (one directory per version).
RELEASES_ROOT = Path("/opt/mivnav/releases")

#: The updater's template unit, wherever systemd may have it installed.
#: ``install.sh`` writes the first; the others are packaging conventions.
UPDATE_UNIT_FILES = (
    Path("/etc/systemd/system/mivnav-update@.service"),
    Path("/usr/lib/systemd/system/mivnav-update@.service"),
    Path("/lib/systemd/system/mivnav-update@.service"),
)

#: Written by ``update.sh`` (atomically), read here — never written here.
STATUS_FILE = Path("/var/lib/mivnav/update/status.json")

#: What a source checkout reports instead of a release version.
DEV_VERSION = "dev"

InstallKind = Literal["release", "source"]


@dataclass(frozen=True)
class SystemPaths:
    """Every filesystem location the ``/system`` endpoints look at."""

    app_dir: Path = APP_DIR
    releases_root: Path = RELEASES_ROOT
    update_unit_files: tuple[Path, ...] = field(default=UPDATE_UNIT_FILES)
    status_file: Path = STATUS_FILE


@dataclass(frozen=True)
class InstallInfo:
    version: str
    install: InstallKind
    can_update: bool
    #: Short git commit of a source checkout, when it can be read; ``None``
    #: for a release (its version says it all) or a tree with no ``.git``.
    commit: str | None = None


def current_version(app_dir: Path = APP_DIR) -> str:
    """The ``VERSION`` file's contents, or ``"dev"`` when there is none."""
    try:
        version = (app_dir / "VERSION").read_text(encoding="utf-8").strip()
    except OSError:
        return DEV_VERSION
    return version or DEV_VERSION


def _is_release_install(paths: SystemPaths) -> bool:
    try:
        app = paths.app_dir.resolve()
        root = paths.releases_root.resolve()
    except OSError:
        return False
    return app != root and app.is_relative_to(root)


def git_commit(repo: Path) -> str | None:
    """The checked-out commit of a git (or jj-colocated) checkout, read
    straight from ``.git`` — no ``git`` subprocess on a request path."""
    git = repo / ".git"
    try:
        head = (git / "HEAD").read_text(encoding="utf-8").strip()
        if head.startswith("ref: "):
            ref = head.removeprefix("ref: ").strip()
            ref_file = git / ref
            if ref_file.is_file():
                head = ref_file.read_text(encoding="utf-8").strip()
            else:
                head = ""
                packed = git / "packed-refs"
                for line in packed.read_text(encoding="utf-8").splitlines():
                    parts = line.split()
                    if len(parts) == 2 and parts[1] == ref:
                        head = parts[0]
                        break
    except OSError:
        return None
    if len(head) < 7 or any(c not in "0123456789abcdef" for c in head):
        return None
    return head[:12]


def install_info(paths: SystemPaths) -> InstallInfo:
    """``can_update`` needs both a release install AND the updater unit:
    a release unpacked by hand, without ``install.sh``, has nothing to
    hand the update to."""
    release = _is_release_install(paths)
    unit_installed = any(p.is_file() for p in paths.update_unit_files)
    return InstallInfo(
        version=current_version(paths.app_dir),
        install="release" if release else "source",
        can_update=release and unit_installed,
        commit=None if release else git_commit(paths.app_dir),
    )
