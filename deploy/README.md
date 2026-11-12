# Deploying mivnav to the boat's Raspberry Pi (native arm64)

There are two kinds of install. Both run the same `mivnav.service` (backend +
web UI on :8230) as the installing user, natively — no Docker, no GDAL, no
qemu — and use the same config and data paths, so you can switch between them.

| | Release install | Source install |
|---|---|---|
| Installed by | `deploy/install.sh` (curl one-liner) | `just deploy` from a dev box, or `deploy/install-from-source.sh` on the Pi |
| Code | prebuilt bundle in `/opt/mivnav/releases/<version>`, `/opt/mivnav/current` → active one | the checkout (`/home/pi/mivnav`, or wherever you cloned) |
| Built on the Pi | only the Python venv (`uv`) | the chartcore wheel (Rust) + venv; `install-from-source.sh` also the web UI (bun) |
| Pi needs | uv, pmtiles, polkitd (`install-deps.sh --runtime`) | + Rust, a C compiler (`install-deps.sh`) and bun |
| Updates | `update.sh` / Settings → Software, with automatic rollback | `git pull` + re-run, or `just deploy` again |

The steps both share (S-52 tables, oexserverd, config bootstrap, unit
rendering) live in `deploy/lib.sh`, so the two can't drift.

## Release installs

    curl -fsSL https://github.com/nukifla/mivnav/releases/latest/download/install.sh | bash
    # options after `bash -s --`: --version v0.2.0 | --prerelease | --bundle FILE [--sums SHA256SUMS]

`install.sh` runs as the service user (refuses root; uses sudo itself) and is
idempotent — re-running it is the repair path. It downloads
`mivnav-<version>-<arch>.tar.gz` + `SHA256SUMS` from the GitHub Release,
verifies the checksum, installs the runtime deps, unpacks to
`/opt/mivnav/releases/<version>`, builds that release's `backend/.venv`
(`uv venv --relocatable`, `uv sync --frozen --no-dev --no-install-project
--no-install-package chartcore`, then `uv pip install wheels/chartcore-*.whl`),
points `current` at it, fetches the S-52 tables and oexserverd, bootstraps the
config, and installs three root-owned files, rendered for the installing user:

- `/etc/systemd/system/mivnav.service` — `WorkingDirectory=/opt/mivnav/current/backend`
- `/etc/systemd/system/mivnav-update@.service` — oneshot, runs
  `/opt/mivnav/current/deploy/update.sh %i` as the service user
- `/etc/polkit-1/rules.d/50-mivnav.rules` — lets that user `start`
  `mivnav-update@*.service` and `restart` `mivnav.service`, nothing else (no sudoers)

Copies of those three are kept in `/opt/mivnav/system/`. Over a source install
it simply replaces the unit; the old checkout is left on disk, config and data
are untouched.

Layout:

    /opt/mivnav/
      current  -> releases/0.2.0      the running release (swapped atomically)
      previous -> releases/0.1.0      what `update.sh rollback` goes back to
      releases/<version>/             VERSION, backend/ (+ .venv), frontend/dist, deploy/, wheels/
      system/                         the installed units + polkit rule, as rendered

### Updating — `update.sh`

    /opt/mivnav/current/deploy/update.sh latest | vX.Y.Z | rollback | --check   [--prerelease]

Runs as the service user (the UI starts it as `mivnav-update@<arg>.service`).
It resolves the tag via the GitHub API, downloads and verifies the bundle,
unpacks to `releases/<v>.partial`, builds the venv, renames it to
`releases/<v>`, swaps `current`, restarts `mivnav.service`, and waits up to
90 s for `http://127.0.0.1:8230/api/healthz` to report the new version. If it
doesn't, it swaps back, restarts, deletes the broken release and reports
`rolled_back`. It keeps the current and previous release and prunes the rest.
`latest` never downgrades. If the new release's units or polkit rule differ
from `/opt/mivnav/system/`, it changes nothing and reports `failed`, asking
for `install.sh` to be run once (that needs root).

