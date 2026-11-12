#!/usr/bin/env bash
#
# install-service.sh — the ON-PI half of an install: build the backend venv,
# fetch the runtime assets, bootstrap config, install + (re)start the service.
#
# Shared by both install paths so they cannot drift:
#   - `just deploy` (dev box) rsyncs the tree to the Pi, then runs this there.
#   - `deploy/install-from-source.sh` (on the Pi, from a git clone) builds the
#     frontend locally, then runs this.
# (Release installs — deploy/install.sh — use prebuilt bundles instead; the
# steps both kinds share live in deploy/lib.sh.)
#
# Expects to live at <checkout>/deploy/ with <checkout>/backend, chartcore/ and
# a built frontend/dist next to it. Runs as the user the service will run as
# (needs sudo). Idempotent: a re-run rebuilds the wheel incrementally, leaves
# config and fetched assets alone, and restarts the service.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Shared steps (S-52 + oexserverd fetch, config bootstrap, unit rendering).
# shellcheck source=deploy/lib.sh
. "$DIR/deploy/lib.sh"
SVC_USER="$(id -un)"
SVC_GROUP="$(id -gn)"

[ -d "$DIR/frontend/dist" ] || {
    echo "ERROR: $DIR/frontend/dist is missing — build the frontend first" >&2
    exit 1
}

# cargo (rustup, installed by install-deps.sh) for the native chartcore wheel.
# shellcheck source=/dev/null
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

# Build the chartcore wheel natively (arm64, gdal-free) + resolve the venv.
# `--reinstall-package chartcore` FORCES a rebuild+reinstall of the wheel from
# the current source on EVERY run. Without it, uv treats chartcore as
# up-to-date whenever its version string is unchanged and keeps the OLD .so,
# even though the Rust source changed — the stale-wheel hazard, which serves a
# pre-change module ("AttributeError: module 'chartcore' has no attribute
# 'serve_tile'") until the next manual sync. cargo's target/ cache is preserved,
# so unchanged crates don't recompile — only the cheap maturin repackage is paid
# when nothing changed; correctness over that second. `--verbose` streams the
# cargo/maturin compile so the slow first build shows progress, not silence.
echo "==> uv sync (native wheel build, forced chartcore reinstall) in $DIR/backend"
( cd "$DIR/backend" && /usr/local/bin/uv sync --frozen --reinstall-package chartcore --verbose )

# S-52 presentation-library tables + the o-charts DRM daemon, into the native
# host paths config.default.json names. Fetched once (skipped when present), so
# this needs network only the first time and works offline forever after.
sudo install -d -o "$SVC_USER" -g "$SVC_GROUP" -m0755 /var/lib/mivnav/s57data
sudo install -d -o "$SVC_USER" -g "$SVC_GROUP" -m0755 /var/cache/mivnav/oexserverd
mivnav_fetch_assets "$DIR/backend"

# Bootstrap config ONLY if none exists — never clobber a live config or the
# sibling credentials.json.
mivnav_bootstrap_config "$DIR/deploy"

# The one service: runs the native backend (UI + API on :8230) at boot.
# Rendered for whoever is installing and wherever the checkout lives; for
# pi + /home/pi/mivnav it is byte-identical to the shipped file.
unit="$(mktemp)"
trap 'rm -f "$unit"' EXIT
mivnav_render_unit "$DIR/deploy" "$DIR" "$unit"
sudo install -m0644 "$unit" /etc/systemd/system/mivnav.service
sudo systemctl daemon-reload
sudo systemctl enable mivnav.service
sudo systemctl restart mivnav.service

echo "==> Installed. Open http://$(hostname -I | awk '{print $1}'):8230/ from any device on the boat network."
