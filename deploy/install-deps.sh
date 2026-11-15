#!/usr/bin/env bash
#
# install-deps.sh — one-time host setup for the NATIVE mivnav deploy.
#
# TARGET: OpenPlotter, i.e. Raspberry Pi OS / Debian *Bookworm*, 64-bit
# (aarch64), apt-based. OpenPlotter already ships SignalK, node and a system
# Python — mivnav no longer touches any of that.
#
# NATIVE, not containerized (#GD3): mivnav now builds and runs directly on the
# Pi. GDAL is gone from the build (serve-time geometry is pure Rust — `geo` +
# `i_overlay`; the S-57 ingest path is feature-gated out of the wheel), so there
# is no GDAL version floor to satisfy and no osgeo/gdal container. chartcore fetches/runs
# the native arm64 `oexserverd` (o-charts_pi libs/oeserverd/linuxarm64), so
# there is no qemu/amd64 emulation either. Running natively keeps the Pi's real
# o-charts fingerprint (no Docker seat burn).
#
# `just deploy` runs `uv sync` ON THE PI, which builds the chartcore pyo3 wheel
# from source. So the host needs a BUILD toolchain, not a container runtime:
#
#   1. Rust (rustup, stable) — builds the chartcore wheel. rustup, not apt's
#      Rust: Bookworm's is too old, and rustup matches the dev box exactly.
#   2. uv (astral) — resolves the backend venv and builds/links the wheel.
#      Installed to /usr/local/bin so the systemd unit can call it by path.
#   3. build-essential + pkg-config — the C linker/toolchain the pyo3 wheel
#      needs. Serve-time geometry is now PURE RUST (`geo` + `i_overlay`), so
#      there is NO geometry C library to build: no libgeos, and — the point —
#      NO cmake. Bookworm's apt can install neither `libgeos-dev` nor (on the
#      target Pi) cmake, and now it needs neither. Only a C compiler for pyo3.
#
# And one RUNTIME dependency, not a build one:
#
#   4. pmtiles (go-pmtiles) — the OSM-world-basemap ingest shells out to
#      `pmtiles extract` to pull a zoom-capped sub-pyramid out of the ~137 GB
#      Protomaps daily build over HTTP range requests (see
#      mivnav/features/osm_world/ingest.py for why an extract and not a bake).
#      It has to be the Go CLI: PyPI's `pmtiles` package (3.7.0) ships only
#      convert/serve/show — it has no extract at all, and the clustered
#      range-request fetch that makes this cost megabytes instead of gigabytes
#      is exactly what would have to be reimplemented. Not in Debian either, so
#      it comes from the upstream GitHub release tarball, into /usr/local/bin
#      (on systemd's default PATH, which is how the service resolves the bare
#      `pmtiles` name in osm_world's config).
#
# RUN IT ON THE PI. Normally via `just setup-pi-deps` (which ssh's it over);
# it can also be copied to the Pi and run directly as the `pi` user. It uses
# sudo for apt and the /usr/local/bin uv install, so `pi` needs passwordless or
# interactive sudo.
#
# Idempotent: every step checks before acting, so a second run is a clean no-op.
#
# `--runtime`: what a RELEASE install (deploy/install.sh) needs — the bundle
# ships a prebuilt chartcore wheel and web UI, so no Rust, no C compiler and
# no bun: only uv, pmtiles, polkitd (the updater's permission rule, see
# deploy/50-mivnav.rules) and libusb-0.1-4 (the o-charts decoder). Without
# the flag: the full build toolchain for a source install (`just
# setup-pi-deps`, install-from-source.sh).

set -euo pipefail

MODE=build
case "${1:-}" in
    --runtime) MODE=runtime ;;
    "") ;;
    *) printf 'usage: %s [--runtime]\n' "$0" >&2; exit 2 ;;
esac

