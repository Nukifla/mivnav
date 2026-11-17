// Settings → mivport: the mivport server, the boat's one account (log in,
// register, or log in on a phone with a device code; log out), and the
// outbox — what waits for upload, what mivport refused (with Discard), and
// what was uploaded recently — with "Sync now" and the last sync.
//
// The account is boat-wide: the boat's server holds the token, so every
// screen is logged in as the same user, and uploads happen with no screen
// open (docs/architecture/mivport-editing.md).

import UserRound from "lucide-solid/icons/user-round";
import { createSignal, For, onCleanup, Show, type Component } from "solid-js";
import { AccordionSection } from "../../../core/ui/Accordion";
import { Button } from "../../../core/ui/Button";
import { Segmented } from "../../../core/ui/SegmentedControl";
import type { SettingsCtx } from "../../../core/settings/ctx";
import type { MivportEditing } from "./editing";
import { accountStatus, ago, canDiscard, conflictLines, outboxGroups, wireTime } from "./model";
import type { MivportOutboxItem } from "./types";

const SCOPE = "mivport";
const fieldCls =
  "mt-1 w-full rounded border border-line bg-chrome px-2 py-1 text-fg focus:border-accent focus:outline-none disabled:opacity-40 pointer-coarse:py-2";
const LINK = "break-all text-accent underline decoration-dotted underline-offset-2";

const message = (e: unknown) => (e instanceof Error && e.message ? e.message : "The boat’s server didn’t answer.");

/** The mivport server URLs, written to the boat's config. */
const ServerFields: Component<{ ctx: SettingsCtx }> = (props) => {
  const cfg = () => props.ctx.cfg;
  const mv = () => cfg()?.config()?.mivport;
  const save = (patch: { base_url?: string; web_url?: string }) =>
    void cfg().patch({ mivport: patch }, { scope: SCOPE, done: "Saved." });
  return (
    <Show
      when={cfg()?.config()}
      fallback={<p class="text-xs text-fg-3">The boat’s server settings can’t be read right now.</p>}
    >
      <label class="block">
        <span class="text-xs text-fg-2">mivport server</span>
        <input
          type="url"
          class={fieldCls}
          placeholder="https://mivport.example"
          disabled={cfg().busy()}
          value={mv()?.base_url ?? ""}
          onChange={(e) => {
            const v = e.currentTarget.value.trim();
            if (v) save({ base_url: v });
          }}
        />
      </label>
      <label class="block">
        <span class="text-xs text-fg-2">Web client (for “Open in mivport” links; optional)</span>
        <input
          type="url"
          class={fieldCls}
          placeholder="none"
          disabled={cfg().busy()}
          value={mv()?.web_url ?? ""}
          onChange={(e) => save({ web_url: e.currentTarget.value.trim() })}
        />
      </label>
      <Show when={cfg().scope() === SCOPE}>
        <Show when={cfg().error()}>
          <p class="text-xs text-alarm">{cfg().error()}</p>
        </Show>
        <Show when={cfg().status()}>
          <p class="text-xs text-ok">{cfg().status()}</p>
        </Show>
      </Show>
    </Show>
  );
};

type LoginTab = "login" | "register" | "device";

