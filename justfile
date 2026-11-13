# mivnav task runner. `just` with no arguments lists the recipes.
#
# Every recipe is a thin wrapper around the documented raw command — the
# raw commands keep working on their own, this is only convenience.

chartcore := justfile_directory() / "chartcore"
backend := justfile_directory() / "backend"
frontend := justfile_directory() / "frontend"

# Marks the last successful sync-chartcore. Lives under chartcore/target/,
# which chartcore/.gitignore already excludes (`/target`) — jj respects
# gitignore when snapshotting regardless of snapshot.auto-track (checked:
# this repo has it at the default `all()`, not `none()`), so the stamp is
# never a candidate for tracking. It's a build artifact, not source, so it
# belongs next to cargo's own build output rather than in the source tree.
chartcore_stamp := chartcore / "target/.sync-chartcore-stamp"

# The fixture cell and the archive the dev backend serves from.
cell := chartcore / "tests/fixtures/US5OAKIQ.000"
pmtiles := backend / "data/US5OAKIQ.pmtiles"

# Dev server ports. Override per-invocation, e.g. to run a scratch stack
# beside the real one: `just backend_port=8010 frontend_port=5174 dev`
backend_port := "8000"
frontend_port := "5173"

# Deploy target (ssh destination) and the directory the repo (backend +
# chartcore + the built frontend/dist) is rsynced into on the Pi, where it is
# built natively with `uv sync`. `just deploy pi@boat.local` overrides the
# target. The systemd unit hardcodes /home/pi paths, so change them together.
deploy_target := "pi@boat.local"
deploy_dir := "/home/pi/mivnav"

# S-52 presentation-library commit fetched onto the Pi (buoys/lights symbology).
# Defined in deploy/lib.sh (shared by both installers, which do the fetch); read
# here only so `check-s52-sync` can hold it to
# chartcore/src/s52/mod.rs::UPSTREAM_COMMIT.
s52_commit := `grep -oP '^S52_COMMIT=\K[0-9a-f]+' deploy/lib.sh`

_default:
    @just --list --unsorted

# --- dev ---------------------------------------------------------------

# Each service gets its own process group (set -m), so teardown reaches uv's
# and bun's children rather than orphaning uvicorn/vite behind a dead parent.
# Ctrl-C or either service exiting tears down both.
#
# The cost of the separate process groups: the services are not in the
# terminal's foreground group, so their stdin is /dev/null (reading the tty
# would SIGTTIN them to a halt) and vite's keyboard shortcuts are gone. Use
# `just dev-frontend` if you want them.

# Run the backend and the vite dev server together.
dev: sync-chartcore-if-stale plugins-link (kill-port backend_port) (kill-port frontend_port)
    #!/usr/bin/env bash
    set -uo pipefail
    set -m
    pids=()
    cleanup() {
        trap - EXIT INT TERM
        for pid in "${pids[@]}"; do kill -- -"$pid" 2>/dev/null || true; done
        wait 2>/dev/null || true
    }
    trap cleanup EXIT INT TERM
    ( cd {{ backend }} && exec uv run fastapi dev --host 0.0.0.0 --port {{ backend_port }} ) </dev/null &
    pids+=($!)
    ( cd {{ frontend }} && MIVNAV_API=http://localhost:{{ backend_port }} \
        exec bun run dev --port {{ frontend_port }} ) </dev/null &
    pids+=($!)
    wait -n

# Backend only (:8000). Binds all interfaces so other devices on the LAN can reach it.
dev-backend: sync-chartcore-if-stale (kill-port backend_port)
    cd {{ backend }} && uv run fastapi dev --host 0.0.0.0 --port {{ backend_port }}

# Vite only (:5173). Binds all interfaces (vite.config.ts `host: true`).
dev-frontend: plugins-link (kill-port frontend_port)
    cd {{ frontend }} && bun run dev --port {{ frontend_port }}

