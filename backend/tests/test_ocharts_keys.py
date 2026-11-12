# SPDX-License-Identifier: GPL-2.0-only
"""Key/metadata provisioning: keys.xml, Chartinfo.txt, key resolution."""

from pathlib import Path

from mivnav.features.ocharts.keys import parse_set_info

KEYS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<keyList>
  <Chart>
    <Name></Name>
    <FileName>OC-358-LM1JE4</FileName>
    <ID>FI4EJ1ML</ID>
    <RInstallKey>VerySecretKey</RInstallKey>
  </Chart>
  <Chart>
    <FileName>OC-358-XY99Z1</FileName>
    <RInstallKey>OtherKey</RInstallKey>
  </Chart>
  <ChartInfo>Finnland 2022</ChartInfo>
  <Edition>2022/10-25</Edition>
  <ExpirationDate>1693649994</ExpirationDate>
</keyList>
"""

CHARTINFO_TXT = """ChartInfo:Deutsche Gewässer 2020;2020-13;2021-03-28
UserKey:abcdef012345
ChartInfoShow:Session
"""


def test_keylist_parsing(tmp_path: Path) -> None:
    (tmp_path / "keys.xml").write_text(KEYS_XML)
    info = parse_set_info(tmp_path)
    assert info.chart_keys == {
        "OC-358-LM1JE4": "VerySecretKey",
        "OC-358-XY99Z1": "OtherKey",
    }
    assert info.title == "Finnland 2022"
    assert info.edition == "2022/10-25"
    assert info.valid_to.startswith("2023-")  # unix 1693649994 = 2023-09-02


def test_key_resolution_per_cell_then_userkey(tmp_path: Path) -> None:
    (tmp_path / "keys.xml").write_text(KEYS_XML)
    (tmp_path / "Chartinfo.txt").write_text(CHARTINFO_TXT)
    info = parse_set_info(tmp_path)
    assert info.key_for(Path("OC-358-LM1JE4.oesu")) == "VerySecretKey"
    # unknown cell falls back to the set-wide UserKey
    assert info.key_for(Path("OC-358-UNKNOWN.oesu")) == "abcdef012345"


def test_legacy_chartinfo_only(tmp_path: Path) -> None:
    (tmp_path / "Chartinfo.txt").write_text(CHARTINFO_TXT)
    info = parse_set_info(tmp_path)
    assert info.user_key == "abcdef012345"
    assert info.title == "Deutsche Gewässer 2020"
    assert info.edition == "2020/01-13"  # reference's 2020-13 → 2020/01-13
    assert info.valid_to == "2021-03-28"


def test_chartlist_edition_fallback(tmp_path: Path) -> None:
    (tmp_path / "ChartList.XML").write_text(
        "<chartList><Chart><ID>X</ID></Chart><Edition>2022/10-25</Edition></chartList>"
    )
    info = parse_set_info(tmp_path)
    assert info.edition == "2022/10-25"
    assert info.chart_keys == {}


def test_unparseable_xml_is_skipped(tmp_path: Path) -> None:
    (tmp_path / "keys.xml").write_text("<keyList><unclosed>")
    info = parse_set_info(tmp_path)
    assert info.chart_keys == {}
