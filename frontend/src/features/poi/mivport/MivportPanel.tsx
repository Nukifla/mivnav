// The one mivport panel App mounts: the place editor, adding a photo, or a
// place's history. Docked on desktop and a sheet on a phone, like the mark
// list. Hidden (not closed) while the editor's pin is positioned on the
// chart, so the draft survives the round trip.

import { Match, Show, Switch, type Component } from "solid-js";
import { useBackDismiss } from "../../../core/chrome/backStack";
import DockPanel from "../../../core/chrome/DockPanel";
import Sheet from "../../../core/chrome/Sheet";
import { isCompact } from "../../../core/media";
import type { MivportEditing } from "./editing";
import { History } from "./History";
import { PhotoUpload } from "./PhotoUpload";
import { PlaceEditor } from "./PlaceEditor";

const titleOf = (e: MivportEditing): string => {
  const v = e.panel();
  if (!v) return "mivport";
  if (v.view === "edit") return v.title;
  if (v.view === "photo") return v.name ? `Add a photo: ${v.name}` : "Add a photo";
  return v.name ? `History: ${v.name}` : "History";
};

const MivportPanel: Component<{ editing: MivportEditing }> = (props) => {
  const e = props.editing;
  const close = () => e.closePanel();
  useBackDismiss(() => e.panelOpen(), close);

  const Body: Component = () => (
    <Switch>
      <Match when={e.panel()?.view === "edit" && e.registry() && e.origin() && e.draft()}>
        <PlaceEditor
          registry={e.registry()!}
          origin={e.origin()!}
          draft={e.draft()!}
          onDraft={e.setDraft}
          onPin={e.startPin}
          onCancel={close}
          onSave={e.saveDraft}
        />
      </Match>
      <Match when={(() => { const v = e.panel(); return v?.view === "photo" ? v : undefined; })()}>
        {(v) => <PhotoUpload editing={e} placeId={v().placeId} setId={v().set} onDone={close} />}
      </Match>
      <Match when={(() => { const v = e.panel(); return v?.view === "history" ? v : undefined; })()}>
        {(v) => <History api={e.api} placeId={v().placeId} />}
      </Match>
    </Switch>
  );

  return (
    <Show
      when={isCompact()}
      fallback={
        <DockPanel open={e.panelOpen()} onClose={close} title={titleOf(e)} side="left">
          <Body />
        </DockPanel>
      }
    >
      <Sheet open={e.panelOpen()} onOpenChange={(open) => !open && close()} title={titleOf(e)} modal>
        <Body />
      </Sheet>
    </Show>
  );
};

export default MivportPanel;
