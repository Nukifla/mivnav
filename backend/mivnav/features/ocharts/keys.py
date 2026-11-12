# SPDX-License-Identifier: GPL-2.0-only
"""Chart-set key/metadata provisioning. Port of ochartsng's ChartSetInfo
(provider/src/ChartSetInfo.cpp). See
docs/architecture/ocharts-key-provisioning.md for the file formats and
key-resolution order.
"""

from __future__ import annotations

import logging
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)

LEGACY_CHARTINFO = "Chartinfo.txt"


@dataclass
class SetInfo:
    """License keys and display metadata parsed from a set directory."""

    directory: Path
    title: str = ""
    edition: str = ""
    valid_to: str = ""  # YYYY-MM-DD, empty if unknown
    user_key: str = ""  # set-wide key (legacy Chartinfo.txt)
    chart_keys: dict[str, str] = field(default_factory=dict)  # basename -> RInstallKey

    def key_for(self, cell_path: Path) -> str:
        """Key for one cell file: per-cell key, else the set-wide key."""
        return self.chart_keys.get(cell_path.stem, self.user_key)


def _parse_keylist(root: ET.Element, info: SetInfo) -> None:
    for chart in root.findall("Chart"):
        name = chart.findtext("FileName", "").strip()
        key = chart.findtext("RInstallKey")
        if name and key is not None:
            info.chart_keys[name] = key.strip()
    info.title = info.title or root.findtext("ChartInfo", "").strip()
    info.edition = info.edition or root.findtext("Edition", "").strip()
    exp = root.findtext("ExpirationDate", "").strip()
    if exp and not info.valid_to:
        try:
            info.valid_to = time.strftime("%Y-%m-%d", time.localtime(int(exp)))
        except (ValueError, OverflowError, OSError):
            pass


def _parse_chartinfo_txt(path: Path, info: SetInfo) -> None:
    for line in path.read_text(errors="replace").splitlines():
        name, sep, value = line.partition(":")
        if not sep:
            continue
        value = value.strip()
        if name == "UserKey":
            info.user_key = value
        elif name == "ChartInfo":
            parts = value.split(";")
            if parts and not info.title:
                info.title = parts[0]
            if len(parts) >= 2 and not info.edition:
                # reference converts edition "2021-21" to "2021/01-21"
                ep = parts[1].split("-")
                info.edition = f"{ep[0]}/01-{ep[1]}" if len(ep) == 2 else parts[1]
            if len(parts) >= 3 and not info.valid_to:
                info.valid_to = parts[2]


def parse_set_info(directory: Path) -> SetInfo:
    """Parse license keys and metadata from a chart-set directory."""
    info = SetInfo(directory=directory)
    for xml_path in sorted(directory.glob("*.xml")) + sorted(directory.glob("*.XML")):
        try:
            root = ET.parse(xml_path).getroot()
        except ET.ParseError as e:
            log.warning("unparseable xml %s: %s", xml_path, e)
            continue
        if root.tag == "keyList":
            _parse_keylist(root, info)
        elif root.tag == "chartList" and not info.edition:
            info.edition = root.findtext("Edition", "").strip()
    legacy = directory / LEGACY_CHARTINFO
    if legacy.is_file():
        try:
            _parse_chartinfo_txt(legacy, info)
        except OSError as e:
            log.warning("unreadable %s: %s", legacy, e)
    return info
