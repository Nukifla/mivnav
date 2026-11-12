// `queryAt` only knows "there is wind here"; the FROM-bearing lands later via
// the same grid/API read `detail` uses (weather/provider.ts), so this
// resolves it lazily, gliding from a static up-vane to the real bearing.

import { createResource, type Component } from "solid-js";
import type { InfoIconProps } from "../../core/info/types";
import { WindVane } from "./WindVane";

/**
 * `resolve` is the provider's async from-bearing read (`resolveWindDir`).
 * `loading`, if given, is the provider's "readout still filling in" flag
 * (`extrasPending`); the vane spins while either it or the bearing is pending.
 */
export function createWindVaneIcon(
  resolve: () => Promise<number | undefined>,
  loading?: () => boolean,
): Component<InfoIconProps> {
  return (props) => {
    const [bearing] = createResource(resolve);
    const spin = () => bearing.loading || (loading?.() ?? false);
    return <WindVane bearing={bearing() ?? 0} class={props.class} title="Wind direction" spin={spin()} />;
  };
}
