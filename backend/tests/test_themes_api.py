# SPDX-License-Identifier: GPL-2.0-only
"""``GET /themes`` and ``GET /themes.css`` — the palettes as backend data.

The 12 themes used to be TypeScript modules plus 11 ``:root[data-palette=…]``
CSS blocks in the frontend, which made a colour retune a rebuild. They are
JSON files now (``mivnav/features/themes/data/``, regenerated from the
frontend by that package's ``gen/dump_themes.mjs``), and this file pins the
contract the frontend half of the migration is written against:

- **All 12, in the Settings dropdown's order.** An array, not a map — the
  ordering is deliberate and JSON objects do not have one.
- **Day's ``icons`` block is the roles file, verbatim — bar the derived six.**
  This is the acceptance test for the whole icon-colour pipeline: chartcore
  emits sentinel hexes per ROLE and the client substitutes the palette's value,
  so a role-substituted DAY icon has to come out byte-identical to today's
  baked render (``chartcore/assets/s52-icons/icon-roles.json``'s own "DAY IS
  THE PROOF"). If this drifts, every day icon changes colour.
- **Every theme answers the 29 AUTHORED roles and none of the other six**, so a
  substitution never falls through to a raw sentinel and no theme carries a
  second, drifting copy of a colour it already states in its ``s52`` table
  (task otwvprzk; ``frontend/src/core/style/themes/derivedIcons.ts``).
- **Absent optional keys stay absent.** ``rasterDim``/``basemapTint``/
  ``contourWidth``/``fonts``/``sectorOutline``/``sectorArcScale``/
  ``textHalo``/``placeLabelTiers`` are optional and an omission is
  load-bearing, not a missing value: day must diff to no raster-paint keys AT
  ALL, and an absent ``textHalo`` is the ink-on-paper family's "no text glow
  anywhere" (``themes/types.ts``). ``null`` or ``{}`` would paint something.
- **The generated CSS reproduces index.css's blocks** — 18 tokens each,
  ``color-scheme: dark`` on exactly the dark palettes, no day block (day is
  the unattributed default, declared in Tailwind's ``@theme static``).
- **Runtime-updatable, which is the entire point.** A theme file dropped in
  ``~/.config/mivnav/themes/`` shadows the built-in and changes the response
  and the ETag with no restart; editing it again changes them again.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mivnav.api.app import app
from mivnav.features.themes.css import CHROME_TOKENS

client = TestClient(app)

REPO = Path(__file__).resolve().parents[2]
ROLES_PATH = REPO / "chartcore" / "assets" / "s52-icons" / "icon-roles.json"

# `themes/index.ts`'s THEMES array, which is the Settings dropdown's order.
# The first three are the day/dusk/night ROLES, which the frontend's
# `chrome/Launcher.tsx` `PALETTE_MODES` hardcodes. Since uqolozkr those are
# `paper2`/`graphite2`/`night`: the printed-chart pair took the day and dusk
# roles, and the S-52 tables they displaced kept their `day`/`dusk` ids — the
# persistence key, deliberately frozen — under the labels "S52-Day"/"S52-Dusk".
EXPECTED_ORDER = [
    "paper2",
    "graphite2",
    "night",
    "day",
    "dusk",
    "whiteback",
    "blackback",
    "slick",
    "paper",
    "graphite",
    "sunset",
    "vintage",
    "modern-paper-2",
    "modern-paper-2-night-dim",
    "modern-paper-2-night-red",
    "modern-paper-2-moonlight",
]

# The five palettes index.css sets `color-scheme: dark` on — and, not
# coincidentally, exactly the five its MapLibre-furniture rules name.
DARK = {"dusk", "night", "blackback", "graphite", "graphite2", "modern-paper-2-night-dim", "modern-paper-2-night-red", "modern-paper-2-moonlight"}

OPTIONAL_KEYS = (
    "rasterDim",
    "basemapTint",
    "contourWidth",
    "fonts",
    "sectorOutline",
    "sectorArcScale",
    "textHalo",
    "placeLabelTiers",
    "vessels",
)


@pytest.fixture(autouse=True)
def user_theme_dir(tmp_path, monkeypatch):
    """Point ``config_home()`` at a throwaway directory for every test here.

    Not merely hygiene: without it these tests read the DEVELOPER's own
    ``~/.config/mivnav/themes/``, so a hand-retuned palette on the dev box
    would fail the built-in-value assertions below. ``XDG_CONFIG_HOME``
    rather than patching a function, because that is what the real
    resolution path reads (``mivnav.config.model.config_home``) — patching
    the function would let a regression where the store captures the path at
    import time slip through.
    """
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    return tmp_path / "mivnav" / "themes"


def _themes() -> list[dict]:
    res = client.get("/themes")
    assert res.status_code == 200
    return res.json()


def _roles() -> dict:
    return json.loads(ROLES_PATH.read_text())["roles"]


# -- /themes: the set --------------------------------------------------------


def test_serves_all_twelve_themes_in_the_dropdown_order():
    assert [t["id"] for t in _themes()] == EXPECTED_ORDER


def test_response_is_an_array_so_the_order_is_part_of_the_contract():
    # A map keyed by id would make the ordering above an accident of whatever
    # the parser does with insertion order. See routes.py's docstring.
    assert isinstance(client.get("/themes").json(), list)


def test_every_theme_carries_the_required_fields():
    for theme in _themes():
        missing = {"id", "label", "s52", "canvas", "spritePrefix", "routeOverlay", "overlay", "poi", "basemap"} - set(theme)
        assert not missing, f"{theme['id']} missing {missing}"
        assert len(theme["s52"]) == 27, theme["id"]


def test_the_chrome_block_carries_all_eighteen_tokens():
    # These live ONLY in index.css upstream; extracting them is what lets the
    # backend regenerate the palette CSS at all.
    for theme in _themes():
        assert set(theme["chrome"]) == set(CHROME_TOKENS), theme["id"]


def test_the_dark_flag_marks_exactly_the_dark_palettes():
    assert {t["id"] for t in _themes() if t["dark"]} == DARK


def test_route_and_accent_agree_between_the_chrome_and_the_chart_halves():
    # The invariant `themes/index.test.ts` used to police across two files:
    # a WebGL paint property cannot read a CSS var, so the chart-side literal
    # and the chrome token have to be kept equal. One file now, still checked.
    for theme in _themes():
        assert theme["chrome"]["route"].lower() == theme["routeOverlay"]["route"].lower(), theme["id"]
        assert theme["chrome"]["accent"].lower() == theme["overlay"]["accent"].lower(), theme["id"]


# -- /themes: the icon roles -------------------------------------------------


# The six roles that ARE an S-52 token and are therefore authored NOWHERE —
# `frontend/src/core/style/themes/derivedIcons.ts` fills them in when a theme
# set is installed. Kept in sync with that module's `DERIVED_ICON_ROLES` by
# the test below (it asserts the served themes carry exactly the other 29).
DERIVED_ROLES = {
    "lit-red": "LITRD",
    "lit-green": "LITGN",
    "lit-yellow": "LITYW",
    "lit-white": "LITYW",
    "warn-magenta": "CHMGD",
    "obj-magenta": "CHMGD",
}


def test_day_icons_are_the_roles_file_verbatim_except_the_derived_six():
    # Narrowed 2026-07-29 (task otwvprzk, user's call). Day used to be the ONE
    # theme whose six S-52-token roles were the presentation-library hexes
    # (#ed1c24/#00a650/#fab20b/#ec008c) rather than its own tuned LITRD/LITGN/
    # LITYW/CHMGD — deltaE 13-18 apart, visibly so, and the discrepancy the
    # user asked to be rid of. Those six are no longer authored by any theme.
    #
    # The byte-identical round trip this test was defending is INTACT: it is
    # chartcore's `roles_mode_round_trips_to_byte_identical_day_output`, and it
    # reads `icon-roles.json` — the hexes baked into the artwork — not
    # `day.json`. What day.json still pins is the other 29 roles.
    day = next(t for t in _themes() if t["id"] == "day")
    expected = {name: role["day"] for name, role in _roles().items() if name not in DERIVED_ROLES}
    assert day["icons"] == expected


def test_every_theme_answers_every_authored_role_and_none_of_the_derived_six():
    names = set(_roles())
    assert len(names) == 35
    authored = names - set(DERIVED_ROLES)
    assert len(authored) == 29
    for theme in _themes():
        # Exactly the 29, so a substitution falls through to a raw `#fe00XX`
        # sentinel for none of them, and the six stay a single number rather
        # than a second one waiting to drift.
        assert set(theme["icons"]) == authored, theme["id"]


def test_the_derived_six_are_answered_by_the_themes_own_s52_tokens():
    # Not a resemblance — the same colour, named twice. This is the value the
    # client derives; it is asserted here so the AUTHORING side (a hand-tuned
    # palette in ~/.config/mivnav/themes/) is known to carry a usable token for
    # every one of the six.
    for theme in _themes():
        for token in set(DERIVED_ROLES.values()):
            value = theme["s52"][token]
            # Opaque `#rrggbb` specifically: `derivedIcons.ts` splices this
            # value into an SVG paint attribute, which has no alpha channel.
            assert re.fullmatch(r"#[0-9a-f]{6}", value), (theme["id"], token, value)


# -- /themes: absence is semantic --------------------------------------------


def test_day_has_no_raster_paint_keys_at_all():
    """Day must still diff to the style that shipped before palettes existed.

    Narrowed from "day carries none of ``OPTIONAL_KEYS``" once ``textHalo``
    arrived: day genuinely HAS a text glow — it always did, as ~15 hardcoded
    ``text-halo-width: 1.2`` literals scattered across the layer builders —
    and the port that introduced this field only moved that constant into the
    theme. Absence there means "no glow at all", which is the ink-on-paper
    family's choice, not day's. Same for ``placeLabelTiers``. The keys that
    must stay absent on day are the ones whose presence would ADD paint the
    pre-palette style never had.
    """
    day = next(t for t in _themes() if t["id"] == "day")
    for key in ("rasterDim", "basemapTint", "contourWidth", "fonts", "sectorOutline", "sectorArcScale"):
        assert key not in day, f"day grew {key} — it must diff to the pre-palette style"
    assert "placeLabelTiers" not in day, "place-label tiering is paper2/graphite2's aesthetic only"


def test_optional_keys_are_omitted_never_nulled():
    for theme in _themes():
        for key in OPTIONAL_KEYS:
            assert theme.get(key, "absent") not in (None, {}), (theme["id"], key)


def test_a_theme_that_declares_an_optional_key_still_carries_it():
    # The other half of the above: absence has to mean something, so presence
    # must survive too. paper is the theme that spends all three of these.
    paper = next(t for t in _themes() if t["id"] == "paper")
    assert paper["contourWidth"] == {"safety": 1, "other": 0.5}
    assert paper["sectorOutline"] is False
    assert paper["sectorArcScale"] == 2
    # …and the two this port added, on the themes that spend them.
    assert paper.get("textHalo") is None, "the ink-on-paper family has no glow"
    day = next(t for t in _themes() if t["id"] == "day")
    assert day["textHalo"] == {"color": "#ffffffe6", "width": 1.2}
    paper2 = next(t for t in _themes() if t["id"] == "paper2")
    assert paper2["placeLabelTiers"] is True
    assert "textHalo" not in paper2


# -- one colour notation -----------------------------------------------------

# `#rrggbb`, or `#rrggbbaa` where the value carries alpha. Lowercase, no short
# form, and no `rgb()`/`rgba()` anywhere — the whole point is that there is one
# notation to read and one to type, not two that mean the same thing.
_COLOUR_RE = re.compile(r"^#(?:[0-9a-f]{6}|[0-9a-f]{8})$")

# The only strings in a theme that are NOT colours. Exhaustive by
# construction: the test below asserts every OTHER string is a colour, so a
# theme that grows a new non-colour string field fails here and has to be
# added deliberately.
_NON_COLOUR_PATHS = frozenset({"id", "label", "spritePrefix", "fonts.upright[]", "fonts.italic[]", "fonts.all[]"})


def _colour_strings(node, path=""):
    """Every string value in a theme, as (dotted path, value)."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _colour_strings(value, f"{path}.{key}" if path else key)
    elif isinstance(node, list):
        for value in node:
            yield from _colour_strings(value, f"{path}[]")
    elif isinstance(node, str):
        yield path, node


