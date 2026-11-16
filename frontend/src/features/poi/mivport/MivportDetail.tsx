// A mivport place's info-panel body — the structured `InfoNoteBody` the POI
// provider's inline note resolves to (./detail.ts builds every value; this
// only lays it out). Every string is user-edited data and goes into TEXT
// nodes — never innerHTML. Colours are chrome tokens, so the palette switch
// (day/dusk/night) re-tints it like every other panel surface.
//
// Layout after the poi-testclient's place details (form.js `placeDetails`,
// `roseSvg`/`roseLegend`; app.js `reviewsSection`, `photosSection`), compacted
// for a chart plotter's info panel.

import { createSignal, For, Show, type Component } from "solid-js";
import { Lightbox } from "../../../core/chrome/Lightbox";
import { SectionLabel } from "../../../core/ui/Text";
import {
  averageStars,
  GRADES,
  lightboxCaption,
  mivportSections,
  mivportWebUrl,
  osmElementUrl,
  photoCredits,
  placeDescription,
  reviewMeta,
  roseDescription,
  roseLabelPoint,
  roseSectorPath,
  shownPhotos,
  starString,
  WIND_DIRS,
  type DetailSection,
  type Grade,
  type MivportPlaceDetail,
  type MivportReview,
  type ShownPhoto,
  type WindGrades,
} from "./detail";

const LINK = "break-all text-accent underline decoration-dotted underline-offset-2 hover:brightness-110";

/** Grade → fill: the urgency ladder (a brightness ramp too, so it holds for
 * the red/green-blind), "none" the full alarm and "poor" a paler one. */
const GRADE_CLASS: Record<Grade, string> = {
  good: "fill-ok",
  fair: "fill-notice",
  poor: "fill-alarm opacity-55",
  none: "fill-alarm",
};
const SWATCH_CLASS: Record<Grade, string> = {
  good: "bg-ok",
  fair: "bg-notice",
  poor: "bg-alarm opacity-55",
  none: "bg-alarm",
};

/** The shelter rose: 8 sectors graded good/fair/poor/none, a not-known
 * sector left recessed, and a legend of the grades it uses. */
export const MivportWindRose: Component<{ grades: WindGrades }> = (props) => {
  const used = () => GRADES.filter((g) => WIND_DIRS.some((d) => props.grades[d] === g));
  const unknown = () => WIND_DIRS.some((d) => !props.grades[d]);
  return (
    <div class="flex items-center gap-3">
      <svg viewBox="-60 -60 120 120" class="size-24 shrink-0" role="img" aria-label={roseDescription(props.grades)}>
        <For each={WIND_DIRS}>
          {(d) => {
            const g = () => props.grades[d];
            return (
              <path
                d={roseSectorPath(d)}
                class={g() ? `${GRADE_CLASS[g()!]} stroke-chrome` : "fill-chrome-2 stroke-line"}
                stroke-width="0.8"
              >
                <title>{`${d}: ${g() ?? "not known"}`}</title>
              </path>
            );
          }}
        </For>
        <For each={WIND_DIRS}>
          {(d) => {
            const p = roseLabelPoint(d);
            return (
              <text
                x={p.x}
                y={p.y + 3}
                text-anchor="middle"
                class={d.length === 1 ? "fill-fg-2 font-bold" : "fill-fg-3"}
                font-size={d.length === 1 ? "10" : "8.5"}
              >
                {d}
              </text>
            );
          }}
        </For>
      </svg>
      <ul class="space-y-0.5 text-[11px] text-fg-2">
        <For each={used()}>
          {(g) => (
            <li class="flex items-center gap-1.5">
              <span class={`size-2.5 rounded-xs ${SWATCH_CLASS[g]}`} />
              {g.charAt(0).toUpperCase() + g.slice(1)}
            </li>
          )}
        </For>
        <Show when={unknown()}>
          <li class="flex items-center gap-1.5">
            <span class="size-2.5 rounded-xs bg-chrome-2 ring-1 ring-line ring-inset" />
            Not known
          </li>
        </Show>
      </ul>
    </div>
  );
};

