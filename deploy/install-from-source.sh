#!/usr/bin/env bash
#
# install-from-source.sh — install (or update) mivnav ON THE PI, from a git
# clone, building everything there. For developers and for running unreleased
# code; most users want the prebuilt release installer, deploy/install.sh.
#
#     git clone https://github.com/nukifla/mivnav.git ~/mivnav
#     ~/mivnav/deploy/install-from-source.sh
#
# To update later: `git -C ~/mivnav pull && ~/mivnav/deploy/install-from-source.sh`.
# (Running this over a release install switches the service back to the
# checkout; running deploy/install.sh switches it to /opt/mivnav again.)
#
# Everything is built on the Pi itself, so no second machine is needed:
#   1. install-deps.sh — Rust, uv, a C compiler, pmtiles (one-time, idempotent)
#   2. bun             — builds the web UI (one-time, into ~/.bun)
#   3. the web UI      — `bun install` + `vite build` → frontend/dist
#   4. install-service.sh — the same on-Pi steps `just deploy` runs: native
#      wheel build, S-52 tables, oexserverd, config bootstrap, systemd unit.
#
# The first run compiles the Rust chart engine and takes a while (on the order
# of 10+ minutes on a Pi 5); later runs are incremental. Needs sudo + network.
# The developer path (`just deploy` from a dev box) skips step 2–3 on the Pi.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '==> %s\n' "$*"; }

[ "$(id -u)" -ne 0 ] || {
    echo "ERROR: run as the user the service should run as (e.g. pi), not root — it uses sudo itself" >&2
    exit 1
}

bash "$DIR/deploy/install-deps.sh"

# bun: builds the frontend. Per-user install, like rustup; only needed at
# install time — the service serves the prebuilt dist and never runs bun.
if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/bun" ]; then
    log "bun: installing (per-user, ~/.bun)"
    curl --proto '=https' --tlsv1.2 -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"

log "Building the web UI in $DIR/frontend"
( cd "$DIR/frontend" && bun install --frozen-lockfile && bun run build )

bash "$DIR/deploy/install-service.sh"
