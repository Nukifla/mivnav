# SPDX-License-Identifier: GPL-2.0-only
"""Allow-list sanitising of Niord's HTML (part details, ``publication``).

Niord's text is authored in a WYSIWYG editor and often pasted from Word:
``<o:p>``, ``style=``, ``class="MsoNormal"``, ``<span>`` wrappers. The
frontend renders it as HTML, so it is cleaned here once, at normalisation,
with an ALLOW-list (nh3 — the ammonia sanitiser): anything not listed is
dropped (its text kept), ``script``/``style`` contents dropped entirely.

Kept: ``p br ul ol li table thead tbody tr td th strong b em i a``;
``a[href]`` only for http/https/mailto (relative links are made absolute
against the Niord host first — a relative link would otherwise resolve
against OUR origin); ``td/th[colspan,rowspan]``; and on ``table`` only the
class ``position-table`` (Niord's numbered-positions table, which the
detail panel styles).
"""

from __future__ import annotations

import re

import nh3

TAGS = frozenset(
    {
        "p", "br", "ul", "ol", "li",
        "table", "thead", "tbody", "tr", "td", "th",
        "strong", "b", "em", "i", "a",
    }
)
ATTRIBUTES = {
    "a": {"href"},
    "table": {"class"},
    "td": {"colspan", "rowspan"},
    "th": {"colspan", "rowspan"},
}
URL_SCHEMES = frozenset({"http", "https", "mailto"})
KEPT_TABLE_CLASS = "position-table"

_REL_HREF = re.compile(r"""(href\s*=\s*["'])(/[^/"'][^"']*)""", re.IGNORECASE)
_EMPTY_P = re.compile(r"<p>(?:\s|&nbsp;| |<br>)*</p>")


def _filter(tag: str, attr: str, value: str) -> str | None:
    if tag == "table" and attr == "class":
        return KEPT_TABLE_CLASS if KEPT_TABLE_CLASS in value.split() else None
    return value


def sanitize_html(html: str | None, base_url: str = "") -> str | None:
    """Clean ``html``; ``None`` for nothing left (``None``/blank input, or
    markup with no text)."""
    if html is None or not html.strip():
        return None
    if base_url:
        html = _REL_HREF.sub(lambda m: m.group(1) + base_url.rstrip("/") + m.group(2), html)
    cleaned = nh3.clean(
        html,
        tags=set(TAGS),
        attributes={k: set(v) for k, v in ATTRIBUTES.items()},
        url_schemes=set(URL_SCHEMES),
        attribute_filter=_filter,
        link_rel="noopener noreferrer",
    )
    cleaned = _EMPTY_P.sub("", cleaned).strip()
    return cleaned or None
