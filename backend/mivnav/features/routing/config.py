# SPDX-License-Identifier: GPL-2.0-only
"""The ``routing`` feature's config slice: safety depth/margin and the
optional shallow-water preference for ``POST /routing/plan``
(:mod:`mivnav.features.routing.routes`).

Not an input to any :class:`~mivnav.config.derived.Derived` — same
reasoning as :class:`mivnav.features.route.config.NavConfig`: ``routes.py``
reads this slice *live* on every request (``runtime.config.get().routing``),
there is no daemon or mmap here to memoize, so a change takes effect on the
next request with nothing to rebuild.

Replaces three module constants (``_DEFAULT_DRAFT_M``, ``_UNDER_KEEL_MARGIN_M``,
``_LATERAL_MARGIN_M``) that ``routes.py`` carried from day one, explicitly
documented there as placeholders "pending a real config field (or a required
request field)" — this is that field.
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from mivnav.config.base import Frozen


class RoutingConfig(Frozen):
    """Safety depth/margin/air-draft for the hazard-avoiding search, and
    eight optional soft preferences layered on top: water further from a
    charted hazard, avoiding TSS-family zones, preferring the "preferred
    route" family (a marked fairway, recommended track, navigation line,
    or deep-water route part), passing a lateral buoy/beacon on its
    charted-correct side, avoiding a submarine cable/pipeline, avoiding
    an anchorage/caution/permitted-transit-restricted area, avoiding a
    charted low-confidence-survey (CATZOC) zone, and penalising
    a sharp heading change (turn cost).

    `default_draft_m`/`under_keel_margin_m`/`lateral_margin_m` (below) and
    `air_draft_m` (further down, next to the other vessel-dimension
    fields) are the hard safety thresholds `chartcore`'s hazard union is
    built from (`chartcore::routing::hazards::build_hazard_index`) —
    crossing them is never allowed, at any weight below. The remaining
    fields are SOFT preferences layered on top, all off by default: see
    `chartcore::routing::raster`'s module docs for the combined cost
    model these drive. `air_draft_m` itself also defaults off (`0.0`,
    meaning no air-draft checking at all) — unlike the depth/margin
    fields, which are always-on hard thresholds with a conservative
    placeholder default; see that field's own docstring for why a hard
    hazard does not automatically mean "on by default". `turn_cost_weight`
    (below, near the other flat-penalty weights) is the one preference
    here that is HISTORY-dependent rather than position-dependent — see
    its own docstring and `chartcore::routing::raster::search_grid_with_
    turn_cost`'s module docs for why that needs a structurally different
    mechanism (a state-expanded search) rather than fitting the shared
    `CostModel` every other preference above uses.

    Two small families of fields here are ALGORITHM-SPECIFIC rather than
    shared, and are simply never read unless `algorithm` selects an engine
    that uses them: `routeiq_*` (the remote plugin's own constraints) and
    `artifact_*` (the v3 model's endpoint grace, CATZOC allowance and
    restricted-entry override) — the latter shared by BOTH `"artifact"`
    and `"mivnav"`, since `"mivnav"` runs that same
    `chartcore::routing::artifact` fine search underneath (see
    `_plan_via_mivnav`'s own docs). Everything else on this class is
    shared by every local engine — the artifact algorithm (and therefore
    mivnav too) deliberately reuses `default_draft_m`/
    `under_keel_margin_m`/`air_draft_m`/`lateral_margin_m` and the soft
    weights rather than duplicating them, with two documented differences
    in how it reads them: `lateral_margin_m` is a HARD buffer there (as it
    is for `"graph"`, and unlike the raster search's soft pull), and it
    has no shallow-water, buoyage-side or beam term at all — those need
    machinery this MVP does not have.
    """

    #: Show the auto-router (route editor, "Go here", its settings) in the
    #: UI. Beta and off by default; a manual routing tool will replace it.
    #: UI-only: `POST /routing/plan` still answers when this is off.
    beta_enabled: bool = False
    #: Metres. Used only when a `/routing/plan` request omits `draft_m` AND
    #: SignalK has no fix/no draft reported — see
    #: `mivnav.features.routing.routes._draft_from_signalk`. A deliberately
    #: conservative fallback, not a real boat's actual draft — a genuinely
    #: shallow-draft boat would be UNDER-warned by too-large a value here,
    #: so this stays a documented placeholder default, not a value to trust
    #: blindly; a real boat should either report its draft over SignalK or
    #: pass `draft_m` explicitly per request.
    default_draft_m: float = Field(default=2.0, gt=0)
    #: Metres, added to draft to get the depth a router must treat as
    #: unsafe — a stand-in for squat/tide/echo-sounder-error allowance.
    under_keel_margin_m: float = Field(default=1.0, ge=0)
    #: Metres, the PREFERRED lateral clearance from a charted hazard's own
    #: boundary — a soft preference (`chartcore::routing::raster`'s
    #: `lateral_margin_radius_m`/`LATERAL_MARGIN_PREFERENCE_WEIGHT`), not a
    #: hard wall: the search is pulled toward keeping this much standoff
    #: when there is room to, but is still able to thread a real, safe gap
    #: narrower than it rather than treat that gap as impassable. User
    #: decision (#owqqcdqe, 2026-08-10): "make the lateral margin a
    #: preference not a hard no go, i would rather a smaller margin than
    #: go over land" — this field used to be buffered directly into the
    #: hazard union itself (an absolute wall no route could cross, however
    #: narrow the only real gap happened to be); the hazard union is now
    #: always buffered by a small, fixed floor instead
    #: (`routes._HARD_LATERAL_FLOOR_M` — never zero, so a route still can
    #: never touch charted danger or cross land), and THIS field drives
    #: the soft pull outward from there. Unlike `shallow_avoidance_weight`
    #: below, this preference is always ON the instant it is nonzero — no
    #: separate weight to also remember to enable — since the whole point
    #: is that setting a margin should just work. `0` disables the
    #: preference entirely (only the small hard floor remains), which is
    #: NOT this field's default — a caller genuinely wanting today's old
    #: hard-wall behaviour has no equivalent any more; see this field's own
    #: git history for the exact mechanism if that's ever needed back.
    lateral_margin_m: float = Field(default=30.0, ge=0)

    #: Metres beyond the hazard union's own (small, fixed-floor) boundary
    #: over which the soft shallow-water preference (below) still has some
    #: pull — 0 (with `shallow_avoidance_weight` at its own default of 0)
    #: means OFF. Independent of, and stacks with, `lateral_margin_m`
    #: above: both are distance-graded pulls measured from the SAME
    #: boundary, `lateral_margin_m`'s own pull always on with a fixed
    #: weight, this one an OPTIONAL extra pull the caller separately
    #: dials in (own weight, own radius) for wanting even more clearance
    #: than the preferred margin alone.
    shallow_avoidance_radius_m: float = Field(default=0.0, ge=0)
    #: How strongly the search prefers water further from a hazard, within
    #: `shallow_avoidance_radius_m` of the hard margin's own edge — 0 is
    #: OFF (no preference, today's behavior); higher values pull harder
    #: toward open water for the same nearby distance, at the cost of
    #: accepting a real (bounded) detour to get it. Capped at 5.0: beyond
    #: that the search starts trading away meaningful distance for
    #: vanishing extra clearance, not a real safety gain.
    shallow_avoidance_weight: float = Field(default=0.0, ge=0, le=5.0)

    #: How strongly the search prefers routing away from TSS-family zones
    #: (traffic lanes, roundabouts, crossings, precautionary areas —
    #: `chartcore::routing::preference`; deliberately NOT the inshore
    #: traffic zone, COLREG Rule 10(d)'s own preferred alternative) — 0 is
    #: OFF. UNLIKE `shallow_avoidance_weight`, this is a FLAT in-zone
    #: multiplier with no distance falloff: the full weight applies to
    #: every metre actually inside the zone, not just a thin decaying band
    #: near its edge, so the same numeric weight has a proportionally
    #: stronger real effect here. Capped at 5.0 to match
    #: `shallow_avoidance_weight`'s own ceiling/mental model. Never a hard
    #: block: the router still crosses directly, and as briefly as
    #: possible, when no reasonable alternative exists — a flat per-cell
    #: penalty is minimized by whichever path spends the least distance
    #: inside the zone, which already tends toward a short, direct
    #: crossing with no need to parse charted traffic-flow direction.
    tss_avoidance_weight: float = Field(default=0.0, ge=0, le=5.0)
    #: How strongly the search prefers routing THROUGH the "preferred
    #: route" family when one already connects `from`/`to` — 0 is OFF;
    #: never forces a route into one that doesn't actually help reach the
    #: destination. Despite the field's own name (kept as-is rather than
    #: renamed, to avoid rippling a purely cosmetic change through the
    #: chartcore/frontend wire surface for no functional benefit), this
    #: covers FOUR S-57 classes, not `FAIRWY` alone: a marked fairway
    #: (`FAIRWY`), a recommended track (`RECTRC`), a navigation line
    #: (`NAVLNE`), and a deep-water route part (`DWRTPT`) —
    #: `chartcore::routing::preference::build_preferred_route_union`
    #: unions all four into ONE ring set sharing this ONE weight, rather
    #: than each getting an independently-tunable dial: nobody tuning
    #: this router has a real, evidenced basis to prefer a recommended
    #: track more or less strongly than a plain fairway (see that
    #: function's own module docs for the fuller reasoning, argued
    #: against the alternative, not just asserted). Unioning them also
    #: means "double-preferenced" water — e.g. a recommended track
    #: running through a fairway — costs exactly this one discount, never
    #: two multiplied together. Capped at 0.9, strictly below 1.0: this
    #: is a real correctness requirement, not a UX choice —
    #: `chartcore::routing::raster`'s combined cost multiplier includes a
    #: `(1 - fairway_preference_weight)` term, so `>= 1.0` here would let
    #: an edge's own cost hit zero. `0.9` also has a real search-
    #: performance cost, not a free one: the weighted search still needs
    #: an admissible heuristic, which this codebase gets by scaling the
    #: unweighted one down by `(1 - fairway_preference_weight)` — a value
    #: near the ceiling here makes that heuristic correspondingly weak
    #: (visible in a route's own `nodes_expanded` diagnostic, folded into
    #: `routing.log`).
    fairway_preference_weight: float = Field(default=0.0, ge=0, le=0.9)

    #: How strongly the search prefers routing away from a submarine cable
    #: or pipeline (`CBLSUB`/`PIPSOL` — `chartcore::routing::preference::
    #: build_cable_union`) — 0 is OFF. A FLAT in-zone multiplier like
    #: `tss_avoidance_weight`, no distance falloff. SEPARATE from
    #: `caution_area_avoidance_weight` below, not folded into it — a
    #: cable/pipeline is a genuinely different KIND of concern (protecting
    #: ground tackle/seabed infrastructure — don't anchor on or drag gear
    #: across one) from general navigational/legal caution, not just a
    #: different charted class (see `chartcore::routing::preference::
    #: CABLE_AVOID_CLASSES`'s own docs for the fuller reasoning, argued
    #: against sharing one dial with `caution_area_avoidance_weight`, not
    #: just asserted). Briefly CROSSING a cable, as almost any route
    #: roughly perpendicular to the coast must, costs little regardless of
    #: this weight — a flat zone-membership cost is proportional to
    #: distance actually spent inside the zone, so what this weight
    #: actually discourages is running ALONG a cable/pipeline route for any
    #: real distance. Never a hard block: capped at 5.0 to match
    #: `tss_avoidance_weight`'s own ceiling/mental model.
    cable_avoidance_weight: float = Field(default=0.0, ge=0, le=5.0)
    #: How strongly the search prefers routing away from an anchorage
    #: (`ACHARE` — unmarked anchored traffic may be present), a caution
    #: area (`CTNARE`), or a permitted-transit restricted/military-practice
    #: area (`RESARE`/`MIPARE` whose `RESTRN` does NOT contain `7` — see
    #: `chartcore::routing::hazards::entry_prohibited`'s own docs for why a
    #: `RESARE`/`MIPARE` with no `RESTRN` at all also lands here rather than
    #: being silently invisible or wrongly hard-blocked). Same class
    #: `chartcore::routing::preference::build_caution_union` unions —
    #: legally sensitive or unmarked-traffic areas the router has no way
    #: to distinguish more precisely than "navigate here with more general
    #: caution", which is why they share ONE weight rather than three (see
    #: that function's own docs). `entry_prohibited` `RESARE`/`MIPARE`
    #: (`RESTRN` containing `7`) is NEVER counted here — it is already a
    #: HARD block, unconditionally (`chartcore::routing::hazards::
    #: build_hazard_index`, the same unsafe-water union `default_draft_m`/
    #: `under_keel_margin_m`/`lateral_margin_m` above feed), and counting
    #: it again here would double-penalize a route already excluded from
    #: the search space. 0 is OFF. A FLAT in-zone multiplier
    #: like `tss_avoidance_weight`, no distance falloff. Never a hard
    #: block: capped at 5.0 to match `tss_avoidance_weight`'s own
    #: ceiling/mental model.
    caution_area_avoidance_weight: float = Field(default=0.0, ge=0, le=5.0)

    #: How strongly the search prefers routing away from a charted
    #: low-confidence survey — an `M_QUAL` zone whose `CATZOC` (Category of
    #: Zone of Confidence) reads C, D, or U, or carries no `CATZOC` at all
    #: (`chartcore::routing::preference::
    #: build_low_confidence_survey_union`). 0 is OFF. A FLAT in-zone
    #: multiplier like `tss_avoidance_weight`, no distance falloff. Never a
    #: hard block: capped at 5.0 to match `tss_avoidance_weight`'s own
    #: ceiling/mental model.
    #:
    #: CATZOC is a genuinely different, more precise fact than chart
    #: COMPILATION SCALE (`CellInfo.scale`, already used elsewhere for
    #: chart-authority purposes — `hazards.py`'s finest-scale-first
    #: clipping): a large-scale harbour chart can still be compiled from an
    #: old or coarse survey, and CATZOC is the field that actually says so.
    #: This is real CATZOC extraction, not a scale-based proxy — a real call
    #: made after checking the mechanism was actually available, not
    #: assumed: `M_QUAL` is an ordinary Area meta-object (S-57 class 308,
    #: already in chartcore's own vendored catalogue), decoded the exact
    #: same generic way `M_NSYS` already is for buoyage-region resolution
    #: (`chartcore::routing::buoyage::resolve_region`) — no new ingest
    #: prerequisite. Confirmed against real chart data, not assumed: a real
    #: NOAA S-57 cell (`US5OAKIQ.000`) charts 13 real `M_QUAL` zones, all
    #: `CATZOC=3` (Zone B); this project's own OSENC test fixture
    #: (`DE6OSTIM.S57`) charts none at all — the same "preference-layer
    #: classes absent from this fixture" pattern TSS/fairway already hit,
    #: so this feature's chartcore-level test coverage is synthetic plus
    #: the real NOAA cell, not `DE6OSTIM`.
    #:
    #: The threshold (C/D/U, not a graded 6-level cost curve) is a real call,
    #: not the easy default: A1/A2/B all carry IHO S-44 Order-1-class
    #: position accuracy, while C's own defining text ("large depth
    #: anomalies MAY BE EXPECTED", 500m position accuracy) is a real step
    #: down, not a smooth gradient — see
    #: `chartcore::routing::preference::build_low_confidence_survey_union`'s
    #: own docs for the full reasoning, including why a CATZOC-less
    #: `M_QUAL` zone counts as low-confidence too (absence is not evidence
    #: of a good survey — same instinct as a `RESTRN`-less `RESARE` landing
    #: in the soft-avoid tier rather than being silently invisible).
    #:
    #: Applies to every charted low-confidence zone the router might cross,
    #: not only a "close quarters" passage: this router has no geometric
    #: definition of "close quarters" anywhere today, and a flat
    #: zone-membership cost already produces the right behaviour without
    #: inventing one — it only reshapes a route where a better-surveyed
    #: alternative genuinely exists nearby, and never meaningfully distorts
    #: one where it doesn't (open water, or a region charted only from a
    #: low-confidence survey), the same "discourage, don't forbid" posture
    #: as every other soft preference here.
    low_confidence_survey_avoidance_weight: float = Field(default=0.0, ge=0, le=5.0)

    #: How strongly the search penalises a HEADING CHANGE, charged per grid
    #: step DURING the search itself (`chartcore::routing::raster::
    #: search_grid_with_turn_cost`) rather than only cleaned up afterward by
    #: the existing exact-visibility string-pulling
    #: (`chartcore::routing::raster::simplify_path`) — genuinely different
    #: from every other field on this class: those are all
    #: POSITION-dependent (the cost of being at or crossing a cell); this
    #: one is HISTORY-dependent (the cost of moving to a cell depends on
    #: which direction the search arrived from at the previous step), which
    #: is why it needs its own state-expanded search rather than fitting
    #: into the shared `CostModel`/`combined_multiplier` every other
    #: preference goes through. 0 is OFF — today's plain distance search,
    #: whose only zigzag suppression is the post-hoc geometric shortcut
    #: pass, unchanged.
    #:
    #: Scales LINEARLY with how sharp the heading change is (45° through a
    #: full 180° reversal), not a flat per-turn charge: `weight = 1.0` means
    #: a single 45° nudge costs as much as one whole extra orthogonal grid
    #: step, so a 90° turn costs 2 such steps and a full reversal costs 4 —
    #: deliberately discouraging SHARP direction changes (the actual
    #: zigzag/sawtooth pathology this exists to suppress) far more than
    #: gentle ones (a route curving through a sequence of small
    #: 45°-adjacent bends — rounding a headland, threading a channel — is a
    #: normal, often-necessary shape, not the problem). Never a hard block:
    #: a genuinely necessary sharp turn (a real narrow channel requiring
    #: several of them) still gets taken, just at a real, bounded extra
    #: cost, the same "discourage, don't forbid" posture as every other
    #: soft preference on this class.
    #:
    #: Capped at 5.0 to match the mental model of every other weight here
    #: (`tss_avoidance_weight`'s own ceiling): well past the point where
    #: the search would rather take almost any real detour than a single
    #: 90°+ turn. Off (`0.0`) by default like every preference added this
    #: session — this is a NEW kind of cost term with no real-usage tuning
    #: history yet (`ROUTING_TODO.md`'s own account of the shallow-water
    #: preference's first, too-weak-to-matter attempt is the cautionary
    #: tale for shipping an untuned nonzero default rather than a dial),
    #: and getting the magnitude wrong here has a real failure mode in
    #: BOTH directions: too small does nothing, too large can distort a
    #: route away from a genuinely necessary sequence of sharp turns (e.g.
    #: a real narrow channel) rather than merely smoothing a spurious
    #: zigzag — a real, evidenced starting point (once validated) is likely
    #: `weight ~= 0.3-0.5`, a single 45° nudge costing 30-50% of one grid
    #: step, the same "cheap tunable dial, not a hardcoded constant" call
    #: this session's other new preferences already made.
    turn_cost_weight: float = Field(default=0.0, ge=0, le=5.0)

    #: `algorithm in ("artifact", "mivnav")` ONLY (chartcore's §6
    #: charted-depth tiers — `raster`/`graph` ignore these). Three depth
    #: bands on top of the HARD floor, which stays `default_draft_m +
    #: under_keel_margin_m`:
    #:
    #: * below the hard floor — never routed (set `under_keel_margin_m` to
    #:   put the floor where you want it; e.g. draft 0.5 + margin 1.5 = a
    #:   2 m floor);
    #: * `(floor, avoid_depth_below_m]` — `avoid_depth_weight`, a HEAVY
    #:   soft cost the search takes only when there is no way around;
    #: * `(avoid_depth_below_m, soft_prefer_depth_below_m]` —
    #:   `soft_prefer_depth_weight`, a LIGHT "prefer deeper" nudge;
    #: * deeper — free.
    #:
    #: This is a preference on the charted depth VALUE, not on distance
    #: from a hazard edge (that is `raster`'s own `shallow_avoidance_*`).
    #: `avoid_depth_below_m == 0.0` (with the weight at 0) is OFF — the
    #: exact pre-tier behaviour, and what a route consumer that wants it
    #: passes.
    avoid_depth_below_m: float = Field(default=4.0, ge=0)
    avoid_depth_weight: float = Field(default=3.0, ge=0, le=5.0)
    #: See `avoid_depth_below_m`. Must be `>= avoid_depth_below_m` to have
    #: any effect (the band between the two).
    soft_prefer_depth_below_m: float = Field(default=6.0, ge=0)
    soft_prefer_depth_weight: float = Field(default=0.8, ge=0, le=5.0)

    #: Metres. The boat's own mast height above the waterline — gates a
    #: HARD block (`chartcore::routing::hazards::build_hazard_index`'s own
    #: "Air draft" docs), unlike every soft preference field above/below:
    #: a `BRIDGE`/`CBLOHD` (overhead cable) feature the boat cannot clear
    #: joins the unsafe-water union outright, the same way a too-shallow
    #: `DEPARE` does for `default_draft_m`. `0.0` (the default) means OFF —
    #: no `BRIDGE`/`CBLOHD` feature is ever consulted, byte-identical to
    #: this router before air-draft checking existed.
    #:
    #: Deliberately OFF by default, not a conservative nonzero placeholder
    #: the way `routeiq_air_draft_m` (below) is: that field has no
    #: off-switch available to it at all (`0` sent to a remote API reads
    #: as "a boat with no mast", which would falsely block on nearly every
    #: real bridge) — this field controls its own hazard union end to end,
    #: so it CAN express "skip this check" directly, and does. Unlike
    #: `default_draft_m`, there is also no sane universal non-zero default
    #: to fall back to: every boat displaces water (so a conservative
    #: draft placeholder is always a meaningful safety floor), but a wrong
    #: guessed mast height is not a safety floor — too low, and it needlessly
    #: blocks routes for a boat with no real air-draft concern; too high (a
    #: taller, unknown boat), and it lets a route pass under a bridge that
    #: does NOT clear, worse than no check at all, since "the router
    #: checked this" is a false assurance. A real boat should set its own
    #: value once known; until then, this router simply makes no claim
    #: about bridge/cable clearance, matching today's own actual behaviour.
    air_draft_m: float = Field(default=0.0, ge=0)

    #: `"A"`/`"B"` — which IALA buoyage region a lateral mark's `COLOUR`
    #: should be read against when the mark itself carries no `CATLAM`
    #: (`chartcore::routing::buoyage::resolve_lateral_side`). Only a
    #: fallback: a per-cell `M_NSYS`/`MARSYS` meta-object, when the chart
    #: carries one, wins over this default (`Cell.iala_region()`,
    #: `hazards.py`'s own candidate-cell scan) — this only matters for a
    #: request whose whole corridor charts no `M_NSYS` at all. Default
    #: `"A"`: most of Europe (this project's own home waters, `DE6OSTIM`
    #: included) is IALA-A; the Americas/Japan/Korea/Philippines are B.
    iala_region: Literal["A", "B"] = "A"
    #: Metres — how far from a lateral mark the "wrong side" preference
    #: (below) reaches. Same role `shallow_avoidance_radius_m` plays for
    #: the shallow-water preference, but this one is a FLAT in-zone cost
    #: like `tss_avoidance_weight`, not distance-graded: full weight
    #: anywhere within this radius on the wrong side, none beyond it.
    buoyage_avoidance_radius_m: float = Field(default=0.0, ge=0)
    #: How strongly the search prefers passing a lateral mark
    #: (`BOYLAT`/`BCNLAT`) on its charted-correct side — port-hand marks
    #: kept to port, starboard-hand to starboard, for the direction
    #: actually being sailed (`from` -> `to`; a return leg naturally
    #: reverses which side is correct, see
    #: `chartcore::routing::buoyage`'s own docs). 0 is OFF. Deliberately
    #: scoped to pure lateral marks only, not preferred-channel marks or
    #: cardinal/isolated-danger/safe-water marks — see that module's docs
    #: for why, and `ROUTING_TODO.md` for what's left. Never a hard
    #: block: capped at 5.0 to match `tss_avoidance_weight`'s own
    #: ceiling/mental model.
    buoyage_avoidance_weight: float = Field(default=0.0, ge=0, le=5.0)

    #: Which routing engine `POST /routing/plan` uses:
    #: `"raster"` — the built-in `chartcore` raster-grid + A* search (every
    #: field above/below this one); `"routeiq"` — a REMOTE call to a real
    #: `signalk-routeiq` plugin instance (`mivnav.features.routing.routeiq`)
    #: over the boat's own SignalK connection; `"graph"` — a LOCAL,
    #: structurally different second algorithm, modelled on RouteIQ's own
    #: documented approach (an adaptive-resolution graph, not a uniform
    #: grid — `chartcore::routing::raster::graph`) but running against
    #: THIS boat's own installed charts, no SignalK/remote dependency at
    #: all; `"artifact"` — a LOCAL, from-scratch FOURTH algorithm built to
    #: `mivnav_routing_architecture_v3.md`'s own model
    #: (`chartcore::routing::artifact`): a much wider hard-constraint
    #: feature set (the breakwater/pontoon/pile construction family,
    #: unsurveyed water, absent coverage, `SOUNDG` soundings, `RESARE`
    #: `RESTRN=8`, marine farms), `CATZOC` as a real horizontal buffer AND
    #: depth allowance rather than only a soft cost (the three
    #: `artifact_*` fields below), §9.3 endpoint grace, a source-driven
    #: resolution ladder, and deterministic integer costs. All four are
    #: comparable live against the same request.
    #: `"mivnav"` — a FIFTH algorithm: the same `"artifact"` fine search
    #: (reused unmodified, same route out), run ALONGSIDE
    #: `chartcore::mivnav`'s own precomputed-topology pipeline (§7's band
    #: ladder, §8's connected components/portals/shortcuts, §12.1's
    #: topology search) over the SAME candidate cells, for cross-check
    #: diagnostics only — see `_plan_via_mivnav`'s own docs for exactly
    #: what this does and does not prove today. The topology layer does
    #: NOT yet gate, filter, or alter the route this returns; picking it
    #: over `"artifact"` today buys you nothing DIFFERENT in the route
    #: itself, only extra diagnostics in `PlanResponse.debug_legs` — an
    #: early, honestly-labelled testability stepping stone toward the
    #: real v3 architecture, not that architecture finished.
    #:
    #: Default `"raster"`: `"routeiq"` needs its own access grant
    #: (`RouteIQCredentials`) and, as of this writing, has no published
    #: routing data for most of the world (confirmed directly against a
    #: real install: it covers only small test regions); `"artifact"` is
    #: newer and far less battle-tested than the raster search, and is an
    #: MVP of that architecture rather than a complete implementation of
    #: it (no precomputed `.mivnav` artifact, no depth-band ladder, no
    #: portal topology, no directional TSS/lock/buoyage-side semantics —
    #: `chartcore::routing::artifact`'s own module docs carry the full
    #: in/out-of-scope list) — picking any alternative is a deliberate
    #: choice to go test it, not a safe default. `"mivnav"` is even
    #: earlier: today it is `"artifact"` plus diagnostics, nothing more.
    algorithm: Literal["raster", "routeiq", "graph", "artifact", "mivnav"] = "raster"
    #: Metres. Sent as RouteIQ's `beam` constraint — mivnav itself has no
    #: beam field elsewhere (the raster search doesn't need one: hazard
    #: geometry is buffered by `lateral_margin_m`, not tested against a
    #: vessel width). Same "documented placeholder, not a real boat's own
    #: value" posture as `default_draft_m` — a boat narrower or wider than
    #: this default is under/over-constrained until it sets its own.
    routeiq_beam_m: float = Field(default=3.5, gt=0)
    #: Metres. Sent as RouteIQ's `airDraft` constraint (mast height above
    #: the waterline, folding botom clearance) — same placeholder posture
    #: as `routeiq_beam_m`/`default_draft_m`. RouteIQ hard-blocks any
    #: bridge/overhead its own chart data marks too low for this.
    routeiq_air_draft_m: float = Field(default=18.0, gt=0)
    #: Nautical miles. RouteIQ's own `minCoastDistance` — how far offshore
    #: a route must stay by default. RouteIQ's own documented default
    #: (0.5nm); kept as mivnav's own default too so a request omitting it
    #: behaves the same either way, but exposed here (unlike the two
    #: fields above) because it's a genuine preference, not a vessel fact.
    routeiq_min_coast_distance_nm: float = Field(default=0.5, ge=0, le=100)

    #: Metres. `algorithm in {"artifact", "mivnav"}` ONLY (v3 §9.3, ignored by every
    #: other engine — the same algorithm-specific posture the three
    #: `routeiq_*` fields above have): how far from the REQUESTED start
    #: and destination the FIRST and LAST leg alone may cross UNKNOWN
    #: water — charted `UNSARE`, or ground no installed cell's coverage
    #: claims at all. Never land, never a construction feature, never a
    #: depth or hazard block: grace is for water this chart says nothing
    #: about, not for water it says is dangerous. This exists because that
    #: algorithm treats `UNSARE`/absent coverage as a HARD block (unlike
    #: the raster search, which downgraded `UNSARE` to a soft
    #: check-manually flag after a real marina came back unreachable) —
    #: grace is v3's own answer to exactly that problem, and the reason
    #: the hard rule is safe to keep: a marina charted right at the edge
    #: of a cell's coverage is still reachable, it just comes back with
    #: that leg flagged in `PlanResponse.check_manually_legs`. A requested
    #: endpoint sitting INSIDE a blocking feature is also snapped to the
    #: nearest navigable point within this radius, and the snap distance
    #: is reported in the response's warnings when it exceeds the grid's
    #: own cell size. `0` disables grace entirely: an endpoint in
    #: unsurveyed or uncharted water then simply has no route, which is
    #: the strictest setting, not the safest-by-default one — hence 150m,
    #: v3 §9.3's own figure.
    artifact_endpoint_grace_radius_m: float = Field(default=150.0, ge=0, le=2000)
    #: `algorithm in {"artifact", "mivnav"}` ONLY (v3 §3.4). How much the algorithm
    #: derates charted hazards by the SURVEY they came from — `M_QUAL`'s
    #: own `CATZOC` (Category of Zone of Confidence), read per feature
    #: from the zone that feature actually sits in, as BOTH a horizontal
    #: buffer grown onto the hazard's geometry (A1 5m, A2 20m, B 50m, C
    #: 500m, D/unassessed/absent 1000m) and a depth allowance subtracted
    #: from charted depth before the required-depth comparison (A1
    #: 0.50m+1%, A2/B 1.00m+2%, C and D/U 2.00m+5%). Genuinely different
    #: from `low_confidence_survey_avoidance_weight` above, which is only
    #: a soft cost for BEING in a low-confidence zone: this one changes
    #: the hazard geometry and the depth test themselves, so it can and
    #: does refuse routes the other would merely discourage.
    #:
    #: `"full"` applies the whole table, `"half"` halves both numbers,
    #: `"depth_only"` keeps the depth allowance and skips the horizontal
    #: buffer, `"off"` does neither (matching every other algorithm here).
    #: Default `"full"` — v3 §25 open decision #1's own lean, and the
    #: right default for an algorithm whose whole point is strictness. Be
    #: aware of the real consequence, which is not a bug and is pinned by
    #: a test: on a chart carrying NO `M_QUAL` at all (the D/U fallback —
    #: this project's own `DE6OSTIM` fixture, and plenty of real cells),
    #: `"full"` buffers every hazard by a kilometre, which closes most
    #: inshore water outright. `"half"`/`"depth_only"`/`"off"` are what
    #: that situation calls for. Anything unrecognised is read as
    #: `"full"` by chartcore, the strictest — a typo must never silently
    #: weaken a hard constraint.
    artifact_catzoc_allowance_mode: Literal["full", "half", "depth_only", "off"] = "full"
    #: `algorithm in {"artifact", "mivnav"}` ONLY (v3 §3.3). Releases, together, the
    #: three charted classes that algorithm hard-blocks by default but
    #: that a skipper may have a real, legal reason to enter: `RESARE`/
    #: `MIPARE` whose `RESTRN` says 8 (entry RESTRICTED — permission
    #: needed, not forbidden), `MARCUL` (marine farm/culture) and
    #: `FSHFAC` (fishing facility). Down to a soft avoid cost, never
    #: invisible. NEVER releases `RESTRN=7` (entry PROHIBITED), which
    #: stays a hard block at any setting. Deliberately ONE knob for all
    #: three rather than a family of them (an MVP scope call, documented
    #: in `chartcore::routing::artifact::constraints`' own module docs):
    #: the boat that has permission for a restricted area is generally
    #: the same boat that knows what the local fish farms are. `False` by
    #: default — the router's own answer with no local knowledge should
    #: be the conservative one.
    artifact_allow_restricted_entry: bool = False
    #: Metres. `algorithm == "mivnav"` ONLY (v3 §8.3/§12.4, ignored by
    #: every other engine). The vessel's BEAM — how wide a hull the route
    #: must fit. When `> 0`, a portal on the precomputed topology route
    #: whose measured horizontal clearance is below it is DEMOTED (kept as
    #: a usable edge, never rejected — a width filter with nowhere to
    #: demote to would silently lose real routes) and handed to
    #: `chartcore::mivnav`'s local vector refinement, which re-routes that
    #: one crossing against the chart's own hazard geometry rather than
    #: its rasterisation, then re-verifies the result against the
    #: draft-aware hard constraints before keeping it. `0` (the default)
    #: disables the whole path: `"mivnav"` then returns exactly the
    #: `"artifact"` fine-search route, byte for byte. Same "documented
    #: placeholder, not a real boat's own value" posture as
    #: `routeiq_beam_m` — a boat sets its own; unset, no beam constraint
    #: is applied at all. Left unbounded above (like `routeiq_beam_m`):
    #: a real hull is well under 100 m, and a value that large only makes
    #: sense for deliberately exercising the demote/refine path on a
    #: small test fixture whose only charted crossings are wide.
    mivnav_beam_m: float = Field(default=0.0, ge=0)

    #: `algorithm == "mivnav"` ONLY (v3 §11, ignored by every other
    #: engine). Turns on the DIRECTIONAL / buoyage semantics: a
    #: precomputed-topology crossing taken against a charted traffic flow
    #: (`TSSLPT` / one-way `DWRTPT` / `RECTRC` with `ORIENT`) is FORBIDDEN
    #: (the edge does not exist for that direction of travel), and a
    #: crossing on the wrong side of a lateral mark for its direction gets
    #: a bounded soft penalty. Like `mivnav_beam_m`, this can change which
    #: corridor the topology layer selects, so it is opt-in and cannot be
    #: silently on; UNLIKE it, it never moves the fine-search route itself
    #: — `"mivnav"` with only this set is still byte-identical to
    #: `"artifact"` for `waypoints`/`distance_m`. The effect is visible in
    #: `debug_legs` (`topology_directional_penalized_portals`) and the
    #: `routing.log` timing line. `False` (the default) skips the whole
    #: path, including the per-request semantics build. `chartcore.
    #: mivnav_route`'s own docs own the semantics.
    mivnav_directional_rules: bool = Field(default=False)

    #: `algorithm == "mivnav"` ONLY. When `True`, a `/routing/plan`
    #: request whose topology layer did NOT read a persisted `.mivnav`
    #: (no artifact built for this chart set, `chartcore`'s §19
    #: `staleness()` refused the one on disk, or the corridor spans more
    #: than one chart set) is refused rather than served from the
    #: per-request topology REBUILD. The route is still returned as a
    #: straight line with a warning naming the reason — the same shape as
    #: "mivnav found no path" — so the failure is unmistakable in the UI
    #: and the response, never a silent downgrade.
    #:
    #: This changes nothing about the route a normal boat gets (the
    #: rebuild path produces the byte-identical fine-search route — see
    #: `_plan_via_mivnav`'s docstring); it exists so a TEST can assert it
    #: is exercising the artifact read path and not the fallback.
    #: `False` (the default) keeps today's behaviour: rebuild, name why,
    #: serve the route.
    #:
    #: It does NOT gate the COARSE portal-graph fallback
    #: (`_plan_via_mivnav_coarse`, reached only when the fine search finds
    #: no path): that path uses the persisted `.mivnav` by construction —
    #: `find_mivnav_coarse_route` only succeeds with a usable file — and
    #: its per-leg fine searches never rebuild a topology, so a
    #: coarse-stitched route already satisfies "read the artifact".
    mivnav_require_artifact: bool = Field(default=False)

    #: Try a coarse, land-only MACRO pass (`chartcore.macro_route`) when
    #: the ordinary per-leg search (even after its own recursive
    #: refinement — `chartcore::routing::raster::refine_flagged_legs`)
    #: still comes back badly unreachable: a real detour around a whole
    #: landmass, entirely outside the ordinary search's own corridor
    #: (`chartcore::routing::raster::CORRIDOR_PAD_CAP_M`, 50km either side
    #: of the direct line) by construction — found live, from a real
    #: request that could only be completed via a ~150nm detour around a
    #: peninsula. Default ON: this IS the fix for that case, not an
    #: experimental extra — but it comes with a real caveat the response's
    #: own warning text always states plainly when it fires: a long
    #: automatic detour has NOT been checked for bridge/lock/cable
    #: clearance, only for charted land and (indirectly, via the ordinary
    #: per-leg search re-run along it) depth. See
    #: `mivnav.features.routing.hazards`'s macro-route functions and
    #: `ROUTING_TODO.md`'s Limfjord entry for the full mechanism.
    macro_route_enabled: bool = True