Progress is written atomically to `/var/lib/mivnav/update/status.json`
(`state`: checking, downloading, installing, restarting, done, failed,
rolled_back; plus `from`, `to`, `message`, `started_at`, `updated_at`), which
the backend reads; the log is `/var/lib/mivnav/update/update.log` (bounded). A
lock file there keeps two updaters from running at once.

Test the installer and updater with `just test-deploy` (shellcheck + an
end-to-end harness, `deploy/tests/test_update.sh`, that runs without root,
systemd or network), and a real bundle with `just bundle` →
`chartcore/target/bundle/` (built for the host's glibc — for testing, not for
the Pi).

### Cutting a release (maintainers)

1. Make sure `main` is green (`just check`).
2. Tag and push. Versions are `vMAJOR.MINOR.PATCH`; pre-releases carry a
   suffix (`v0.2.0-rc.1`). Use an **annotated** tag: the first line is a
   title, and the rest becomes the summary at the top of the release notes,
   so that's where "what's new" goes:

        git tag -a v0.2.0 -m "mivnav 0.2.0

        Tide heights in the info panel, faster chart loading on the Pi 4."
        git push origin v0.2.0

   (The repo is jj-colocated; plain git is fine for tags.) Preview the notes
   first with `deploy/release-notes.sh v0.2.0` after creating the tag locally.
3. `.github/workflows/release.yml` builds the web UI once, the chartcore wheel
   per arch in `debian:bookworm` (aarch64 + x86_64; abi3, so one wheel serves
   any Python ≥ 3.12), bundles them with `deploy/build-bundle.sh`, and
   publishes a GitHub Release with the two tarballs, `SHA256SUMS` and
   `install.sh`. A tag containing `-` becomes a pre-release, which `latest`
   ignores unless asked (`--prerelease`, or `updates.include_prereleases` in
   the config).
4. The notes come from `deploy/release-notes.sh`: the tag's summary, then the
   title of every commit since the previous release (a stable release
   compares against the previous *stable* one, so it covers its release
   candidates), then a link to the full diff. The app's Software section
   shows them; edit them on GitHub afterwards if you like.

If a release changes `mivnav.service`, `mivnav-update@.service` or
`50-mivnav.rules`, say so in the notes: the in-app update will refuse it and
users must re-run the install one-liner once.

## Source installs

`just deploy [target]` builds the frontend **on the dev box**, rsyncs the repo
(backend + chartcore source + the built `frontend/dist`) to the Pi, builds the
chartcore wheel **natively on the Pi** with `uv sync`, and installs one boot
service that runs the backend directly. No Docker, no GDAL, no qemu.

    just deploy                 # default target pi@boat.local
    just deploy pi@<host>       # override target

Idempotent: safe to run repeatedly. A second `just deploy` re-syncs, rebuilds
the wheel (incrementally), and restarts the service — boat data is untouched
(it all lives in native host paths, below).

There is also a second path that needs no dev box:
`deploy/install-from-source.sh`, run on the Pi from a git clone, which installs
bun, builds the frontend there, and then runs the same steps. Both paths
finish with `deploy/install-service.sh` (wheel build, S-52 tables, oexserverd,
config bootstrap, systemd unit), so the two can't drift.

**First time on a Pi, run the one-time host setup first:**

    just setup-pi-deps          # install Rust + uv + a C compiler (no Docker/GDAL/libgeos/cmake)
    just deploy                 # ship + build on the Pi + install the service

## Why native (the old container is gone, #GD3)

The deploy used to be a container for two reasons, both now void:

