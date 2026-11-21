# SPDX-License-Identifier: GPL-2.0-only
"""The ``mivport`` config slice (``Config.mivport``): where the mivport
server is. A LEAF module — Config imports it, so it imports nothing else
from its feature."""

from __future__ import annotations

from pydantic import Field, field_validator

from mivnav.config.base import Frozen

DEFAULT_BASE_URL = "https://mivport.nukifla.com"


def _http_url(value: str) -> str:
    value = value.strip().rstrip("/")
    if value and not value.startswith(("http://", "https://")):
        raise ValueError("must be an http(s) URL")
    return value


class MivportConfig(Frozen):
    #: The mivport server: ``/v1/...`` and ``/exports/...`` hang off it.
    base_url: str = Field(default=DEFAULT_BASE_URL, min_length=1)
    #: A mivport web client; when set, a place's details link to
    #: ``<web_url>/#place=<id>``. Empty: no link.
    web_url: str = DEFAULT_BASE_URL

    @field_validator("base_url", "web_url")
    @classmethod
    def _urls(cls, value: str) -> str:
        return _http_url(value)
