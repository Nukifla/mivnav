// The o-charts licence texts the UI shows, defined once. See
// docs/ocharts-licence-compliance-plan.md (W4–W6).

import type { components } from "../api.generated";

/** o-charts' own wording, VERBATIM from their licence policy — do not
 * paraphrase, shorten or translate it. Shown in the shop window, next to
 * the install-time EULA accept button, and on the Chart licences page. */
export const NOT_OFFICIAL_CHARTS = "o-charts sets are not official charts under carriage requirements.";

/** One installed licensed set, as `GET /api/ocharts/licences` lists it. */
export type Licence = components["schemas"]["LicenceOut"];

/** When (and how) a set's licence agreement was accepted, in words. The
 * date is the server's record; a set installed before acceptance was
 * recorded at install says so rather than inventing one. */
export function acceptedText(l: Licence, locale?: string): string {
  if (l.eula_id == null) return "Ships no licence agreement.";
  if (l.accepted_at == null) return "Installed before acceptance was recorded.";
  const date = new Date(l.accepted_at * 1000).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return l.accepted_via === "device"
    ? `Accepted ${date} (on a registered screen).`
    : `Accepted ${date}, before install.`;
}
