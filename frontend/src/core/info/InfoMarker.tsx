// "This one, here": magenta+halo, not a taste — S-52 reserves magenta for
// pointing something out (not depicting it), never red, which means
// *danger* here. A ring, not a pin, so the tapped object stays visible.

import { type Accessor, type Component } from "solid-js";
import type { InfoMarkerModel } from "./marker";
import { MapMarker, type MapMarkerMap } from "../map/MapMarker";
import { MARKER_HALO, markerMagenta, type Palette } from "../style/colors";

// Placement is MapMarker's job; this only draws the ring, following the
// model's live `lngLat`. `palette` is read live so the ring stays the
// ACTIVE theme's CHMGD — same token as the selection wash (./highlight.ts).
const InfoMarker: Component<{
  map: MapMarkerMap;
  model: InfoMarkerModel;
  palette: Accessor<Palette>;
}> = (props) => (
  <MapMarker
    map={props.map}
    lngLat={props.model.lngLat}
    // pointer-events-none: mustn't swallow the tap that placed the marker.
    class="pointer-events-none z-10"
  >
    {/* pop-in replays per fresh marker: MapMarker unmounts the child with no point. */}
    <svg
      class="mivnav-pop-in"
      width="34"
      height="34"
      viewBox="-17 -17 34 34"
      style={{ display: "block" }}
      aria-hidden="true"
    >
      <g fill="none" stroke={MARKER_HALO} stroke-width="5" stroke-linecap="round">
        <circle r="9.5" />
        <path d="M0 -16.5V-13M0 13v3.5M-16.5 0h3.5M13 0h3.5" />
      </g>
      <g fill="none" stroke={markerMagenta(props.palette())} stroke-width="2.5" stroke-linecap="round">
        <circle r="9.5" />
        <path d="M0 -16.5V-13M0 13v3.5M-16.5 0h3.5M13 0h3.5" />
      </g>
    </svg>
  </MapMarker>
);

export default InfoMarker;