def test_every_colour_in_every_theme_is_written_the_same_way():
    """The durable guard for task zrtxyypv.

    The themes were a mix of three notations — 736 ``#rrggbb``, 344 ``rgb()``
    and 56 ``rgba()`` — for no reason beyond where each value had come from
    (the ``rgb()`` block is the S-52 table, transcribed out of ochartsng's
    ``chartsymbols.xml``). Hex won because it is the notation the majority
    already used, it is what an icon role holds, and MapLibre 5.6 parses the
    8-digit form the alpha-bearing values need (verified against the installed
    style-spec ``Color.parse``: ``#ffffffe6`` -> alpha .902).

    Asserted over the SERVED payload, so a user theme in
    ``~/.config/mivnav/themes/`` is covered too — but the files under
    ``data/`` are what this is really pinning, and a re-added ``rgb()`` there
    is the regression it catches.
    """
    for theme in _themes():
        for path, value in _colour_strings(theme):
            if path in _NON_COLOUR_PATHS:
                continue
            assert _COLOUR_RE.match(value), (theme["id"], path, value)


def test_the_alpha_bearing_values_kept_their_alpha_through_the_sweep():
    # 8-bit alpha quantizes: the 0.9 these five paths used to carry becomes
    # 0xe6/255 = 0.90196 and 0.18 becomes 0x2e/255 = 0.18039. Imperceptible,
    # but it means the sweep was NOT bit-exact, and the thing that would be a
    # real regression is an alpha dropped entirely — a halo going opaque.
    # Every value on these paths must therefore still be 8 digits, not 6.
    alpha_bearing = 0
    for theme in _themes():
        for path, value in _colour_strings(theme):
            if path in ("chrome.shadow", "overlay.halo", "routeOverlay.halo", "basemap.placeHalo", "textHalo.color"):
                assert len(value) == 9, (theme["id"], path, value)
                alpha_bearing += 1
    assert alpha_bearing == 76