/** Logged out: log in, register, or log in with a code approved on a phone. */
const LoginForm: Component<{ editing: MivportEditing }> = (props) => {
  const [tab, setTab] = createSignal<LoginTab>("login");
  const [user, setUser] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      setPassword("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const device = () => props.editing.account()?.device;
  // While a device login waits, ask the boat every few seconds whether the
  // phone approved it.
  const poll = setInterval(() => {
    if (device()) void props.editing.refreshAccount();
  }, 3000);
  onCleanup(() => clearInterval(poll));

  return (
    <div class="space-y-2">
      <Segmented<LoginTab>
        value={tab()}
        onChange={setTab}
        label="Account"
        labelClass="sr-only"
        options={[
          { value: "login", label: "Log in" },
          { value: "register", label: "Register" },
          { value: "device", label: "On a phone" },
        ]}
      />
      <Show
        when={tab() !== "device"}
        fallback={
          <div class="space-y-2">
            <Show
              when={device()}
              fallback={
                <>
                  <p class="text-xs text-fg-2">
                    Get a code, open the link on a phone where you are logged in to mivport, and approve it there.
                  </p>
                  <Button size="md" disabled={busy()} onClick={() => void run(props.editing.deviceLogin)}>
                    Get a code
                  </Button>
                </>
              }
            >
              {(d) => (
                <div class="space-y-1 rounded-md border border-line-2 bg-chrome-2 p-3 text-center">
                  <p class="text-xs text-fg-2">Approve this code at</p>
                  <a href={d().verification_url} target="_blank" rel="noopener noreferrer" class={`text-xs ${LINK}`}>
                    {d().verification_url}
                  </a>
                  <p class="select-all font-mono text-3xl font-bold tracking-widest text-fg" aria-label="Device code">
                    {d().user_code}
                  </p>
                  <p class="text-[11px] text-fg-3">Waiting for approval…</p>
                </div>
              )}
            </Show>
          </div>
        }
      >
        <form
          class="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            const u = user().trim();
            if (!u || !password()) {
              setError("Enter a username and a password.");
              return;
            }
            void run(() =>
              tab() === "login"
                ? props.editing.login(u, password())
                : props.editing.register(u, password(), email()),
            );
          }}
        >
          <label class="block">
            <span class="text-xs text-fg-2">Username</span>
            <input
              class={fieldCls}
              autocomplete="username"
              autocapitalize="off"
              spellcheck={false}
              value={user()}
              onInput={(e) => setUser(e.currentTarget.value)}
            />
          </label>
          <label class="block">
            <span class="text-xs text-fg-2">Password</span>
            <input
              type="password"
              class={fieldCls}
              autocomplete={tab() === "login" ? "current-password" : "new-password"}
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
          </label>
          <Show when={tab() === "register"}>
            <label class="block">
              <span class="text-xs text-fg-2">Email (optional, for a lost password)</span>
              <input type="email" class={fieldCls} value={email()} onInput={(e) => setEmail(e.currentTarget.value)} />
            </label>
          </Show>
          <Button type="submit" variant="primary" size="md" disabled={busy()}>
            {tab() === "login" ? "Log in" : "Register and log in"}
          </Button>
        </form>
      </Show>
      <Show when={error()}>
        <p class="text-xs text-alarm">{error()}</p>
      </Show>
      <p class="text-[11px] text-fg-3">
        Logging in needs mivport to be reachable. The login is kept on the boat’s server, so every screen
        uses it, and uploads happen with no screen open.
      </p>
    </div>
  );
};

const STATE_CLASS: Record<string, string> = {
  pending: "text-notice",
  sending: "text-notice",
  failed: "text-alarm",
  done: "text-ok",
};

const OutboxRow: Component<{ item: MivportOutboxItem; onDiscard: (id: string) => void; busy: boolean }> = (props) => {
  const [armed, setArmed] = createSignal(false);
  const when = () => {
    const t = wireTime(props.item.created_at);
    return Number.isFinite(t) ? ago(t) : "";
  };
  return (
    <li class="space-y-1 rounded-md border border-line-2 bg-chrome-2 px-2 py-1.5">
      <div class="flex items-baseline justify-between gap-2">
        <span class="min-w-0 break-words text-xs text-fg">{props.item.summary}</span>
        <span class={`shrink-0 text-[11px] ${STATE_CLASS[props.item.state] ?? "text-fg-3"}`}>
          {props.item.state === "sending" ? "uploading" : when()}
        </span>
      </div>
      <Show when={props.item.error}>
        <p class="break-words text-[11px] text-alarm">{props.item.error}</p>
      </Show>
      <For each={conflictLines(props.item)}>{(line) => <p class="text-[11px] text-fg-2">{line}</p>}</For>
      <Show when={canDiscard(props.item)}>
        <Show
          when={armed()}
          fallback={
            <Button variant="tinted" tone="alarm" disabled={props.busy} onClick={() => setArmed(true)}>
              Discard
            </Button>
          }
        >
          <div class="flex items-center gap-2">
            <span class="text-[11px] text-fg-2">Discard this change on the boat?</span>
            <Button
              variant="danger"
              disabled={props.busy}
              onClick={() => {
                setArmed(false);
                props.onDiscard(props.item.id);
              }}
            >
              Discard
            </Button>
            <Button onClick={() => setArmed(false)}>Keep</Button>
          </div>
        </Show>
      </Show>
    </li>
  );
};