# Kill whatever is already bound to `port` — a previous `just dev`/
# `dev-backend`/`dev-frontend` still running (or a stray process that
# crash-orphaned) would otherwise make the new one fail to bind with
# "address already in use" instead of just replacing it. `fuser`'s own
# "nothing there" exit code is not a real error — `|| true` past it. The
# brief sleep gives the kernel a moment to actually free the socket
# before the new process tries to bind it; a plain SIGKILL is fine here
# (these are throwaway dev processes, nothing to flush on the way out).
kill-port port:
    @fuser -k {{ port }}/tcp >/dev/null 2>&1 || true
    @sleep 0.3

# --- verify ------------------------------------------------------------
# Exit code is the source of truth, not LSP diagnostics.

# All verify gates.
check: fmt-check check-s52-sync test-deploy test-chartcore check-backend-layering test-backend check-frontend check-frontend-layering test-frontend test-plugins

# backend: the module-dependency chain (kernel < features < composition root)
# is held by import-linter contracts in backend/.importlinter. A stray import up
# the chain (kernel importing a feature, a feature importing the api root) fails.
check-backend-layering:
    cd {{ backend }} && uv run lint-imports

# frontend: core/** must never import features/**. dependency-cruiser enforces it
# (config in frontend/.dependency-cruiser.cjs); `bun run check` runs it too.
check-frontend-layering:
    cd {{ frontend }} && bun run lint:boundaries

# Guard against S-52 presentation-library commit drift. `deploy` fetches
# `s52_commit` (deploy/lib.sh) onto the Pi, but chartcore compiled its symbol NAMES
# against `UPSTREAM_COMMIT` (chartcore/src/s52/mod.rs) — if the two diverge the
# Pi gets a symbology set whose names don't match the binary, a runtime mismatch
# no other gate catches (only a "KEEP IN SYNC" comment held them together).
check-s52-sync:
    #!/usr/bin/env bash
    set -euo pipefail
    rust="$(grep -oP 'UPSTREAM_COMMIT: &str = "\K[0-9a-f]+' {{ chartcore }}/src/s52/mod.rs)"
    if [[ "$rust" != "{{ s52_commit }}" ]]; then
        echo "S-52 commit drift: justfile s52_commit={{ s52_commit }} but chartcore UPSTREAM_COMMIT=$rust" >&2
        exit 1
    fi
    echo "S-52 commit in sync ($rust)"

# chartcore: rustfmt is clean (`just fmt` fixes). Stock rustfmt defaults — no
# rustfmt.toml. `check` depends on this rather than `fmt` so a verify run
# reports drift instead of rewriting the tree underneath you.
fmt-check:
    cd {{ chartcore }} && cargo fmt --check

# chartcore: reformat in place.
fmt:
    cd {{ chartcore }} && cargo fmt

# chartcore: cargo test. Two passes: the default (gdal-free) build is what the
# Pi wheel is compiled as — it must stay green with the S-57 ingest path gated
# out (`s57-ingest` off) — and then `--features s57-ingest` so the dev box keeps
# running the GDAL-backed s57/golden/derive tests that the default pass skips.
test-chartcore:
    cd {{ chartcore }} && cargo test
    cd {{ chartcore }} && cargo test --features s57-ingest

# backend: uv run pytest (reinstalls chartcore first — see sync-chartcore).
# Excludes the `crosscheck` marker (the weather plugin's live Open-Meteo
# cross-check) — see check-crosscheck below and backend/pyproject.toml's addopts.
test-backend: sync-chartcore-if-stale
    cd {{ backend }} && uv run pytest

# weather plugin: the live Open-Meteo cross-check
# (plugins/weather/backend/tests/test_weather_grid_crosscheck.py) —
# NOT part of `just check`/`test-backend` (see there). Live network + a Node
# subprocess, ~3 min: proves the .om decode port agrees with the ORIGINAL
# @openmeteo/weather-map-layer JS, not just with itself. Needs a sibling
# frontend checkout with node_modules installed (bun install) and `node` on
# PATH; self-skips per-test if either is missing rather than failing.
check-crosscheck: sync-chartcore-if-stale
    cd {{ backend }} && uv run pytest -c pyproject.toml -m crosscheck ../plugins/weather/backend/tests/test_weather_grid_crosscheck.py

# frontend: typecheck (tsc --noEmit) — any plugin under plugins/ included
check-frontend: plugins-link
    cd {{ frontend }} && bun run check