# -- /themes.css -------------------------------------------------------------


def _css() -> str:
    res = client.get("/themes.css")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/css")
    return res.text


def test_css_has_a_token_block_for_every_non_day_palette():
    css = _css()
    for theme_id in EXPECTED_ORDER:
        head = f':root[data-palette="{theme_id}"] {{'
        if theme_id == "day":
            # Day is the unattributed default — its tokens are Tailwind's
            # `@theme static` block and stay in index.css.
            assert head not in css
            continue
        assert head in css, theme_id
        block = css.split(head, 1)[1].split("}", 1)[0]
        for token in CHROME_TOKENS:
            assert f"--color-{token}:" in block, (theme_id, token)


def test_css_sets_color_scheme_dark_on_exactly_the_dark_palettes():
    css = _css()
    for theme_id in EXPECTED_ORDER:
        if theme_id == "day":
            continue
        block = css.split(f':root[data-palette="{theme_id}"] {{', 1)[1].split("}", 1)[0]
        assert ("color-scheme: dark" in block) is (theme_id in DARK), theme_id


def test_css_carries_the_maplibre_furniture_rules_for_the_dark_palettes():
    # index.css hardcodes the same five ids in seven rule groups; generating
    # them from the `dark` flag is what lets a palette added at runtime get
    # its map controls styled instead of four white slabs on a night chart.
    css = _css()
    assert css.count(".maplibregl-ctrl-group,") + css.count(".maplibregl-ctrl-group {") >= 1
    for theme_id in DARK:
        assert f':root[data-palette="{theme_id}"] .maplibregl-ctrl-attrib a' in css, theme_id
    for theme_id in set(EXPECTED_ORDER) - DARK:
        assert f':root[data-palette="{theme_id}"] .maplibregl-ctrl' not in css, theme_id


