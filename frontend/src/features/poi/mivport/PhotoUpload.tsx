// Add a photo to a mivport place: the browser makes the two JPEGs mivport
// takes (./photo.ts) as soon as a file is picked, so the form can say what
// will be sent; the time and position the camera recorded go along (the
// position only if the skipper keeps it). Before the first upload on this
// screen the skipper confirms the photo is their own and that it is
// published under CC BY-SA 4.0 — after the poi-testclient's photo form.
// The upload itself is queued on the boat like every other write.

import { createSignal, For, Show, type Component } from "solid-js";
import { Button } from "../../../core/ui/Button";
import type { MivportEditing } from "./editing";
import { acceptPhotoLicence, photoLicenceAccepted } from "./model";
import { PHOTO_LICENCE, photoInfo, preparePhoto, type PreparedPhoto } from "./photo";
import { photoSrc } from "./detail";

const fieldCls =
  "w-full rounded-md border border-line bg-chrome-2 px-2.5 py-1.5 text-xs text-fg placeholder:text-fg-3 focus-ring pointer-coarse:py-2 pointer-coarse:text-sm";
const LINK = "text-accent underline decoration-dotted underline-offset-2";

export const PhotoUpload: Component<{
  editing: MivportEditing;
  placeId: string;
  setId: string;
  onDone: () => void;
}> = (props) => {
  const [photo, setPhoto] = createSignal<PreparedPhoto>();
  const [info, setInfo] = createSignal("");
  const [caption, setCaption] = createSignal("");
  const [usePos, setUsePos] = createSignal(true);
  const [agreed, setAgreed] = createSignal(photoLicenceAccepted());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const firstTime = !agreed();
  let job = 0;

  const pick = (file: File | undefined) => {
    setPhoto(undefined);
    setError("");
    if (!file) {
      setInfo("");
      return;
    }
    setInfo("Preparing…");
    const mine = ++job;
    preparePhoto(file).then(
      (p) => {
        if (mine !== job) return;
        setPhoto(p);
        setInfo(photoInfo(p));
      },
      (e: unknown) => {
        if (mine === job) setInfo(e instanceof Error ? e.message : "Couldn’t read that image.");
      },
    );
  };

  const upload = async () => {
    const p = photo();
    if (!p) return;
    if (!agreed()) {
      setError("Confirm the photo is your own first.");
      return;
    }
    acceptPhotoLicence();
    setBusy(true);
    const ok = await props.editing.uploadPhoto(props.placeId, {
      view: p.view,
      thumb: p.thumb,
      ...(caption().trim() ? { caption: caption().trim() } : {}),
      ...(p.takenAt ? { taken_at: p.takenAt } : {}),
      ...(usePos() && p.lat !== undefined && p.lon !== undefined ? { lat: p.lat, lon: p.lon } : {}),
    });
    setBusy(false);
    if (ok) props.onDone();
    else setError("Not saved.");
  };

  const me = () => props.editing.account()?.username;
  const mine = () =>
    (props.editing.cachedDetail(props.setId, props.placeId)?.photos ?? []).filter((p) => me() && p.user === me());

  return (
    <div class="flex flex-col gap-3">
      <label class="block space-y-1">
        <span class="text-xs text-fg-2">Photo</span>
        <input
          type="file"
          accept="image/*"
          class="block w-full text-xs text-fg-2 file:mr-2 file:rounded-md file:border file:border-line file:bg-chrome-2 file:px-3 file:py-1.5 file:text-fg pointer-coarse:file:py-2.5"
          onChange={(e) => pick(e.currentTarget.files?.[0])}
        />
      </label>
      <Show when={info()}>
        <p class="text-[11px] text-fg-2" aria-live="polite">
          {info()}
        </p>
      </Show>
      <Show when={photo()?.lat !== undefined}>
        <label class="flex items-start gap-2 text-xs text-fg">
          <input
            type="checkbox"
            class="mt-0.5 size-4 pointer-coarse:size-5"
            checked={usePos()}
            onChange={(e) => setUsePos(e.currentTarget.checked)}
          />
          <span>
            Include where it was taken
            <span class="block text-[11px] text-fg-3">
              {photo()!.lat!.toFixed(5)}, {photo()!.lon!.toFixed(5)}, from the photo
            </span>
          </span>
        </label>
      </Show>
      <label class="block space-y-1">
        <span class="text-xs text-fg-2">Caption</span>
        <input class={fieldCls} maxLength={500} value={caption()} onInput={(e) => setCaption(e.currentTarget.value)} />
      </label>
      <div class="space-y-1 rounded-md border border-line-2 bg-chrome-2 p-2">
        <p class="text-[11px] text-fg-2">
          The photo must be your own. It is published under{" "}
          <a href={PHOTO_LICENCE.url} target="_blank" rel="noopener noreferrer license" class={LINK}>
            {PHOTO_LICENCE.name}
          </a>{" "}
          with your username{me() ? ` (${me()})` : ""} as credit, and anyone may reuse it on those terms.
        </p>
        <Show when={firstTime}>
          <label class="flex items-start gap-2 text-xs text-fg">
            <input
              type="checkbox"
              class="mt-0.5 size-4 pointer-coarse:size-5"
              checked={agreed()}
              onChange={(e) => setAgreed(e.currentTarget.checked)}
            />
            <span>I took this photo, and agree to publish it under {PHOTO_LICENCE.name}.</span>
          </label>
        </Show>
      </div>
      <Show when={error()}>
        <p class="text-xs text-alarm">{error()}</p>
      </Show>
      <div class="flex justify-end gap-2">
        <Button size="md" onClick={() => props.onDone()}>
          Cancel
        </Button>
        <Button variant="primary" size="md" disabled={busy() || !photo() || !agreed()} onClick={() => void upload()}>
          {busy() ? "Saving…" : "Add photo"}
        </Button>
      </div>
      <Show when={mine().length > 0}>
        <div class="space-y-1.5 border-t border-line-2 pt-2">
          <p class="text-xs font-medium text-fg-2">Your photos of this place</p>
          <For each={mine()}>
            {(p) => {
              const [armed, setArmed] = createSignal(false);
              return (
                <div class="flex items-center gap-2">
                  <Show when={photoSrc(p.thumb_url) ?? photoSrc(p.url)}>
                    {(src) => <img src={src()} alt={p.caption ?? ""} class="size-12 shrink-0 rounded object-cover" />}
                  </Show>
                  <span class="min-w-0 flex-1 truncate text-xs text-fg">{p.caption ?? "Photo"}</span>
                  <Show
                    when={armed()}
                    fallback={
                      <Button variant="tinted" tone="alarm" onClick={() => setArmed(true)}>
                        Remove
                      </Button>
                    }
                  >
                    <Button
                      variant="danger"
                      onClick={() => {
                        setArmed(false);
                        void props.editing.deletePhoto(props.placeId, p.id);
                      }}
                    >
                      Remove for good
                    </Button>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
};