# frontend: unit tests
#
# `bun run test`, NOT bare `bun test`: the script passes --conditions=browser.
# Without it bun resolves solid-js's `node` export — the SSR build, where
# createEffect never runs — so reactive tests either pass vacuously or, once
# they assert an effect actually fired, fail against a gate that is testing the
# wrong build entirely.
test-frontend:
    cd {{ frontend }} && bun run test

# --- plugins -------------------------------------------------------------
# Out-of-tree plugins live in plugins/<name>/ (gitignored; each is its own
# repo): `backend/` is loaded by mivnav.plugins, `frontend/index.ts` by
# frontend/src/plugins.ts. See those two modules for what a plugin can add.

# plugins/node_modules points at the frontend's, so plugin code resolves
# solid-js/maplibre to the app's own copies (one instance, not two).

# Link plugins/node_modules to the frontend's.
plugins-link:
    #!/usr/bin/env bash
    set -euo pipefail
    [ -d plugins ] || exit 0
    [ -L plugins/node_modules ] || ln -s ../frontend/node_modules plugins/node_modules

# Backend: pytest against the host's fixtures, with plugins loaded (the core
# suite runs without them). Frontend: bun test. A no-op with no plugins.

# Run every plugin's own tests.
test-plugins: sync-chartcore-if-stale plugins-link
    #!/usr/bin/env bash
    set -euo pipefail
    shopt -s nullglob
    for dir in plugins/*/; do
        name="$(basename "$dir")"
        [ "$name" = node_modules ] && continue
        if [ -d "$dir/backend/tests" ]; then
            echo "==> $name: backend"
            ( cd {{ backend }} && uv run pytest -c pyproject.toml "../$dir/backend/tests" )
        fi
        if compgen -G "$dir/frontend/*.test.ts" >/dev/null; then
            echo "==> $name: frontend"
            ( cd {{ frontend }} && bun test --conditions=browser "../$dir/frontend" )
        fi
    done

# --- chartcore ---------------------------------------------------------

# uv does NOT notice chartcore's Rust sources changing through the pyo3/maturin
# path source, so without this the backend serves a stale module (AttributeError
# on new functions). `dev`/`dev-backend`/`test-backend` depend on
# sync-chartcore-if-stale (below) rather than this directly, so the ~7.5s
# `uv sync --reinstall-package` cost is only paid when something actually
# changed.

# Rebuild the chartcore wheel the backend imports. Unconditional — this is
# the escape hatch for when you don't trust (or want to bypass) the mtime
# check below, e.g. after switching jj/git state in a way that leaves file
# mtimes not reflecting content. Always runs the full sync; on success it
# also refreshes the staleness stamp so an immediate sync-chartcore-if-stale
# doesn't redundantly re-run it.
sync-chartcore:
    cd {{ backend }} && uv sync --reinstall-package chartcore
    @mkdir -p {{ chartcore }}/target && touch {{ chartcore_stamp }}

# Same effect as sync-chartcore, but skipped if nothing the built wheel
# depends on has changed since the last successful sync. Compares mtimes of
# the wheel's actual inputs — Rust sources, Cargo.toml (deps/features),
# Cargo.lock (a dependency bump touches this without touching src/), and
# pyproject.toml (maturin's build config, e.g. the `features` it builds
# with) — against the stamp sync-chartcore leaves on success. Deliberately
# NOT scoped to just chartcore/src/**/*.rs: missing an input here silently
# reopens the stale-module footgun, so anything the build actually reads is
# included even at the cost of an occasional unneeded sync. Excluded as
# non-inputs: LICENSE, tests/, target/ (build output, not a build input).
# No stamp yet, or any input newer than it, means fall through to a real
# sync; otherwise skip.
sync-chartcore-if-stale:
    #!/usr/bin/env bash
    set -euo pipefail
    stamp="{{ chartcore_stamp }}"
    if [[ -f "$stamp" ]] && [[ -z "$(find {{ chartcore }}/src {{ chartcore }}/Cargo.toml {{ chartcore }}/Cargo.lock {{ chartcore }}/pyproject.toml \
            \( -name '*.rs' -o -name '*.csv' -o -name Cargo.toml -o -name Cargo.lock -o -name pyproject.toml \) \
            -newer "$stamp" -print -quit)" ]]; then
        echo "chartcore: unchanged since last sync, skipping (just sync-chartcore to force)"
    else
        just sync-chartcore
    fi