- **GDAL version floor.** chartcore once pinned the `gdal` crate (build.rs
  hard-panic below 3.8) and OpenPlotter's apt GDAL was 3.6 — so the deploy ran
  `FROM osgeo/gdal` to get 3.13. **GDAL is now gone from the build**: serve-time
  geometry is **pure Rust** (`geo` + `i_overlay`, #GD-PURE) and the S-57 ingest
  path is feature-gated out of the wheel (#GD2). No C geometry library is
  linked at all — no libgdal, no libgeos, and (superseding the earlier
  vendored-static-GEOS approach, #GD1) **no cmake to build one**. That is what
  makes it deploy on Bookworm, whose apt can install neither `libgeos-dev` nor,
  on the target Pi, cmake. No GDAL floor, no geometry C lib, no container.
- **oexserverd was x86_64-only.** The o-charts DRM daemon `oexserverd` is a
  closed vendor binary; chartcore only knew the x86_64 build, so the image was
  `linux/amd64` and ran under **qemu emulation** on the arm64 Pi. chartcore now
  fetches and runs the **native arm64** `oexserverd`
  (`o-charts_pi/libs/oeserverd/linuxarm64`, #GD3) — no emulation.

**And running natively keeps the Pi's real o-charts fingerprint.** Docker
changes the DRM fingerprint, which **burns an o-charts licence seat** — the
reason the container was rejected. The native deploy runs `oexserverd` on the
Pi's real machine identity, so the registered seat stays registered.

## On-device build (not cross-build)

The chartcore wheel is a pyo3/maturin native extension. Cross-compiling it for
arm64 from the dev box is fragile (native deps, linkers, the pyo3 C ABI). Since the
Pi has Rust + uv (from `just setup-pi-deps`), the wheel is simply **built on the
Pi** by `uv sync` — the "#88" on-device model. Only the frontend is built on the
dev box (it's plain JS — `bun run build` → `frontend/dist` — no arch concern),
then shipped.

**Rust: rustup, not apt.** Bookworm's apt Rust is too old for chartcore, so
`install-deps.sh` installs **rustup** (stable, minimal) — matching the dev box.
The systemd unit does **not** need Rust; it only runs the already-built venv.

## One service

**`mivnav.service`** (shipped: `deploy/mivnav.service`) runs the backend
directly as the `pi` user:

    ExecStart=/usr/local/bin/uv run --no-sync fastapi run main.py --host 0.0.0.0 --port 8230

`Restart=always`, `WantedBy=multi-user.target`, `--no-sync` so boot never
rebuilds (deploy already ran `uv sync`). The backend serves **both** the web UI
(built SPA at `/`) and the API (under `/api`) on **port 8230**. It binds `:8230`
directly (plain HTTP) and reaches OpenPlotter's SignalK at `localhost:3000` (the
config default). 8230 is unprivileged, so no `CAP_NET_BIND_SERVICE`.

### Reverse proxy (HTTPS + domain) — external, not configured here

An **external, user-managed reverse proxy** on the Pi terminates HTTPS and
serves the app at a local DNS name (e.g. **`https://nav.example.org`**), forwarding to
the backend over plain HTTP on **`:8230`**. That proxy (and its
DNS name and its TLS cert) is **not** set up by this deploy — mivnav only serves
plain HTTP on 8230. The UI and its `/api` are same-origin behind the proxy, so
no frontend change is needed.

Open that name in a browser on the boat's network (or, bypassing the
proxy, `http://<pi>:8230/` directly).

## Data locations (native host paths — survive redeploys)

Boat data lives on the host, so a redeploy can never wipe it:

| What | Path on the Pi | Deployed? |
|------|----------------|-----------|
| App code + built wheel/venv | source: `/home/pi/mivnav/` (`backend/.venv`, `chartcore/`, `frontend/dist`); release: `/opt/mivnav/` | yes — rsynced + built each deploy / unpacked each update |
| Updater status + log | `/var/lib/mivnav/update/` (release installs) | no — written by `update.sh` |
| Config + secrets | `/home/pi/.config/mivnav/{config,credentials,profiles,routes}.json` | no — bootstrapped once, then owned by the UI |
| Charts + installed o-charts cells | `/var/lib/mivnav/` (`charts/`, `ocharts/sets/`) | no — persists |
| S-52 symbology | `/var/lib/mivnav/s57data` | yes — fetched once (see below) |
| oexserverd binary + cell cache | `/var/cache/mivnav/oexserverd` | yes — fetched once (see below) |
| Decode work dir | `/run/mivnav/oex` | no — ephemeral (tmpfs) |

The unit's `ExecStartPre` creates the data dirs (owned by `pi`) on every start.
The service runs as `pi` (a native host install runs `oexserverd` as the user —
the DRM fingerprint is the machine's, not the uid's).

### Config is bootstrapped, never clobbered

`just deploy` writes `deploy/config.default.json` to the Pi's
`~/.config/mivnav/config.json` **only if no config exists there**. It points
`charts.dir` / `ocharts.sets_dir` / `ocharts.daemon_dir` / `ocharts.work_dir` /
`ocharts.s52_path` at the native host paths:

    {
      "charts":  { "dir": "/var/lib/mivnav/charts" },
      "ocharts": {
        "sets_dir":   "/var/lib/mivnav/ocharts/sets",
        "daemon_dir": "/var/cache/mivnav/oexserverd",
        "work_dir":   "/run/mivnav/oex",
        "s52_path":   "/var/lib/mivnav/s57data"
      }
    }

If a config already exists it is left exactly as is — and `credentials.json`
(0600 secrets) is never read or written by the deploy.

## S-52 symbology — fetched onto the Pi

o-charts cells render with **no symbols** (buoys, beacons, lights invisible)
without the S-52 presentation-library lookup tables. These are five XML files
from a pinned ochartsng commit. `just deploy` fetches them into
`/var/lib/mivnav/s57data` on the Pi (skipped if already present), and
`config.default.json` points `ocharts.s52_path` there. Needs network **once**;
after that it works offline forever.

(`S52_COMMIT` in `deploy/lib.sh` **must stay in sync** with
`chartcore/src/s52/mod.rs::UPSTREAM_COMMIT`; `just check-s52-sync` enforces it.)

## oexserverd — fetched once by `just deploy` (now arm64)

`oexserverd` (the vendor binary) is **not** shipped in the repo; `just deploy`
downloads it (and its dongle-support lib) into `/var/cache/mivnav/oexserverd`.
On the arm64 Pi this fetches the **native arm64** build
(`o-charts_pi/libs/oeserverd/linuxarm64`: `oexserverd` +
`libsglarm64-2.31.0.0.so`; upstream ships no `libusb` there). Files already
present are never re-fetched and deploys don't touch that directory, so this
needs network **once**; if the files are missing and can't be fetched, the
deploy fails. chartcore still fetches them on demand if the directory is
emptied later, which needs network. Plain `.senc`/unencrypted sets never touch
it.

## Pi prerequisites (one-time) — `just setup-pi-deps`

Run this **before** `just deploy`, once per Pi:

    just setup-pi-deps          # default target pi@boat.local

It ssh's `deploy/install-deps.sh` to the Pi and installs the native build
toolchain:

- **Rust** — via rustup (stable, minimal); cargo lands in `~/.cargo/bin`. apt's
  Rust is too old.
- **uv** — installed to `/usr/local/bin` (so the systemd unit resolves it by
  path). Builds the wheel and resolves the venv.
- **build-essential + pkg-config** — the C linker/toolchain the pyo3 wheel
  needs. Serve-time geometry is pure Rust (`geo` + `i_overlay`), so there is no
  geometry C library to build: no libgeos, and no cmake. Only a C compiler.

The script is idempotent (`command -v` / `dpkg -s` checks, `set -euo pipefail`),
so re-running is a clean no-op.

Still required, and **not** set up by the script:

- Passwordless (or interactive) **sudo** for `pi` — used for apt, the
  `/usr/local/bin` uv install, `/var/lib/mivnav`, and the unit file.

## What `just deploy` does, step by step

1. `just build` — `bun run build` locally → `frontend/dist` (static).
2. `rsync` `backend/` + `chartcore/` (source) and `frontend/dist` to
   `pi@host:/home/pi/mivnav/`, plus the two deploy assets (`mivnav.service`,
   `config.default.json`).
3. Over ssh on the Pi:
   - `uv sync --frozen` in `backend/` — builds the chartcore wheel natively
     (arm64, gdal-free) and resolves the venv;
   - fetch the S-52 tables into `/var/lib/mivnav/s57data` (iff absent);
   - bootstrap `~/.config/mivnav/config.json` **iff** absent (never clobbered);
   - install `deploy/mivnav.service`, `daemon-reload`, `enable`, `restart`.

No Docker. No qemu. No GDAL.