def test_index_css_no_longer_carries_a_second_copy_of_the_per_palette_chrome():
    # This test used to assert that the generated CSS matched the eleven
    # hand-written `:root[data-palette="…"]` blocks in the frontend's
    # index.css, which was the right check WHILE both existed. The frontend
    # half of the migration has since landed: those blocks are deleted and the
    # app loads this route at boot instead. So the correctness condition
    # inverts — a block left behind in index.css would be a second, silently
    # authoritative source that no theme edit on the boat could reach.
    index_css = (REPO / "frontend" / "src" / "index.css").read_text()
    for theme in _themes():
        if theme["id"] == "day":
            continue
        assert not re.search(rf'^:root\[data-palette="{theme["id"]}"\]', index_css, re.M), theme["id"]
    assert "maplibregl-ctrl-icon" not in index_css


def test_day_chrome_still_matches_the_tailwind_declaration_block_it_cannot_leave():
    # The one palette this route deliberately emits NO block for. Tailwind's
    # `@theme static` only generates utilities (`bg-chrome`, `text-fg-2`, …)
    # from tokens that exist as real CSS at build time, so day's values are
    # that declaration site — and therefore also the app's first-paint and
    # backend-unreachable fallback. They are consequently the one part of a
    # theme that a boat-side edit CANNOT change, and this pins that they at
    # least still agree with `day.json`.
    index_css = (REPO / "frontend" / "src" / "index.css").read_text()
    static_block = index_css.split("@theme static {", 1)[1].split("\n}", 1)[0]
    day = next(t for t in _themes() if t["id"] == "day")
    for token, value in day["chrome"].items():
        assert f"--color-{token}: {value};" in static_block, token
    assert ':root[data-palette="day"]' not in _css()


