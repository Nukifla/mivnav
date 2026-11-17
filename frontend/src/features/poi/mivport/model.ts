// The pure rules of mivport editing on the boat: which place actions the
// account may use (mivport's roles), the badge on a locally changed place,
// the outbox as the settings panel lists it, and the account's status line.
// No DOM, no Solid — ./editing.ts and the panels use these.

import type {
  MivportAccount,
  MivportLocalState,
  MivportOutboxItem,
  MivportPlaceDetail,
} from "./types";

// ---------------------------------------------------------------------------
// Roles and place actions

/** mivport's roles, lowest first (mivport README, "Moderation"). */
export const ROLES = ["contributor", "trusted", "moderator", "admin"] as const;

/** `role` is at least `min`. An unknown role counts as a contributor. */
export function roleAtLeast(role: string | null | undefined, min: (typeof ROLES)[number]): boolean {
  const have = ROLES.indexOf((role ?? "") as (typeof ROLES)[number]);
  return Math.max(0, have) >= ROLES.indexOf(min);
}

export type PlaceActionId = "edit" | "delete" | "restore" | "review" | "photo" | "removal" | "history";

/** What the action rules see. */
export interface PlaceActionState {
  account: Pick<MivportAccount, "logged_in" | "online" | "username" | "role"> | undefined;
  /** The place id (`osm:…` for an OSM-only place). */
  ref: string;
  /** The (locally merged) detail, once loaded. */
  detail?: Pick<MivportPlaceDetail, "source" | "deleted" | "created_by" | "rev" | "local">;
}

const isOsmRef = (ref: string) => ref.startsWith("osm:");

/** mivport has its own data for the place (an OSM-only one has none). */
export function isCorePlace(s: Pick<PlaceActionState, "ref" | "detail">): boolean {
  return s.detail ? s.detail.source === "core" : !isOsmRef(s.ref);
}

/**
 * May the account delete (or restore) this place: a trusted user or above
 * any mivport place, a contributor only the ones they created. An OSM-only
 * place can't be deleted by anyone (a moderator can hide it: ask).
 */
export function canDeletePlace(s: PlaceActionState): boolean {
  const a = s.account;
  if (!a?.logged_in || !isCorePlace(s)) return false;
  if (roleAtLeast(a.role, "trusted")) return true;
  const by = s.detail?.created_by;
  return !!by && !!a.username && by === a.username;
}

/**
 * The actions a place offers, in order. Logged out: nothing but its history
 * (online). A deleted place: Restore (when it may), nothing else to edit.
 * Otherwise Edit, Write review, Add photo, then Delete where allowed — or
 * Request removal where not — and History while mivport can be reached
 * (only mivport places with a stored revision have one).
 */
export function placeActions(s: PlaceActionState): PlaceActionId[] {
  const a = s.account;
  const out: PlaceActionId[] = [];
  const history = !!a?.online && isCorePlace(s) && !isOsmRef(s.ref) && s.detail?.rev !== undefined;
  if (!a?.logged_in) return history ? ["history"] : [];
  const mayDelete = canDeletePlace(s);
  if (s.detail?.deleted) {
    if (mayDelete) out.push("restore");
  } else {
    out.push("edit", "review", "photo");
    if (mayDelete) out.push("delete");
  }
  // Reviews and photos of others can always be reported; the place itself
  // only by someone who can't simply delete it.
  out.push("removal");
  if (history) out.push("history");
  return out;
}

// ---------------------------------------------------------------------------
// The local badge

export interface LocalBadge {
  label: string;
  /** A chrome tone: notice (waiting), alarm (refused), ok (uploaded). */
  tone: "notice" | "alarm" | "ok";
  /** One line on what it means. */
  hint: string;
}

