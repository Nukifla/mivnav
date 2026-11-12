# SPDX-License-Identifier: GPL-2.0-only
"""Subject class (``cls``) and sub-class (``sub``) of a Niord message.

Two sources, in order:

1. ``categories[]`` — authoritative when present, but Niord DK only puts
   categories on warnings and firing exercises (48 of 277 messages on
   2026-10-03). Mapped by category NAME (English, else Danish), never by id:
   ids differ between Niord installs. The tree is Niord DK's own
   (``/rest/categories``, mirrored in :data:`CATEGORY_TABLE`).
2. A regex table over the message's SUBJECT text — the Danish part
   subjects ("Fyr slukket", "Anlægsarbejde. Arbejdsområde oprettet"), else
   the Danish title with its area/locality prefix stripped; English as a
   fallback when Danish is missing. Titles are very regular
   ("Country. Area. Locality. Subject."), so the subject sentences carry
   the meaning and the locality must NOT be searched ("Kong Frederik IX's
   Bro. Anlægsarbejde." is works, not a bridge notice).

The first SENTENCE that matches any rule decides the class (rules tried in
table order within a sentence), because Niord writes the primary subject
first: "Tilsanding. Havn lukket for anløb. Afmærkning inddraget." is a
depth notice that also withdrew buoys.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

CLASSES = (
    "light", "buoy", "beacon", "wreck", "depth", "works", "survey", "dredging",
    "cable", "bridge", "farm", "firing", "exercise", "drifting", "radionav",
    "general", "other",
)
SUBCLASSES = (
    "missing", "off-station", "established", "withdrawn", "replaced", "unlit",
    "unreliable", "changed", "damaged", "lit", "moved", "reduced", "normal",
    "completed",
)

# -- 1. categories ---------------------------------------------------------

#: (Danish name, English name, cls, sub). Leaves first; a root row is the
#: fallback for a leaf not listed (a category Niord adds later).
CATEGORY_TABLE: tuple[tuple[str, str, str, str | None], ...] = (
    ("Fyr uregelmæssig", "Light unreliable", "light", "unreliable"),
    ("Fyr slukket", "Light unlit", "light", "unlit"),
    ("Fyr ødelagt", "Light damaged", "light", "damaged"),
    ("Lystønde forsvundet", "Light buoy missing", "buoy", "missing"),
    ("Lystønde ikke på plads og i orden", "Light buoy off station", "buoy", "off-station"),
    ("Lystønde slukket", "Light buoy unlit", "light", "unlit"),
    ("Lystønde uregelmæssig", "Light buoy unreliable", "light", "unreliable"),
    ("Lystønde etableret", "Light buoy established", "buoy", "established"),
    ("Lystønde erstattet", "Light buoy replaced", "buoy", "replaced"),
    ("Lystønde inddraget", "Light buoy withdrawn", "buoy", "withdrawn"),
    ("Båke forsvundet", "Beacon missing", "beacon", "missing"),
    ("Båke ødelagt", "Beacon damaged", "beacon", "damaged"),
    ("Båke delvis skjult", "Beacon partly obscured", "beacon", None),
    ("Dagsømærke forsvundet", "Buoy missing", "buoy", "missing"),
    ("Dagsømærke ikke på plads og i orden", "Buoy off station", "buoy", "off-station"),
    ("Dagsømærke etableret", "Buoy established", "buoy", "established"),
    ("Dagsømærke erstattet", "Buoy replaced", "buoy", "replaced"),
    ("Dagsømærke inddraget", "Buoy withdrawn", "buoy", "withdrawn"),
    ("Bjærgningsarbejde", "Salvage operations", "wreck", None),
    ("Vrag", "Wreck", "wreck", None),
    ("Ikke kortlagt sejladshindring", "Uncharted obstruction", "wreck", None),
    ("Reduceret vanddybde", "Reduced depth", "depth", "reduced"),
    ("Søopmåling", "Hydrographic survey", "survey", None),
    ("Kabelarbejde", "Cable operations", "cable", None),
    ("Undervandsundersøgelse", "Underwater survey", "survey", None),
    ("Dykkerundersøgelse", "Diving operations", "survey", None),
    ("Bro lukket for passage", "Bridge closed for passage", "bridge", None),
    ("Fyr væltet", "Light destroyed", "light", "damaged"),
    ("Øvelse", "Exercise", "exercise", None),
    ("Mine", "Mine", "wreck", None),
    ("Torpedo", "Torpedo", "wreck", None),
    ("Granat", "Grenade", "wreck", None),
    ("Drivende objekt", "Object adrift", "drifting", None),
    ("Drivende sømærke", "Buoy adrift", "drifting", None),
    ("RACON", "RACON", "radionav", None),
    ("AIS", "AIS", "radionav", None),
    ("DGPS", "DGPS", "radionav", None),
    ("Skydeøvelser", "Firing Exercises", "firing", None),
    # roots
    ("Fyr", "Light", "light", None),
    ("Lystønde", "Light buoy", "buoy", None),
    ("Båke", "Beacon", "beacon", None),
    ("Dagsømærke", "Buoy", "buoy", None),
    ("Sejladshindring", "Obstruction", "wreck", None),
    ("Drivende genstand", "Drifting object", "drifting", None),
    ("Radionavigation", "Radio navigation", "radionav", None),
)

_CATEGORY_INDEX: dict[str, tuple[str, str | None]] = {}
for _da, _en, _cls, _sub in CATEGORY_TABLE:
    _CATEGORY_INDEX.setdefault(_en.casefold(), (_cls, _sub))
    _CATEGORY_INDEX.setdefault(_da.casefold(), (_cls, _sub))


def classify_category(path_names: Sequence[Sequence[str]]) -> tuple[str, str | None] | None:
    """``path_names`` is one entry per category, each its names (any
    language) from the LEAF up to the root. The first category with a known
    leaf (else known ancestor) wins."""
    for names_by_level in path_names:
        for name in names_by_level:
            hit = _CATEGORY_INDEX.get(name.strip().casefold())
            if hit is not None:
                return hit
    return None


# -- 2. subject regexes ----------------------------------------------------


@dataclass(frozen=True)
class Rule:
    cls: str
    da: str
    en: str


#: Tried in order WITHIN one sentence; more specific subjects before the
#: generic ones they contain ("Kabelarbejde" before "arbejde",
#: "Afmærket havbrug" before "afmærket").
RULES: tuple[Rule, ...] = (
    Rule("firing", r"skydeøvelse|skydning", r"firing"),
    Rule("exercise", r"minelægning|minerydning|øvelse|militær", r"mine ?laying|mine ?clearance|exercise|military"),
    Rule(
        "general",
        r"^meddelelse til|sommertid|vintertid|gnss|gps|jamming|forstyrrelse",
        r"^notice to|summer ?time|winter ?time|gnss|gps|jamming|interference",
    ),
    Rule("drifting", r"drivende", r"adrift|drifting"),
    Rule(
        "radionav",
        r"racon|\bais\b|dgps|virtuel aton|radionavigation|loran",
        r"racon|\bais\b|dgps|virtual aton|radio ?navigation|loran",
    ),
    Rule(
        "wreck",
        r"vrag|sejladshindring|undervandshindring|gaslækage|bjærgning|hindring|mine\b|ammunition",
        r"wreck|obstruction|gas leak|salvage|mine\b|ammunition|munition",
    ),
    Rule("farm", r"havbrug|muslingeanlæg|muslingeline|fiskeopdræt|dambrug|tangdyrkning", r"marine farm|fish farm|mussel|seaweed"),
    Rule("cable", r"kabel|rørarbejde|rørledning|udløbsledning|\bledning", r"cable|pipe|outfall"),
    Rule("dredging", r"oprensning|uddybning|klapning|sandsugning|opgravning", r"dredg|dumping"),
    Rule(
        "survey",
        r"søopmåling|undersøgelse|boring|inspektion|\busv\b|\bauv\b|unmanned|måleudstyr|målebøje"
        r"|måleinstrument|dykkerarbejde|dykning|dykker|undervandsarbejde|langsomt passerende|testsejlads"
        r"|bølgemåler|forskning",
        r"survey|drilling|inspection|\busv\b|\bauv\b|unmanned|measuring|diving|divers?\b|underwater work"
        r"|slow.?moving|test sailing|research",
    ),
    Rule(
        "works",
        r"anlæg|arbejde|vedligehold|stenrev|bølgebryder|pælerække|flydebro|kystfodring|stendepot|tunnel"
        r"|containerkran|byggeri|nedramning|etablering af|vindmølle|mole\b|kaj\b|spuns|nedrivning|forbudsområde"
        r"|spærres|spærret|ponton|sænkekasse|fundament",
        r"construction|works?\b|maintenance|stone reef|breakwater|pile|pontoon|nourishment|tunnel|crane"
        r"|building|wind ?farm|wind turbine|demolition|prohibited area|caisson|foundation",
    ),
    Rule(
        "bridge",
        r"\bbro\b|anløbsbro|broklap|broen\b|gennemsejling|frihøjde|åbningstid|brofag|klapbro|broåbning",
        r"bridge|clearance|opening hours|operating hours",
    ),
    Rule("depth", r"dybde|tilsanding|vanddybde|lavvande|grund\b", r"depth|silting|shoal"),
    # A light buoy is a light while its LIGHT is the subject (unlit,
    # unreliable, relit), else a buoy — resolved in classify_subject.
    Rule("lightbuoy", r"lystønde|lysbøje", r"light buoy|lighted buoy"),
    Rule(
        "light",
        r"\bfyr\b|fyret|fyrlys|molefyr|tågelys|\blys\b|ledefyr|fyrlygte|sektorfyr|fyrlinje|lyset",
        r"\blights?\b|fog light|leading light|sector light|lantern",
    ),
    Rule("beacon", r"båke|varde|\bkost\b", r"beacon"),
    Rule(
        "buoy",
        r"afmærkning|afmærket|dagsømærke|sømærke|bøje|tønde|stage|kardinal|sideafmærkning",
        r"buoy|buoyage|\bmark|\bspar\b|marked",
    ),
)

#: (sub, Danish regex, English regex), tried in order on the sentence that
#: decided the class.
SUB_RULES: tuple[tuple[str, str, str], ...] = (
    ("missing", r"forsvundet|mangler|savnet", r"missing"),
    ("off-station", r"ikke på plads|ude af position|forskubbet|drevet", r"off.station|off position|out of position"),
    ("unlit", r"slukket|slukkes", r"unlit|extinguished"),
    ("unreliable", r"uregelmæssig|ustabil|upålidelig", r"unreliable|irregular"),
    ("damaged", r"beskadiget|ødelagt|væltet", r"damaged|destroyed"),
    ("replaced", r"erstattet|udskiftet", r"replaced"),
    ("withdrawn", r"inddraget|inddrages|fjernet|fjernes|nedlagt|nedlægges|ophævet", r"withdrawn|removed|discontinued"),
    ("moved", r"flyttet|flyttes", r"moved|relocated"),
    ("completed", r"afsluttet|ophørt|færdig", r"completed|finished|ended"),
    ("reduced", r"reducer|mindre dybde|mindre vanddybde", r"reduced|less depth"),
    ("normal", r"normal", r"normal"),
    ("lit", r"tændt|tændes|genetableret", r"\blit\b|relit|re-?established"),
    ("changed", r"ændret|ændres|ændring", r"changed|change|altered"),
    ("established", r"etableret|etableres|udlagt|udlægges|oprettet|oprettes|\bnyt?\b", r"established|deployed|laid|\bnew\b"),
)

_RULES_DA = tuple((r.cls, re.compile(r.da, re.IGNORECASE)) for r in RULES)
_RULES_EN = tuple((r.cls, re.compile(r.en, re.IGNORECASE)) for r in RULES)
_SUB_DA = tuple((s, re.compile(da, re.IGNORECASE)) for s, da, _ in SUB_RULES)
_SUB_EN = tuple((s, re.compile(en, re.IGNORECASE)) for s, _, en in SUB_RULES)

_SENTENCE_SPLIT = re.compile(r"\.\s+|\.$")


def sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_SPLIT.split(text) if s and s.strip()]


def strip_prefix(title: str, prefix_names: Iterable[str]) -> str:
    """The title without its leading area/locality sentences."""
    known = {s.casefold() for name in prefix_names for s in sentences(name)}
    parts = sentences(title)
    i = 0
    while i < len(parts) - 1 and parts[i].casefold() in known:
        i += 1
    return ". ".join(parts[i:])


def _sub(sentence: str, rules: tuple[tuple[str, re.Pattern[str]], ...]) -> str | None:
    for sub, rx in rules:
        if rx.search(sentence):
            return sub
    return None


def classify_subject(text: str, lang: str = "da") -> tuple[str, str | None] | None:
    """``(cls, sub)`` from subject text, or ``None`` when no rule matches."""
    rules = _RULES_DA if lang == "da" else _RULES_EN
    sub_rules = _SUB_DA if lang == "da" else _SUB_EN
    for sentence in sentences(text):
        for cls, rx in rules:
            if rx.search(sentence):
                sub = _sub(sentence, sub_rules)
                if cls == "lightbuoy":
                    cls = "light" if sub in (None, "unlit", "unreliable", "lit", "changed") else "buoy"
                return cls, sub
    return None
