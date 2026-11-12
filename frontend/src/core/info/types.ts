// The info-at-point seam: everything between "the user asked what is at this
// spot" and "a panel shows it", with no knowledge of where the answer came
// from. See docs/architecture/info-seam.md for the two deliberate shapes
// (a hit is not the record; a hit is a value, not a click) and why `icon`
// follows the same rule as `detail`.

import type { Component } from "solid-js";

/**
 * What kind of attention a hit deserves, about the *mariner's* interest
 * rather than the data's origin — a provider classifies its own hits, so an
 * AIS target normally lands in `traffic` but a closing CPA makes it `danger`.
 */
export type InfoPriority =
  /** an immediate threat to this vessel — S-52 isolated dangers, a target on a collision course */
  | "danger"
  /** a charted hazard that is not (currently) a danger — wrecks, obstructions, rocks */
  | "hazard"
  /** something that moves — vessels, so also anything whose position is live */
  | "traffic"
  /** what you navigate *by* — aids to navigation, lights, marks */
  | "aid"
  /** what constrains you — restricted/anchorage/caution areas, and later routes and marinas */
  | "regulated"
  /** depth information — soundings, contours */
  | "depth"
  /** the shape of the shore — coastline, land, shoreline constructions */
  | "land"
  /** background areas — depth areas, the water you are floating on */
  | "area"
  /** everything else, including "there is nothing charted here" */
  | "context";

/** How tightly a hit is pinned to the tapped spot. A tapped point object is a
 * more specific answer than the area it sits in — the tiebreak within a
 * priority band. */
export type InfoPrecision = "point" | "line" | "area";

export interface InfoPoint {
  lng: number;
  lat: number;
}

/**
 * One answer to "what is here": cheap, self-describing, and enough to render
 * a list row without resolving anything.
 */
export interface InfoHit {
  /** Which provider owns this hit — the key `resolveDetail` routes on. */
  providerId: string;
  /** Stable within the provider; two hits with the same (providerId, id) are
   * deduped. Must be enough to resolve `detail` alone (list/search entry). */
  id: string;
  priority: InfoPriority;
  precision: InfoPrecision;
  /** What it is: "Wreck", "Buoy", "Nordkap". A short noun, not a sentence. */
  title: string;
  /** The most identifying secondary fact: a name, a light description, a
   * depth. Shown in the list and under the title. */
  subtitle?: string;
  /** The point this hit is about, if the provider knew one — a snapshot, not
   * live (see `InfoProvider.locate` for a moving subject). "About": a depth
   * area itself has no position, but a hit on it does — the tapped spot. */
  lngLat?: InfoPoint;
  /** Provider-private, opaque to everything here — the emitting provider may
   * stash what `detail` needs. Absent for list/search-built hits, so `detail`
   * must not require it. */
  payload?: unknown;
}

/** One label/value line of a resolved record. */
export interface InfoRow {
  label: string;
  value: string;
  /** Safety-relevant — the panel calls it out. */
  emphasis?: boolean;
  /** Makes the value a button. Used for the wind readout's tap-to-swap-unit —
   * the panel renders the value as a pressable control and calls this. */
  onClick?: () => void;
  /** The exact text this row stands for, worth copying (a position to read
   * over the radio). Set it and the panel owns the copy feedback state — a
   * provider must not, since `createHitDetail` re-resolves live. */
  copy?: string;
}

/** A group of rows under an optional heading (AIS wants "Voyage", "Vessel"; a
 * chart object wants "Chart"). */
export interface InfoSection {
  label?: string;
  rows: InfoRow[];
}

/**
 * What a note's `load` resolves to: prose (the common case — rendered as
 * pre-wrapped TEXT, never markup), or a provider-owned `Component` for a body
 * that is more than prose (a place record: fact rows, a wind rose,
 * reviews). The component is rendered as-is inside the opened note, with no
 * props — it closes over whatever the load fetched — so the panel still
 * never learns what it draws (same rule as `InfoProvider.icon`). See
 * docs/architecture/info-seam.md.
 */
export type InfoNoteBody = string | Component;