/** What waits, what was refused, what went up. */
const Outbox: Component<{ editing: MivportEditing }> = (props) => {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const groups = () => outboxGroups(props.editing.outbox());
  void props.editing.refreshOutbox();
  // The list moves on its own (the boat uploads in the background).
  const tick = setInterval(() => void props.editing.refreshOutbox(), 10_000);
  onCleanup(() => clearInterval(tick));
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const List: Component<{ title: string; items: MivportOutboxItem[] }> = (p) => (
    <Show when={p.items.length > 0}>
      <div class="space-y-1">
        <p class="text-xs font-medium text-fg-2">
          {p.title} ({p.items.length})
        </p>
        <ul class="space-y-1">
          <For each={p.items}>
            {(item) => (
              <OutboxRow item={item} busy={busy()} onDiscard={(id) => void act(() => props.editing.discard(id))} />
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
  return (
    <div class="space-y-2 border-t border-line-2 pt-2">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-medium text-fg-2">Outbox</span>
        <Button disabled={busy()} onClick={() => void act(props.editing.sync)}>
          {busy() ? "Syncing…" : "Sync now"}
        </Button>
      </div>
      <Show when={error()}>
        <p class="text-xs text-alarm">{error()}</p>
      </Show>
      <List title="Refused by mivport" items={groups().failed} />
      <List title="Waiting for upload" items={groups().waiting} />
      <List title="Uploaded" items={groups().done} />
      <Show when={props.editing.outbox().length === 0}>
        <p class="text-xs text-fg-3">Nothing waiting. Changes made on the boat show here until they are uploaded.</p>
      </Show>
    </div>
  );
};

/** The whole section. */
export const MivportSettingsSection: Component<{ ctx: SettingsCtx; editing: MivportEditing }> = (props) => {
  const acct = () => props.editing.account();
  const [busy, setBusy] = createSignal(false);
  void props.editing.refreshAccount();
  return (
    <AccordionSection value={SCOPE} title="mivport" icon={UserRound}>
      <p class="text-xs text-fg-2">
        mivport is the sailors’ place database the mivport POI dataset comes from. Log in to add and edit places,
        write reviews and add photos from the boat — changes are kept on the boat and uploaded when mivport can be
        reached.
      </p>
      <ServerFields ctx={props.ctx} />
      <div class="space-y-2 border-t border-line-2 pt-2">
        <p class="text-xs text-fg-2">{accountStatus(acct())}</p>
        <Show when={acct()?.last_error}>
          <p class="break-words text-[11px] text-alarm">{acct()!.last_error}</p>
        </Show>
        <Show when={acct()?.logged_in} fallback={<Show when={acct()}><LoginForm editing={props.editing} /></Show>}>
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-fg">
              Logged in as <span class="font-semibold">{acct()!.username}</span>
              <Show when={acct()!.role}> ({acct()!.role})</Show>
            </span>
            <Button
              disabled={busy()}
              onClick={async () => {
                setBusy(true);
                try {
                  await props.editing.logout();
                } catch {
                  // The account line says what the boat knows.
                } finally {
                  setBusy(false);
                }
              }}
            >
              Log out
            </Button>
          </div>
        </Show>
      </div>
      <Outbox editing={props.editing} />
    </AccordionSection>
  );
};
