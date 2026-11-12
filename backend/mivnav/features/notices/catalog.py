# SPDX-License-Identifier: GPL-2.0-only
"""The notices SOURCE catalog: which publishers' notices a dataset can
hold, and the regions each one offers.

A notices dataset names one source (``DatasetConfig.implementation``) and a
subset of its regions (``params.regions``). Regions are a publisher's own
areas of responsibility, not bounding boxes — Niord files every message
under an area tree rooted at a country — so they are this catalog's ids,
not ``Config.regions`` entries. Adding a country later (a Swedish or German
source, should one ever publish a machine-readable feed — efs.md §1.1 found
none today) is a new :class:`NoticeSource` here plus its fetcher; the
Datasets tab reads ``GET /notices/sources`` and needs no change.

Faroe Islands: Niord has a Faroe area (``urn:mrn:iho:country:fo``) but no
messages in it — none in any public domain's feed, and the message search
for that area returned 0 hits (checked 2026-10-03) — so it is not offered: a
region that can only ever be empty would read as "covered" when it is not.
"""

from __future__ import annotations

from dataclasses import dataclass

from mivnav.features.notices.ids import REGION_DK, REGION_GL, SOURCE_DK_NIORD


@dataclass(frozen=True)
class NoticeRegion:
    id: str
    label: str
    description: str


@dataclass(frozen=True)
class NoticeSource:
    id: str
    label: str
    publisher: str
    regions: tuple[NoticeRegion, ...]

    @property
    def region_ids(self) -> tuple[str, ...]:
        return tuple(r.id for r in self.regions)

    def summary(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "publisher": self.publisher,
            "regions": [
                {"id": r.id, "label": r.label, "description": r.description}
                for r in self.regions
            ],
        }


SOURCES: dict[str, NoticeSource] = {
    SOURCE_DK_NIORD: NoticeSource(
        id=SOURCE_DK_NIORD,
        label="Danish notices to mariners (Niord)",
        publisher="Danish Maritime Authority / Beredskabsstyrelsen",
        regions=(
            NoticeRegion(
                REGION_DK,
                "Denmark",
                "Danish waters: Efterretninger for Søfarende, navigational warnings, "
                "firing exercises and firing areas, EfS A/B",
            ),
            NoticeRegion(
                REGION_GL,
                "Greenland",
                "Greenland notices to mariners and navigational warnings",
            ),
        ),
    ),
}

DEFAULT_SOURCE = SOURCE_DK_NIORD

#: What the dataset list shows per source.
IMPLEMENTATION_LABELS: dict[str, str] = {
    SOURCE_DK_NIORD: "Notices to mariners (DK)",
}


def resolve_source(implementation: str | None) -> NoticeSource:
    """The source a dataset's ``implementation`` names (``None`` = the
    default). Raises ``ValueError`` for an unknown one (→ 422)."""
    source_id = implementation or DEFAULT_SOURCE
    try:
        return SOURCES[source_id]
    except KeyError:
        raise ValueError(
            f"unknown notices source {source_id!r} (known: {', '.join(SOURCES)})"
        ) from None