/** How a note sits in the panel. `"collapsed"` (the default): a labelled
 * disclosure, fetched on first open. `"inline"`: no label and no toggle — the
 * body loads as soon as the detail is shown and renders in place, as part of
 * the record (a place's details). See
 * docs/architecture/info-seam.md. */
export type InfoNoteDisplay = "collapsed" | "inline";

/**
 * A block of free prose too long for a label/value row. Collapsed until
 * opened by default, so a panel of a dozen hits does not fire a dozen network
 * reads; `display: "inline"` opts a note out of that (see `InfoNoteDisplay`).
 */
export interface InfoNote {
  /** Heading on the collapsed control, e.g. "Text description". Not shown
   * for an inline note (still names it for tests and debugging). */
  label: string;
  /** Default `"collapsed"`. */
  display?: InfoNoteDisplay;
  /** Fetch the note body. Called at most once — on first open, or on mount
   * for an inline note. Reject with an `Error` whose
   * message is prose fit to show the mariner — the panel renders it verbatim
   * (`noteError` in ./HitCarousel.tsx). */
  load: () => Promise<InfoNoteBody>;
  /** A second language variant (S-57's `TXTDSC` international / `NTXTDS`
   * national) — the panel shows a click-to-toggle control. Each side's `load`
   * is still called at most once, independently. */
  alt?: { label: string; load: () => Promise<InfoNoteBody> };
  /** The toggle's text while each side is shown. Default: the S-57 pair's
   * `"International"` (primary) / `"National"` (alt) — the name of the side
   * on screen. A provider whose pair is a plain language swap names the
   * language a tap switches TO instead (notices: `"English"` / `"Dansk"`). */
  altToggle?: { primary: string; alt: string };
}

/**
 * A provider-owned action button on a resolved hit — "Edit route". Distinct
 * from the per-POINT actions (Go here / Measure): this is the SUBJECT'S OWN
 * verb, rendered generically without the panel learning what it does.
 */
export interface InfoAction {
  /** The button label, e.g. "Edit route". A short verb phrase. */
  label: string;
  /** An optional leading icon; honours `InfoIconProps.class` like every info
   * icon. Absent → a label-only button. */
  icon?: Component<InfoIconProps>;
  /** Perform the action. Runs in the panel's context; the panel then closes,
   * unless `keepOpen`. */
  run: () => void;
  /** Leave the panel open: the action changes what the panel shows. */
  keepOpen?: boolean;
  /** Ask first: the button gives way to this question with its own confirm
   * and cancel buttons, and `run` needs the confirm. */
  confirm?: { question: string; label: string };
  /** Ask for text first: the button opens these fields with Save and Cancel,
   * and `submit` replaces `run`. */
  form?: {
    fields: readonly InfoActionField[];
    submit: (values: Record<string, string>) => void;
    /** The submit button's text. Default "Save". */
    submitLabel?: string;
    /** Asked once when the button first shows: true opens the form straight
     * away (a mark just dropped asks for its name). */
    autoOpen?: () => boolean;
  };
}

export interface InfoActionField {
  key: string;
  label: string;
  value: string;
  maxLength: number;
  multiline?: boolean;
  /** A fixed choice instead of free text: rendered as a select. */
  options?: readonly { value: string; label: string }[];
}

/** A link out to the subject's page elsewhere ("Open on example.com").
 * Opens in a new tab. */
export interface InfoLink {
  label: string;
  /** Absolute http(s) URL. */
  href: string;
}

/** The full record behind a hit, resolved on demand. */
export interface InfoDetail {
  /** Refines the hit's title/subtitle when the full record knows better (an
   * AIS hit titled by MMSI becomes the vessel's name). */
  title?: string;
  subtitle?: string;
  sections: InfoSection[];
  /** Lazily-loaded prose blocks, shown after the rows. */
  notes?: InfoNote[];
  /** Links out, shown last — after the notes, and whatever became of them:
   * part of the record itself, so a note that is still loading, failed or
   * was never offered cannot take them away. */
  links?: readonly InfoLink[];
  /** Subject-level action buttons (the route's "Edit route"). Rendered under the
   * header, above the record — provider-owned, so the panel routes them like
   * `detail` and never learns what any of them do. */
  actions?: readonly InfoAction[];
  /** The same, for an action that is rarely wanted: rendered last, under the
   * record, so it doesn't push the record down. */
  footerActions?: readonly InfoAction[];
}

