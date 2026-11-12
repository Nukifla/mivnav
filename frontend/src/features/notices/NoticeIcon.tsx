// A notice's glyph for the panel, list rows and search rows: the SAME `Prim`
// list the map badge strokes (./icons.ts `noticeGlyphFor`), drawn as SVG via
// POI's `poiGlyphIcon`, in the family colour of the active palette — so the
// panel's icon and the map marker are one shape and one colour.

import type { Component } from "solid-js";
import type { InfoIconProps } from "../../core/info/types";
import { noticesColors, type Palette } from "../../core/style/colors";
import { poiGlyphIcon } from "../poi/PoiGlyphIcon";
import { noticeGlyphFor } from "./icons";
import type { NoticeColourKey } from "./time";

export function noticeIconComponent(
  cls: unknown,
  fc: NoticeColourKey,
  palette: () => Palette,
): Component<InfoIconProps> {
  const Glyph = poiGlyphIcon(noticeGlyphFor(cls));
  // `display: contents`: the span only carries `color` down to the SVG's
  // `currentColor`; the box is still the caller-sized svg itself.
  return (props) => (
    <span class="contents" style={{ color: noticesColors(palette())[fc] }}>
      <Glyph class={props.class} />
    </span>
  );
}
