# SPDX-License-Identifier: GPL-2.0-only
"""Pydantic models of the raw Niord JSON — exactly the fields
:mod:`mivnav.features.notices.normalize` reads, nothing more.

Tolerant on purpose (``extra="allow"``, everything optional that the
public data does not always carry): Niord is someone else's server and a
new field there must never break the boat's feed. One message that does
not validate is skipped with a log line, never the whole feed (see
:func:`parse_messages`).

Field names follow Niord's ``MessageVo`` family
(github.com/NiordOrg/niord, niord-model ``org.niord.model.message``).
Geometry stays a plain GeoJSON dict — it is walked, not modelled.
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError

log = logging.getLogger(__name__)


class _Raw(BaseModel):
    model_config = ConfigDict(extra="allow")


class NameDesc(_Raw):
    lang: str | None = None
    name: str | None = None


class Area(_Raw):
    id: int | None = None
    mrn: str | None = None
    descs: list[NameDesc] = []
    parent: Area | None = None


class Category(_Raw):
    id: int | None = None
    descs: list[NameDesc] = []
    parent: Category | None = None


class Chart(_Raw):
    chartNumber: str | None = None
    internationalNumber: int | None = None
    scale: int | None = None


class ReferenceDesc(_Raw):
    lang: str | None = None
    description: str | None = None


class Reference(_Raw):
    messageId: str
    type: str | None = None
    descs: list[ReferenceDesc] = []


class AttachmentDesc(_Raw):
    lang: str | None = None
    caption: str | None = None


class Attachment(_Raw):
    type: str | None = None
    path: str | None = None
    fileName: str | None = None
    fileSize: int | None = None
    descs: list[AttachmentDesc] = []


class EventDate(_Raw):
    fromDate: int | None = None
    toDate: int | None = None
    allDay: bool | None = None


class PartDesc(_Raw):
    lang: str | None = None
    subject: str | None = None
    details: str | None = None


class Part(_Raw):
    indexNo: int | None = None
    type: str | None = None
    eventDates: list[EventDate] = []
    geometry: dict[str, Any] | None = None
    descs: list[PartDesc] = []
    hideSubject: bool | None = None


class MessageDesc(_Raw):
    lang: str | None = None
    title: str | None = None
    vicinity: str | None = None
    publication: str | None = None
    source: str | None = None


class Series(_Raw):
    seriesId: str | None = None


class Message(_Raw):
    id: str
    shortId: str | None = None
    number: int | None = None
    mainType: str | None = None
    type: str | None = None
    status: str | None = None
    messageSeries: Series | None = None
    areas: list[Area] = []
    categories: list[Category] = []
    charts: list[Chart] = []
    publishDateFrom: int | None = None
    publishDateTo: int | None = None
    originalInformation: bool | None = None
    references: list[Reference] = []
    attachments: list[Attachment] = []
    horizontalDatum: str | None = None
    created: int | None = None
    updated: int | None = None
    descs: list[MessageDesc] = []
    parts: list[Part] = []

    @property
    def series_id(self) -> str | None:
        return self.messageSeries.seriesId if self.messageSeries else None


class FiringPeriod(_Raw):
    fromDate: int | None = None
    toDate: int | None = None


class FiringAreaPeriods(_Raw):
    """One entry of the (unofficial) ``/rest/firing-schedules/
    search-firing-area-periods`` answer: a firing AREA and its periods on
    the asked day (niord-core ``FiringAreaPeriodsVo``)."""

    area: Area
    firingPeriods: list[FiringPeriod] = []


def parse_messages(raw: object) -> list[Message]:
    """Validate a feed's JSON list, skipping (and logging) any message that
    does not fit — one malformed message must not cost the whole feed."""
    if not isinstance(raw, list):
        raise ValueError(f"expected a JSON list of messages, got {type(raw).__name__}")
    out: list[Message] = []
    for item in raw:
        try:
            out.append(Message.model_validate(item))
        except ValidationError as e:
            ident = item.get("id") if isinstance(item, dict) else None
            log.warning("notices: skipping malformed Niord message %s: %s", ident, e)
    return out


def parse_periods(raw: object) -> list[FiringAreaPeriods]:
    if not isinstance(raw, list):
        raise ValueError(f"expected a JSON list of firing areas, got {type(raw).__name__}")
    out: list[FiringAreaPeriods] = []
    for item in raw:
        try:
            out.append(FiringAreaPeriods.model_validate(item))
        except ValidationError as e:
            log.warning("notices: skipping malformed firing-area entry: %s", e)
    return out