log()  { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "This installer targets Debian/OpenPlotter on the Pi; not $(uname -s)."

ARCH="$(uname -m)"
if [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "arm64" ]; then
    warn "expected an aarch64 Pi; found $ARCH. The native build works on any"
    warn "arch chartcore supports (x86_64 or aarch64), so continuing."
fi

# ── apt build deps (C/C++ toolchain for the pyo3 wheel — no cmake, no libgeos) ─
# A release install needs none of that, only polkitd for the updater's rule
# (present on OpenPlotter's desktop image, not necessarily on a Lite one).
# Both modes need libusb-0.1-4: the o-charts dongle lib oexserverd loads
# (libsglarm64-*.so) links libusb-0.1.so.4, and upstream ships it only for
# x86_64. OpenPlotter happens to have it; a Lite / Trixie image may not.
if [ "$MODE" = runtime ]; then
    APT_PKGS=(polkitd libusb-0.1-4)
else
    APT_PKGS=(build-essential pkg-config libusb-0.1-4)
fi
missing=()
for pkg in "${APT_PKGS[@]}"; do
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
done
if [ "${#missing[@]}" -gt 0 ]; then
    log "apt: installing ${missing[*]}"
    sudo apt-get update
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
else
    log "apt: ${APT_PKGS[*]} already installed"
fi

# ── Rust (rustup, stable) ─────────────────────────────────────────────────────
# Installed for the invoking user; cargo lands in ~/.cargo/bin. `uv sync` (run by
# `just deploy` as this user) picks it up. The systemd unit does NOT need Rust —
# it only runs the already-built venv.
if [ "$MODE" = runtime ]; then
    :  # prebuilt wheel — no Rust needed
elif command -v cargo >/dev/null 2>&1 || [ -x "$HOME/.cargo/bin/cargo" ]; then
    log "rust: already present ($("${HOME}/.cargo/bin/cargo" --version 2>/dev/null || cargo --version))"
else
    log "rust: installing via rustup (stable, minimal profile)"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --default-toolchain stable --profile minimal
fi

# ── uv (astral), into /usr/local/bin ──────────────────────────────────────────
# System path so the systemd unit's ExecStart=/usr/local/bin/uv resolves without
# depending on the pi user's login PATH.
if [ -x /usr/local/bin/uv ]; then
    log "uv: already present ($(/usr/local/bin/uv --version))"
else
    log "uv: installing to /usr/local/bin"
    curl --proto '=https' --tlsv1.2 -LsSf https://astral.sh/uv/install.sh \
        | sudo env UV_INSTALL_DIR=/usr/local/bin sh
fi

# ── pmtiles (go-pmtiles), into /usr/local/bin ─────────────────────────────────
# Pinned, because the release asset filename embeds the version — there is no
# /releases/latest/download/ path that resolves without knowing it, and asking
# the GitHub API for it would add a rate-limited call on the Pi. To bump: set
# PMTILES_VERSION and check the asset still exists at the URL built below (note
# the tag carries a leading `v`, the filename does not).
PMTILES_VERSION=1.31.2
if [ -x /usr/local/bin/pmtiles ]; then
    log "pmtiles: already present ($(/usr/local/bin/pmtiles version 2>/dev/null || echo 'unknown version'))"
else
    case "$ARCH" in
        aarch64|arm64) pmtiles_arch=Linux_arm64 ;;
        x86_64|amd64)  pmtiles_arch=Linux_x86_64 ;;
        *) die "no go-pmtiles release build for $ARCH — install 'pmtiles' by hand, or set osm_world.pmtiles_binary to its path" ;;
    esac
    tarball="go-pmtiles_${PMTILES_VERSION}_${pmtiles_arch}.tar.gz"
    url="https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/${tarball}"
    log "pmtiles: installing ${PMTILES_VERSION} (${pmtiles_arch}) to /usr/local/bin"
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    curl --proto '=https' --tlsv1.2 -fsSL "$url" -o "$tmp/$tarball" \
        || die "could not download $url"
    tar -xzf "$tmp/$tarball" -C "$tmp" pmtiles
    sudo install -m0755 "$tmp/pmtiles" /usr/local/bin/pmtiles
    rm -rf "$tmp"
    trap - EXIT
fi

# ── Summary ───────────────────────────────────────────────────────────────────
if [ "$MODE" = runtime ]; then
    log "Done. Host is ready for a release install:"
    printf '    uv   : %s\n' "$(/usr/local/bin/uv --version 2>/dev/null || echo 'MISSING')"
    printf '    pmtiles: %s\n' "$(/usr/local/bin/pmtiles version 2>/dev/null || echo 'MISSING')  (OSM-world basemap extract)"
    exit 0
fi
log "Done. Host is ready for the native deploy:"
printf '    rust : %s\n' "$("${HOME}/.cargo/bin/cargo" --version 2>/dev/null || cargo --version 2>/dev/null || echo 'MISSING')"
printf '    uv   : %s\n' "$(/usr/local/bin/uv --version 2>/dev/null || echo 'MISSING')"
printf '    pmtiles: %s\n' "$(/usr/local/bin/pmtiles version 2>/dev/null || echo 'MISSING')  (OSM-world basemap extract)"
printf '    cc   : %s\n' "$(cc --version 2>/dev/null | head -1 || echo 'MISSING')  (pyo3 links C; serve-time geometry is pure Rust — no libgeos, no cmake)"
log "Next: 'just deploy' (rsyncs the repo, builds the wheel here with uv sync,"
log "ships frontend/dist, installs the service)."
