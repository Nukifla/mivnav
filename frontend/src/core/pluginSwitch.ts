// The plugins installed on the boat's server and their on/off switch
// (`/plugins`, Settings → Plugins). Boat-wide, on the server
// (`Config.plugins_disabled`): a plugin's backend half is shared by every
// screen. Read at boot (index.tsx, before plugins are registered); a screen
// that can't reach the server boots with the list it last saw.

export interface InstalledPlugin {
  id: string;
  label: string;
  enabled: boolean;
}

const DISABLED_KEY = "mivnav.plugins.disabled";

function cachedDisabled(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DISABLED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function cacheDisabled(list: readonly InstalledPlugin[]): void {
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify(list.filter((p) => !p.enabled).map((p) => p.id)));
  } catch {
    // private window / blocked storage: next boot asks the server again
  }
}

export async function listInstalledPlugins(timeoutMs = 3000): Promise<InstalledPlugin[]> {
  const res = await fetch("/api/plugins", { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET /plugins: ${res.status}`);
  const list = ((await res.json()) as { plugins: InstalledPlugin[] }).plugins;
  cacheDisabled(list);
  return list;
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<InstalledPlugin[]> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`PUT /plugins/${id}: ${res.status}`);
  const list = ((await res.json()) as { plugins: InstalledPlugin[] }).plugins;
  cacheDisabled(list);
  return list;
}

/** The plugins switched off: the server's answer, or the last one seen. */
export async function disabledPlugins(timeoutMs?: number): Promise<Set<string>> {
  try {
    const list = await listInstalledPlugins(timeoutMs);
    return new Set(list.filter((p) => !p.enabled).map((p) => p.id));
  } catch {
    return cachedDisabled();
  }
}