# Re-ingest the fixture cell to the archive the dev backend serves.
# Needs `--features s57-ingest`: the `.000` reader and this CLI bin are gated
# behind it (GDAL-backed, dev-box-only — the Pi wheel links no libgdal). The
# bin also carries `required-features = ["s57-ingest"]`, so without the flag
# `cargo run --bin chartcore` errors out rather than silently doing nothing.
ingest:
    cd {{ chartcore }} && cargo run --release --quiet --features s57-ingest --bin chartcore -- \
        ingest {{ cell }} -o {{ pmtiles }}

# --- frontend ----------------------------------------------------------

# Production build (bundles any plugin under plugins/).
build: plugins-link
    cd {{ frontend }} && bun run build

# Dump the backend's OpenAPI schema (no running server — imports
# mivnav.api.app and calls .openapi() directly, see
# backend/tools/dump_openapi_schema.py) to the gitignored JSON file `bun run
# api` reads. Regenerate the committed frontend/src/api.generated.ts with:
#   just openapi-schema && cd frontend && bun run api
# `bun test` regenerates the schema itself to check for drift, so this
# recipe is only needed to actually refresh api.generated.ts, not to verify it.
openapi-schema:
    cd {{ backend }} && uv run python tools/dump_openapi_schema.py {{ frontend }}/tools/openapi/schema.json

# --- deploy (native arm64) ---------------------------------------------

# Deploy mivnav to the boat's Pi NATIVELY — no Docker, no GDAL, no qemu.
# See deploy/README.md for the rationale (#GD3) and the one-time
# `just setup-pi-deps` (Rust + uv + a C compiler) prerequisite.
#
# Build strategy: the frontend is built on the DEV BOX (`bun run build` -> static
# dist, no cross-arch issue — it's JS). The backend + chartcore SOURCE is rsynced
# to the Pi and the chartcore wheel is built ON THE PI with `uv sync` (native
# arm64, gdal-free — serve-time geometry is pure Rust, no C geometry lib).
# On-device build, not cross-build:
# an arm64 cross-build of the pyo3 wheel is fragile; the Pi has Rust + uv, so it
# just builds there (~the #88 model).
#
# ONE service: the backend serves both the SPA (at /) and the API (under /api) on
# :8230 directly (reaches SignalK at localhost:3000). An external reverse proxy
# terminates HTTPS (e.g. https://nav.example.org) in front of it. See
# deploy/mivnav.service. Native oexserverd (arm64) keeps the Pi's real o-charts
# fingerprint — no Docker seat burn.
#
# Data lives in native host paths (/var/lib, /var/cache, /run, ~/.config/mivnav)
# so a redeploy never wipes boat data. A default config is written only if the Pi
# has none — a live config (and its sibling credentials.json) is NEVER touched.
# Idempotent; safe to re-run.