/** The badge on a place changed on the boat, or none for a baked one. */
export function localBadge(local: MivportLocalState | undefined, deleted = false): LocalBadge | undefined {
  switch (local) {
    case "pending":
      return {
        label: deleted ? "Deleted · not uploaded" : "Changed · not uploaded",
        tone: "notice",
        hint: "Saved on the boat. Uploaded to mivport when it can be reached.",
      };
    case "failed":
      return {
        label: "Upload refused",
        tone: "alarm",
        hint: "mivport refused this change. See Settings → mivport → Outbox.",
      };
    case "synced":
      return {
        label: deleted ? "Deleted · uploaded" : "Changed · uploaded",
        tone: "ok",
        hint: "Uploaded. The next download of the POI dataset includes it.",
      };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The outbox

/** A time from the wire (epoch seconds or ISO) as epoch ms; NaN if neither. */
export function wireTime(t: number | string | undefined): number {
  if (typeof t === "number") return t * 1000;
  if (typeof t === "string") return new Date(t).getTime();
  return Number.NaN;
}

export interface OutboxGroups {
  /** Waiting or being uploaded. */
  waiting: MivportOutboxItem[];
  failed: MivportOutboxItem[];
  /** Uploaded (kept a few days). */
  done: MivportOutboxItem[];
}

const newestFirst = (a: MivportOutboxItem, b: MivportOutboxItem) =>
  (wireTime(b.created_at) || 0) - (wireTime(a.created_at) || 0);

export function outboxGroups(items: readonly MivportOutboxItem[]): OutboxGroups {
  const sorted = [...items].sort(newestFirst);
  return {
    waiting: sorted.filter((i) => i.state === "pending" || i.state === "sending"),
    failed: sorted.filter((i) => i.state === "failed"),
    done: sorted.filter((i) => i.state === "done"),
  };
}

/** A pending or failed item can be discarded; one being sent or sent can't. */
export const canDiscard = (i: MivportOutboxItem): boolean => i.state === "pending" || i.state === "failed";

/** The conflicts of an uploaded edit, worded. */
export function conflictLines(i: MivportOutboxItem): string[] {
  return (i.conflicts ?? []).map((c) =>
    c.won
      ? `${c.field}: your newer value was kept`
      : `${c.field}: a newer value from someone else was kept`,
  );
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** The account's one-line status: who, online or not, last sync, the queue. */
export function accountStatus(a: MivportAccount | undefined, now = Date.now()): string {
  if (!a) return "The boat’s server isn’t answering.";
  const parts: string[] = [];
  parts.push(a.online ? "mivport reachable" : "mivport not reachable — changes wait on the boat");
  if (typeof a.last_sync === "number" && Number.isFinite(a.last_sync)) {
    parts.push(`last sync ${ago(a.last_sync * 1000, now)}`);
  }
  const { pending, failed } = a.outbox ?? { pending: 0, failed: 0 };
  if (pending) parts.push(`${pending} waiting`);
  if (failed) parts.push(`${failed} refused`);
  return parts.join(" · ");
}

/** `YYYY-MM-DD` of a local date (a review's visit; not UTC's). */
export function today(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A review form's values → the body (stars 1–5, a real date only), or why
 * not. */
export function reviewBody(values: Record<string, string>):
  | { body: { stars: number; body?: string; visited_on?: string } }
  | { error: string } {
  const stars = Number(values.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return { error: "Choose 1 to 5 stars" };
  const text = (values.body ?? "").trim();
  const day = (values.visited_on ?? "").trim();
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: "Visited on: a date like 2026-07-01" };
  return { body: { stars, ...(text ? { body: text } : {}), ...(day ? { visited_on: day } : {}) } };
}

/** The local layer's `hide` and features, cleaned: string refs only. */
export function cleanHide(hide: unknown): string[] {
  return Array.isArray(hide) ? hide.filter((r): r is string => typeof r === "string" && r.length > 0) : [];
}

// ---------------------------------------------------------------------------
// The photo licence notice

/** Per device: this screen's skipper has read the CC BY-SA notice once. */
export const PHOTO_LICENCE_ACK_KEY = "mivnav.mivport.photoLicenceAck";

type KeyStore = Pick<Storage, "getItem" | "setItem">;

const defaultStore = (): KeyStore | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

/** Whether the licence notice was accepted on this device. A storage that
 * can't be read counts as not yet: the notice shows again, nothing breaks. */
export function photoLicenceAccepted(store: KeyStore | undefined = defaultStore()): boolean {
  try {
    return store?.getItem(PHOTO_LICENCE_ACK_KEY) === "1";
  } catch {
    return false;
  }
}

export function acceptPhotoLicence(store: KeyStore | undefined = defaultStore()): void {
  try {
    store?.setItem(PHOTO_LICENCE_ACK_KEY, "1");
  } catch {
    // Private mode: asked again next time.
  }
}