/**
 * What an info icon is handed. Deliberately tiny: the panel sizes the box
 * with a class and the icon draws into it; a provider's icon must honour
 * `class` and assume nothing else about where it is shown.
 */
export interface InfoIconProps {
  /** Sizing/colour classes for the icon's root element. */
  class?: string;
}

/** Where the user asked, in both screen and geographic terms — providers
 * differ in which they need, and neither is derivable here. */
export interface InfoQuery {
  /** Screen pixels, relative to the map container. */
  point: { x: number; y: number };
  lngLat: InfoPoint;
  /** Tap tolerance in screen pixels; a provider may honour it in whichever
   * space it searches. */
  radius: number;
}

/**
 * A source of answers. Constructed with whatever it needs (the map, the
 * settings, a live state) — the seam passes it only the query.
 */
export interface InfoProvider {
  id: string;
  /** Human name of the source, for a panel that has to say where an answer
   * came from once there is more than one. */
  label: string;
  /** "What of mine is here?" Cheap, synchronous, no I/O. */
  queryAt(query: InfoQuery): InfoHit[];
  /** "Tell me everything about this one." May be async and may reach a
   * source the hit never touched. One-shot: called for a value, not
   * subscribed to — a provider whose record changes says so via `watch`. */
  detail(hit: InfoHit): InfoDetail | Promise<InfoDetail>;

  /** "Where is this **now**?", resolved from `hit.id`. Optional; see
   * docs/architecture/info-provider-contract.md — answer is authoritative
   * including `undefined` (no silent fallback to the stale `hit.lngLat`). */
  locate?(hit: InfoHit): InfoPoint | undefined;

  /** "Tell me when this hit's `detail` goes out of date" — read everything
   * `detail` derives from in a tracking scope; see
   * docs/architecture/info-provider-contract.md for why and the read-the-lot rule. */
  watch?(hit: InfoHit): void;

  /** "Draw THIS one" — icon for a specific hit, routed on `providerId` like
   * `detail`. `undefined` per hit is a real answer (falls to `defaultIcon`);
   * see docs/architecture/info-provider-contract.md for the async-resolve case. */
  icon?(hit: InfoHit): Component<InfoIconProps> | undefined;

  /** "The panel is showing THIS hit of yours" — or `undefined` once it
   * shows something else or closes. Optional; a provider that draws its own
   * selection (a notice's highlighted area) listens here instead of learning
   * where the panel state lives. Called on every selection change, routed on
   * `providerId`; must be cheap and must not throw. */
  selected?(hit: InfoHit | undefined): void;

  /**
   * "Which of the OTHER providers' answers to this tap does mine make
   * redundant?" Optional. Called once per query, after every provider has
   * answered, with this provider's own hits and everyone else's; the hits it
   * returns (from `others` — it cannot drop its own this way, nor is it
   * called when it answered nothing) are removed from the list. Every hook
   * sees the ORIGINAL answers, so the result does not depend on provider
   * order and two providers cannot erase each other into an empty list by
   * accident of sequencing — only by both saying so.
   *
   * For the case where two sources describe the same real thing with no
   * shared key and one is strictly the better answer (a firing-area notice
   * with its schedule vs. the chart's bare outline of the same range). The
   * knowledge lives with the provider that claims to be better; the
   * superseded provider learns nothing. Must be cheap, synchronous and must
   * not throw. See docs/architecture/info-provider-contract.md.
   */
  supersedes?(own: readonly InfoHit[], others: readonly InfoHit[]): readonly InfoHit[];

  /**
   * The provider's own fallback icon, shown when `icon` can't draw one
   * specifically (or there is no per-hit icon at all). Absent → the panel
   * shows the generic per-priority chip.
   */
  defaultIcon?: Component<InfoIconProps>;
}