# Ship the repo, build the wheel on the Pi, install the native service.
deploy target=deploy_target: build
    #!/usr/bin/env bash
    set -euo pipefail
    target="{{ target }}"
    dir="{{ deploy_dir }}"

    echo "==> Rsyncing sources to ${target}:${dir}"
    ssh "${target}" "mkdir -p '${dir}/deploy' '${dir}/frontend'"
    # Source needed to build the wheel + run the backend. Excludes protect the
    # Pi's own build output (chartcore/target, backend/.venv) from --delete.
    # `backend/data/` is excluded too: the Pi's real data_root is the native
    # host path in config.json (/var/lib/mivnav/charts, see mivnav.service),
    # never this repo-relative dir — syncing it just pushed the dev box's own
    # local fixtures/bakes onto the Pi's disk for no reason (confirmed: ~145
    # MB of stray dev data on the boat, unused by the running service).
    # MUST be anchored, and anchored to the FULL path: an unanchored `data/`
    # matches a directory named `data` at ANY depth, which silently ate the
    # whole `mivnav/data/` package (dataset provider/scheduler code, not a
    # data dir at all) on every deploy — confirmed via rsync dry-run diff
    # after the Pi ran for a day importing a stale mivnav/data/provider.py.
    # But a leading `/` anchors at the root of the TRANSFER, and with two
    # source args (`chartcore backend`) that root is the destination dir, not
    # `backend/` — so the `/data/` this used to say matched `<dest>/data/`,
    # which exists nowhere, and excluded nothing at all. Measured with
    # `rsync --dry-run`: under `/data/` the bakes were still transferred;
    # `/backend/data/` excludes them and still leaves `mivnav/data/` alone.
    rsync -azP --delete \
        --exclude 'target/' --exclude '.venv/' --exclude '__pycache__/' --exclude '/backend/data/' \
        chartcore backend "${target}:${dir}/"
    # Plugins' backend halves (their frontend halves are in the built SPA).
    # Always synced, so a plugin removed here is removed on the Pi too.
    mkdir -p plugins
    rsync -azP --delete --exclude 'node_modules' --exclude '__pycache__/' --exclude 'frontend/' \
        --exclude '.git/' --exclude 'tests/' plugins "${target}:${dir}/"
    # Only the built SPA, not the whole frontend tree. app.py resolves it at
    # <repo-root>/frontend/dist (parents[3]); here that is ${dir}/frontend/dist.
    rsync -azP --delete frontend/dist "${target}:${dir}/frontend/"
    rsync -azP deploy/mivnav.service deploy/config.default.json deploy/install-service.sh deploy/lib.sh "${target}:${dir}/deploy/"

    echo "==> Building the wheel + venv on ${target} (uv sync) and installing the service"
    # The on-Pi steps live in deploy/install-service.sh, shared with the
    # build-on-the-Pi installer (deploy/install-from-source.sh), so the two
    # can't drift; the steps release installs share too are in deploy/lib.sh.
    ssh "${target}" "bash '${dir}/deploy/install-service.sh'"

# One-time (needs sudo + network on the Pi): install the NATIVE build toolchain —
# Rust (rustup), uv, and a C compiler (+ build-essential/pkg-config). No Docker,
# no qemu, no GDAL. OpenPlotter's SignalK/node/Python are left alone. Idempotent:
# a second run is a no-op. Run this BEFORE `just deploy`. Piped over ssh.

# One-time: install the native build toolchain (Rust + uv + a C compiler) on the Pi.
setup-pi-deps target=deploy_target:
    #!/usr/bin/env bash
    set -euo pipefail
    target="{{ target }}"
    echo "==> Installing the native build toolchain on ${target} (needs sudo + network)"
    ssh "${target}" 'bash -s' < deploy/install-deps.sh

# --- release -----------------------------------------------------------
# Releases are built by .github/workflows/release.yml on a pushed `v*` tag
# (see deploy/README.md, "Cutting a release"). This builds the same bundle
# locally, for the host arch, to test the installer/updater with:
#     deploy/install.sh --bundle chartcore/target/bundle/mivnav-<version>-<arch>.tar.gz
# (Output goes under chartcore/target/, which is already gitignored.)
# The wheel is built for THIS machine's glibc; CI builds it on Debian Bookworm
# so it loads on the Pi — don't ship a bundle from here.

# Build a local release bundle (host arch) into chartcore/target/bundle/.
bundle version="0.0.0-local":
    #!/usr/bin/env bash
    set -euo pipefail
    wheels="{{ chartcore }}/target/bundle-wheel"
    rm -rf "$wheels"
    (cd {{ chartcore }} && uv build --wheel -o "$wheels")
    (cd {{ frontend }} && bun install --frozen-lockfile && bun run build)
    arch="$(uname -m)"; [ "$arch" = arm64 ] && arch=aarch64
    out="$(deploy/build-bundle.sh "{{ version }}" "$arch" "$wheels"/chartcore-*.whl {{ frontend }}/dist {{ chartcore }}/target/bundle)"
    (cd "$(dirname "$out")" && sha256sum "$(basename "$out")" > SHA256SUMS)
    echo "==> $out (+ SHA256SUMS)"

# Shellcheck every deploy script and run the installer/updater test harness.
test-deploy:
    uvx --from shellcheck-py shellcheck -x deploy/*.sh deploy/tests/*.sh
    bash deploy/tests/test_update.sh
