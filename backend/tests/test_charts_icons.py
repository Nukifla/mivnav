# SPDX-License-Identifier: GPL-2.0-only
"""`/icons/{key}` — ATON point symbols rendered on demand (jt task qkmvmwps).

Replaces a pre-baked ~2.5 MiB combinatorial sprite atlas: the frontend asks
for exactly the `sym_s`/`sym_topmark` values a loaded chart references
(`frontend/src/core/style/atonIcons.ts`, on MapLibre's `styleimagemissing`)
and the Service Worker caches the answers so a visited region stays drawable
offline.

The rendering itself is chartcore's and is tested there (`icons::pack`, whose
full-catalogue test still walks every key `derive::aton` can emit). What this
file pins is the HTTP contract the loader depends on: keys with slashes in
them survive routing, an unknown name is an ordinary 404 rather than a 500,
and the response is cacheable and revalidatable.
"""

import hashlib

from fastapi.testclient import TestClient

from mivnav.api.app import app

client = TestClient(app)


def test_numeric_key_with_slashes_renders_an_svg():
    # `BOYSHP/4/1/3,1` — pillar, horizontal bands, red over white. The key's
    # own separators are real path separators, which is the whole reason the
    # route takes a `:path` parameter.
    res = client.get("/icons/BOYSHP/4/1/3,1.svg")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("image/svg+xml")
    body = res.text
    assert body.startswith("<svg")
    # The viewBox is load-bearing, not decoration: the frontend reads the
    # icon's native units off it to size the raster, and drops any icon
    # without one. usvg's writer omits it unless chartcore puts it back.
    assert 'viewBox="' in body


def test_suffix_is_optional():
    assert client.get("/icons/pilpnt").text == client.get("/icons/pilpnt.svg").text


def test_word_and_literal_forms_render():
    # The three address forms chartcore's `icons::resolve` understands, one
    # each — including the pair whose ROLE (body vs. topmark) their spelling
    # cannot reveal.
    for key in ["light_float/white", "sphere/red", "besom_point_up", "TOPSHP/3/0/0"]:
        res = client.get(f"/icons/{key}.svg")
        assert res.status_code == 200, key
        assert res.text.startswith("<svg"), key


def test_literal_colour_override_key_survives_routing_and_changes_the_render():
    """`TSS-arrow,c545c3` (yxnrrtwk) — the frontend's own resolved-per-palette
    hex, appended to the vendored literal icon's own name. `,` is a plain
    `pchar` too (already exercised by the numeric form's `BOYSHP/4/1/3,1`
    above), so this pins that a SINGLE-segment literal key carrying one still
    reaches the renderer, recoloured, rather than 404ing as an unknown name.
    """
    day = client.get("/icons/TSS-arrow.svg")
    assert day.status_code == 200
    recoloured = client.get("/icons/TSS-arrow,c545c3.svg")
    assert recoloured.status_code == 200
    assert recoloured.text != day.text
    assert "#c545c3" in recoloured.text
    # Two different palettes are two different keys, hence two different
    # `_render_icon` lru_cache entries and two different ETags/URLs for the
    # Service Worker/browser cache to key on — no cross-theme staleness.
    other_palette = client.get("/icons/TSS-arrow,ffffff.svg")
    assert other_palette.headers["ETag"] != recoloured.headers["ETag"]


def test_pattern_keys_render_unpadded_for_seamless_line_pattern_tiling():
    """`cable`/`pipeline` (nsplrzus) are repeating line-pattern tiles, not
    point symbols — the route must serve them at their own native canvas
    (chartcore's `icons::pack::render` skips the pivot-centred padding every
    other literal name gets), or the pattern would no longer repeat
    seamlessly at the width MapLibre's `line-pattern` expects.
    """
    cable = client.get("/icons/cable.svg")
    assert cable.status_code == 200
    assert 'viewBox="0 0 14.645 4"' in cable.text
    pipeline = client.get("/icons/pipeline.svg")
    assert pipeline.status_code == 200
    assert 'viewBox="0 0 12 4"' in pipeline.text
    # The same colour-override suffix TSS-arrow uses works here too — the
    # mechanism is generic, not name-specific.
    grey = client.get("/icons/pipeline,808080.svg")
    assert grey.status_code == 200
    assert "#808080" in grey.text
    assert grey.text != pipeline.text