const Section: Component<{ section: DetailSection }> = (props) => {
  const s = () => props.section;
  return (
    <div class="space-y-1">
      <SectionLabel>{s().title}</SectionLabel>
      <Show when={s().chips.length > 0}>
        <div class="flex flex-wrap gap-1">
          <For each={s().chips}>
            {(c) => (
              <span
                class={`rounded px-1.5 py-0.5 text-[11px] ${c.yes ? "bg-chrome-2 text-fg" : "bg-chrome-2 text-fg-3 line-through"}`}
              >
                {c.label}
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show when={s().rows.length > 0}>
        <dl class="space-y-0.5">
          <For each={s().rows}>
            {(fact) => (
              <div class="flex justify-between gap-3">
                <dt class="shrink-0 text-fg-2">{fact.label}</dt>
                <dd class="min-w-0 whitespace-pre-wrap text-right break-words">
                  <Show when={fact.href} fallback={fact.value}>
                    {(href) => (
                      <a
                        href={href()}
                        class={LINK}
                        {...(href().startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      >
                        {fact.value}
                      </a>
                    )}
                  </Show>
                  <Show when={fact.note}>
                    <span class="text-fg-3"> · {fact.note}</span>
                  </Show>
                </dd>
              </div>
            )}
          </For>
        </dl>
      </Show>
      <Show when={s().rose}>{(g) => <MivportWindRose grades={g()} />}</Show>
      <Show when={s().links.length > 0}>
        <div class="flex flex-wrap gap-x-3 gap-y-0.5">
          <For each={s().links}>
            {(l) => (
              <a href={l.href} target="_blank" rel="noopener noreferrer" class={LINK}>
                {l.label}
              </a>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

/** One photo thumbnail; a tap opens the fullscreen viewer on it. A remote
 * photo offline (no internet at sea) simply fails — the thumbnail then
 * disappears instead of showing a broken picture. */
const Photo: Component<{ photo: ShownPhoto; onOpen: () => void }> = (props) => {
  const [failed, setFailed] = createSignal(false);
  return (
    <Show when={!failed()}>
      <button
        type="button"
        aria-label={props.photo.caption ? `View photo: ${props.photo.caption}` : "View photo"}
        class="shrink-0 cursor-zoom-in rounded-sm focus-ring"
        onClick={() => props.onOpen()}
      >
        <img
          src={props.photo.thumb}
          alt={props.photo.caption ?? ""}
          title={lightboxCaption(props.photo)}
          loading="lazy"
          referrerpolicy="no-referrer"
          class="h-16 w-auto rounded-sm bg-chrome-2 object-cover pointer-coarse:h-20"
          onError={() => setFailed(true)}
        />
      </button>
    </Show>
  );
};

const Review: Component<{ review: MivportReview }> = (props) => {
  const meta = () => reviewMeta(props.review);
  const stars = () => (typeof props.review.stars === "number" ? props.review.stars : 0);
  return (
    <div class="space-y-0.5 border-t border-line-2 pt-1">
      <div class="flex flex-wrap items-baseline gap-x-1.5 text-[11px] text-fg-2">
        <Show when={stars() > 0}>
          <span class="text-accent" aria-label={`${stars()} of 5 stars`}>
            {starString(stars())}
          </span>
        </Show>
        <Show when={props.review.user}>
          <span class="font-semibold text-fg">{props.review.user}</span>
        </Show>
        <Show when={meta()}>{(m) => <span>{m()}</span>}</Show>
      </div>
      <Show when={props.review.body?.trim()}>
        <p class="whitespace-pre-wrap break-words text-xs leading-snug text-fg">{props.review.body!.trim()}</p>
      </Show>
    </div>
  );
};

/** The whole mivport body for one place. */
export const MivportDetail: Component<{ detail: MivportPlaceDetail }> = (props) => {
  const d = () => props.detail;
  const description = () => placeDescription(d());
  const sections = () => mivportSections(d());
  const photos = () => shownPhotos(d());
  const credits = () => photoCredits(photos());
  const reviews = () => (Array.isArray(d().reviews) ? d().reviews! : []);
  const avg = () => averageStars(reviews());
  const osmUrl = () => osmElementUrl(d().osm);
  const webUrl = () => mivportWebUrl(d());
  const [viewing, setViewing] = createSignal<number>();
  return (
    <div class="space-y-2 text-xs text-fg">
      <Show when={avg()}>
        {(s) => (
          <div class="flex items-baseline gap-1.5" aria-label={`Rated ${s().toFixed(1)} of 5`}>
            <span class="text-accent">{starString(s())}</span>
            <span class="text-fg-2">
              {s().toFixed(1)} · {reviews().length} {reviews().length === 1 ? "review" : "reviews"}
            </span>
          </div>
        )}
      </Show>
      <Show when={photos().length > 0}>
        {/* The phone carousel pages on a horizontal swipe; this marker
            (PAGER_SCROLL_X_ATTR, core/gesture.ts) makes one that starts on
            the strip scroll the strip instead, while it can scroll that way. */}
        <div class="space-y-0.5">
          <div class="flex gap-1 overflow-x-auto" data-pager-scroll-x>
            <For each={photos()}>{(p, i) => <Photo photo={p} onOpen={() => setViewing(i())} />}</For>
          </div>
          <Show when={credits().length > 0}>
            <p class="text-[10px] leading-tight text-fg-3">
              Photos:{" "}
              <For each={credits()}>
                {(c, i) => (
                  <>
                    {i() > 0 ? "; " : ""}
                    <Show when={c.href} fallback={c.text}>
                      {(href) => (
                        <a href={href()} target="_blank" rel="noopener noreferrer license" class={LINK}>
                          {c.text}
                        </a>
                      )}
                    </Show>
                  </>
                )}
              </For>
            </p>
          </Show>
        </div>
        <Lightbox
          images={photos().map((p) => ({ url: p.url, caption: lightboxCaption(p) }))}
          index={viewing()}
          onIndexChange={setViewing}
          onClose={() => setViewing(undefined)}
        />
      </Show>
      <Show when={description()}>
        <p class="whitespace-pre-wrap break-words leading-snug">{description()}</p>
      </Show>
      <For each={sections()}>{(s) => <Section section={s} />}</For>
      <Show when={reviews().length > 0}>
        <div class="space-y-1">
          <SectionLabel>Reviews ({reviews().length})</SectionLabel>
          <For each={reviews()}>{(r) => <Review review={r} />}</For>
        </div>
      </Show>
      <Show when={webUrl() || osmUrl()}>
        <div class="flex flex-wrap gap-x-3 gap-y-0.5">
          <Show when={webUrl()}>
            {(href) => (
              <a href={href()} target="_blank" rel="noopener noreferrer" class={LINK}>
                Open in mivport
              </a>
            )}
          </Show>
          <Show when={osmUrl()}>
            {(href) => (
              <a href={href()} target="_blank" rel="noopener noreferrer" class={LINK}>
                View on openstreetmap.org
              </a>
            )}
          </Show>
        </div>
      </Show>
      <Show when={d().source === "osm"}>
        <p class="text-[11px] text-fg-2">OpenStreetMap data only — no mivport details yet.</p>
      </Show>
      <Show when={d().attribution?.trim()}>
        <p class="text-[10px] leading-tight text-fg-3">{d().attribution.trim()}</p>
      </Show>
    </div>
  );
};