# -- caching -----------------------------------------------------------------


@pytest.mark.parametrize("path", ["/themes", "/themes.css"])
def test_etag_revalidates_to_304(path):
    first = client.get(path)
    assert first.headers["cache-control"] == "public, no-cache"
    etag = first.headers["etag"]
    again = client.get(path, headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.headers["etag"] == etag


# -- runtime updates ---------------------------------------------------------


def _write(path: Path, theme: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(theme))


def test_a_user_file_shadows_the_builtin_of_the_same_id(user_theme_dir):
    before = next(t for t in _themes() if t["id"] == "dusk")
    assert before["canvas"] != "rgb(1, 2, 3)"
    _write(user_theme_dir / "dusk.json", {**before, "canvas": "rgb(1, 2, 3)"})
    after = next(t for t in _themes() if t["id"] == "dusk")
    assert after["canvas"] == "rgb(1, 2, 3)"
    # …and it stays in its dropdown position rather than jumping to the end.
    assert [t["id"] for t in _themes()] == EXPECTED_ORDER


def test_editing_a_theme_file_changes_the_response_and_the_etag_with_no_restart(user_theme_dir):
    dusk = next(t for t in _themes() if t["id"] == "dusk")
    baseline_etag = client.get("/themes").headers["etag"]

    _write(user_theme_dir / "dusk.json", {**dusk, "label": "Dusk one"})
    first = client.get("/themes")
    assert first.headers["etag"] != baseline_etag
    assert next(t for t in first.json() if t["id"] == "dusk")["label"] == "Dusk one"

    # Second edit, DIFFERENT LENGTH as well as different content: the store's
    # freshness stamp is (mtime_ns, size), and a test this fast can rewrite a
    # file inside one filesystem timestamp tick.
    _write(user_theme_dir / "dusk.json", {**dusk, "label": "Dusk two — a longer label"})
    second = client.get("/themes")
    assert second.headers["etag"] != first.headers["etag"]
    assert next(t for t in second.json() if t["id"] == "dusk")["label"] == "Dusk two — a longer label"


def test_a_user_edit_reaches_the_generated_css_too(user_theme_dir):
    dusk = next(t for t in _themes() if t["id"] == "dusk")
    _write(user_theme_dir / "dusk.json", {**dusk, "chrome": {**dusk["chrome"], "chrome": "#123456"}})
    block = _css().split(':root[data-palette="dusk"] {', 1)[1].split("}", 1)[0]
    assert "--color-chrome: #123456;" in block


def test_a_user_file_may_declare_a_brand_new_palette(user_theme_dir):
    dusk = next(t for t in _themes() if t["id"] == "dusk")
    _write(user_theme_dir / "mine.json", {**dusk, "id": "mine", "label": "Mine"})
    ids = [t["id"] for t in _themes()]
    assert "mine" in ids
    assert set(EXPECTED_ORDER) <= set(ids)
    # Deliberately NOT asserting a position. Copying an existing theme file
    # copies its `order` too (this one inherits dusk's 1), and the sort key is
    # (order, id) — so "mine" lands next to dusk, not at the end. The
    # sort-last fallback applies only when `order` is genuinely ABSENT.
    assert ':root[data-palette="mine"] {' in _css()


def test_a_malformed_user_file_is_ignored_not_a_500(user_theme_dir):
    user_theme_dir.mkdir(parents=True, exist_ok=True)
    (user_theme_dir / "dusk.json").write_text("{ not json,")
    # The built-in it shadows is served instead — a trailing comma at 0200
    # must not take the boat's whole colour scheme with it.
    assert [t["id"] for t in _themes()] == EXPECTED_ORDER
    assert next(t for t in _themes() if t["id"] == "dusk")["label"] == "S52-Dusk"