def test_mount_reference_key_survives_routing_and_changes_the_render():
    """A topmark key names the buoy/beacon it caps — `TOPSHP/3/0/0@BOYSHP/3/0/1`
    (jt task vplwqzmr) — so chartcore can pad its sprite against that body's
    own mast height and lean instead of a fixed stand-in. `@` is a plain
    `pchar`, so it rides the `{key:path}` route unescaped; this pins that,
    and pins that the reference actually reaches the renderer.
    """
    mounted = client.get("/icons/TOPSHP/3/0/0@BOYSHP/3/0/1.svg")
    assert mounted.status_code == 200
    assert mounted.text.startswith("<svg")
    bare = client.get("/icons/TOPSHP/3/0/0.svg")
    assert bare.status_code == 200
    assert mounted.text != bare.text, "the mount reference must reach the renderer"
    # An unresolvable reference degrades to the stand-in rather than 404ing:
    # a blank icon on the water is worse than a slightly misplaced one.
    degraded = client.get("/icons/TOPSHP/3/0/0@no-such-icon.svg")
    assert degraded.status_code == 200
    assert degraded.text == bare.text


def test_unknown_name_is_a_plain_404():
    # Not an error condition: MapLibre reports every unresolved icon-image
    # through the same event the loader listens on, including the non-ATON
    # names still served by the old chartsymbols.xml sprite sheet. The loader
    # memoises this answer.
    #
    # QUESMRK1 used to be the example here. It is not one any more: the
    # single-icon-source migration gave every gap a placeholder
    # (chartcore/assets/s52-icons/placeholder/), so QUESMRK1 now RESOLVES —
    # see the test below. A name that is genuinely nothing still 404s.
    assert client.get("/icons/NoSuchSymbolAnywhere.svg").status_code == 404
    assert client.get("/icons/BOYSHP/nonsense/x/y.svg").status_code == 404


def test_symbols_without_a_vendored_equivalent_still_resolve():
    # The migration's central claim: chartcore's catalogue answers for every
    # name derive/ can emit, so the frontend needs no second icon pipeline to
    # cover the ones with no vendored artwork. This test does not care WHICH
    # kind of artwork answers, only that something does — QUESMRK1/LIGHTS81 are
    # still TEMPORARY placeholders (placeholders.json is the worklist) while
    # ISODGR51 has since been drawn for real (lppokvtq), and the claim above is
    # the same claim either way.
    for key in ("QUESMRK1", "LIGHTS81", "ISODGR51"):
        res = client.get(f"/icons/{key}.svg")
        assert res.status_code == 200, key
        assert res.text.startswith("<svg"), key


def test_absurd_key_is_refused_without_reaching_the_renderer():
    assert client.get("/icons/" + "A" * 200 + ".svg").status_code == 404


def test_etag_revalidates_to_304():
    res = client.get("/icons/pilpnt.svg")
    etag = res.headers["ETag"]
    # `no-cache`, NOT a blind max-age: a browser's own native HTTP cache has
    # no JS API to clear (the app's "Clear cache & reload" button can't
    # reach it), so a max-age window let a stale icon survive a chartcore
    # update for as long as the window ran, unrevalidated. `no-cache` still
    # lets the client store the response — it must just check back on the
    # ETag every time, same as the tile route.
    assert res.headers["Cache-Control"] == "public, no-cache"
    again = client.get("/icons/pilpnt.svg", headers={"If-None-Match": etag})
    assert again.status_code == 304


