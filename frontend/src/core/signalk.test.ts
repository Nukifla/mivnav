/**
 * The SignalK client, now that the connection is the server's.
 *
 * Two things are worth pinning here. The first is the regression: the old
 * `targets()` deleted stale vessels from its own map *while being read* —
 * a side-effecting, non-idempotent accessor, which under Solid's
 * re-evaluation is a bug waiting for a second reader. Staleness is the
 * server's business now (backend/mivnav/signalk/model.py), and these
 * accessors decide nothing.
 *
 * The second is that the two "not connected" states are different things
 * and must not be conflated: SignalK being off is a fact about the boat
 * that only the backend can report, and our own socket dropping is not
 * evidence of it.
 *
 * The socket is injected, so nothing here mocks a module — bun shares one
 * registry across the whole run and a mock.module would leak into every
 * other test file.
 *
 * NB: needs `--conditions=browser` (see the `test` script). Bare `bun test`
 * resolves solid-js's `node` export — the SSR build — and the reactive
 * assertions would be vacuous.
 */

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createSignalK, streamUrl, type SignalKState } from "./signalk";

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {}

  close() {
    this.closed = true;
  }

  /** The backend pushing a snapshot. */
  deliver(snapshot: unknown) {
    this.onmessage?.({ data: JSON.stringify(snapshot) });
  }
}

const BOAT = { lng: 12.6, lat: 55.9, headingDeg: 90 };
const TARGET = { lng: 12.7, lat: 56.0, name: "Kraka" };

function harness(): { state: SignalKState; socket: FakeSocket; dispose: () => void } {
  const sockets: FakeSocket[] = [];
  let state!: SignalKState;
  const dispose = createRoot((dispose) => {
    state = createSignalK({
      url: "ws://boat/api/signalk/stream",
      open: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    return dispose;
  });
  return { state, socket: sockets[0], dispose };
}

describe("streamUrl", () => {
  test("is the backend's stream on the page's own origin", () => {
    expect(streamUrl("http://boat.local:5173")).toBe("ws://boat.local:5173/api/signalk/stream");
    expect(streamUrl("https://nav.example.org")).toBe(
      "wss://nav.example.org/api/signalk/stream",
    );
  });
});

describe("createSignalK", () => {
  test("a snapshot becomes the own ship, the targets and the status", () => {
    const { state, socket, dispose } = harness();
    expect(state.status()).toBe("connecting"); // nothing has said otherwise yet

    socket.deliver({ status: "connected", self: BOAT, targets: [TARGET] });

    expect(state.status()).toBe("connected");
    expect(state.self()).toEqual(BOAT);
    expect(state.targets()).toEqual([TARGET]);
    dispose();
  });

  test("reading targets() decides nothing and drops nothing", () => {
    // The regression. The old accessor expired stale vessels as a side
    // effect of being read; reads are now plain signal reads, and the only
    // thing that can change what is on the chart is the server saying so.
    const { state, socket, dispose } = harness();
    socket.deliver({ status: "connected", self: BOAT, targets: [TARGET] });

    const first = state.targets();
    for (let i = 0; i < 10; i++) expect(state.targets()).toBe(first);
    expect(state.targets()).toEqual([TARGET]);

    socket.deliver({ status: "connected", self: BOAT, targets: [] });
    expect(state.targets()).toEqual([]);
    dispose();
  });

  test("no SignalK box on this boat is reported as off, not as an error", () => {
    const { state, socket, dispose } = harness();
    socket.deliver({ status: "off", self: null, targets: [] });
    expect(state.status()).toBe("off");
    expect(state.self()).toBeNull();
    dispose();
  });

  test("losing our own socket is not evidence the boat has no SignalK", () => {
    const { state, socket, dispose } = harness();
    socket.deliver({ status: "connected", self: BOAT, targets: [TARGET] });

    socket.onclose?.(); // the backend restarted, or the wifi dropped

    // "connecting" — claiming "off" would assert something about the boat
    // that we have precisely no information about.
    expect(state.status()).toBe("connecting");
    dispose();
  });

  test("the active course is null until the backend reports one, then passes through raw", () => {
    const { state, socket, dispose } = harness();
    socket.deliver({ status: "connected", self: BOAT, targets: [] });
    expect(state.course()).toBeNull();

    socket.deliver({
      status: "connected",
      self: BOAT,
      targets: [],
      course: { nextLat: 56.0, nextLng: 12.7 },
    });
    expect(state.course()).toEqual({ nextLat: 56.0, nextLng: 12.7 });

    socket.deliver({ status: "connected", self: BOAT, targets: [], course: null });
    expect(state.course()).toBeNull();
    dispose();
  });

  test("garbage on the wire is ignored, not fatal", () => {
    const { state, socket, dispose } = harness();
    socket.deliver({ status: "connected", self: BOAT, targets: [TARGET] });
    socket.onmessage?.({ data: "not json" });
    expect(state.self()).toEqual(BOAT);
    dispose();
  });

  test("disposal closes the socket", () => {
    const { socket, dispose } = harness();
    dispose();
    expect(socket.closed).toBe(true);
  });
});