def test_etag_is_derived_from_the_rendered_content_not_the_key_or_build():
    # `chartcore.__version__` is `CARGO_PKG_VERSION`, which has stayed
    # "0.1.0" across this repo's entire history — including the commit that
    # added this very route — so a version-keyed ETag would never change on
    # an icon-rendering code change. The ETag must instead be a hash of the
    # SVG bytes actually served, so it changes whenever those bytes do,
    # regardless of what code or data caused the change.
    res = client.get("/icons/pilpnt.svg")
    expected = f'"{hashlib.sha256(res.content).hexdigest()[:16]}"'
    assert res.headers["ETag"] == expected
    other = client.get("/icons/sphere/red.svg")
    assert other.headers["ETag"] != res.headers["ETag"]


# -- ?roles=1: palette-neutral sentinels ------------------------------------
#
# chartcore can bake a reserved `#fe00XX` hex per ROLE instead of the day
# palette's real colours (see `chartcore/assets/s52-icons/icon-roles.json`),
# so a client can substitute its current theme before rasterising. The
# correctness of the substitution itself is chartcore's own acceptance test
# (a byte-identity round-trip over the whole key space); what belongs here is
# the HTTP contract: the flag reaches the renderer, it is OPT-IN, and the two
# modes never share a cache entry or an ETag.

SENTINEL_PREFIX = "#fe00"


def test_roles_mode_serves_sentinels_instead_of_day_hexes():
    res = client.get("/icons/BOYSHP/4/1/3,1.svg?roles=1")
    assert res.status_code == 200
    body = res.text
    assert body.startswith("<svg")
    assert 'viewBox="' in body
    assert SENTINEL_PREFIX in body
    # The day hexes those sentinels replaced are gone: #ed1c24 is the red
    # band, #000000 the outline ink, #ffffff the basepoint disc.
    for hexcode in ("#ed1c24", "#000000", "#ffffff"):
        assert hexcode not in body


def test_roles_mode_is_opt_in_and_the_default_response_is_unchanged():
    # The whole reason the flag exists: until the frontend substitutes,
    # every icon it does not ask about must still arrive day-baked.
    plain = client.get("/icons/BOYSHP/4/1/3,1.svg")
    assert SENTINEL_PREFIX not in plain.text
    assert "#ed1c24" in plain.text
    # `?roles=0` is explicitly the same thing, not a third mode.
    assert client.get("/icons/BOYSHP/4/1/3,1.svg?roles=0").text == plain.text


def test_the_two_modes_do_not_share_a_cache_entry_or_an_etag():
    # `_render_icon` is an lru_cache keyed on (key, roles); if the flag were
    # left out of that key, whichever mode was requested first would be
    # served to both. Request day first, then roles, on a key no other test
    # in this file touches, so the ordering is the one that would break.
    day = client.get("/icons/sphere/red.svg")
    roles = client.get("/icons/sphere/red.svg?roles=1")
    assert day.text != roles.text
    assert day.headers["ETag"] != roles.headers["ETag"]
    # ETag stays a hash of the bytes actually served — no synthetic mode
    # prefix needed, since the bytes already differ.
    assert (
        roles.headers["ETag"]
        == f'"{hashlib.sha256(roles.content).hexdigest()[:16]}"'
    )
    # ...and the day response is still the day response afterwards.
    assert client.get("/icons/sphere/red.svg").text == day.text


def test_roles_mode_keeps_the_per_feature_colour_override():
    # `,RRGGBB` carries the tile's own `bcol`, which varies feature to
    # feature within ONE palette — it is not a palette mechanism and does not
    # go away in roles mode.
    res = client.get("/icons/TSS-arrow,c545c3.svg?roles=1")
    assert res.status_code == 200
    assert "#c545c3" in res.text


def test_roles_mode_404s_the_same_keys_day_mode_does():
    assert client.get("/icons/NoSuchSymbolAnywhere.svg?roles=1").status_code == 404
