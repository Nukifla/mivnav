#!/usr/bin/env bash
#
# install.sh — install (or repair) a prebuilt mivnav RELEASE on the Pi.
#
#     curl -fsSL https://github.com/nukifla/mivnav/releases/latest/download/install.sh | bash
#
# Run it as the user the service should run as (e.g. `pi`), not root; it uses
# sudo for the few system steps. Options (with `| bash -s -- <options>`):
#
#     --version v0.2.0     install that release instead of the latest
#     --prerelease         "latest" includes pre-releases
#     --bundle FILE        install a local mivnav-<v>-<arch>.tar.gz (testing);
#                          its checksum is checked against --sums FILE if given
#     --sums FILE          a SHA256SUMS file for --bundle
#
# What it does (each step idempotent — re-running it is also the repair path):
#   1. downloads the release bundle for this arch + SHA256SUMS, verifies it
#   2. installs the runtime deps: uv, pmtiles, polkitd (no Rust, no compiler,
#      no bun — the bundle carries the prebuilt chart engine and web UI)
#   3. unpacks it to /opt/mivnav/releases/<version>, builds its venv, and
#      points /opt/mivnav/current at it
#   4. fetches the S-52 tables and the o-charts decoder (first time only)
#   5. writes a default ~/.config/mivnav/config.json if there is none
#   6. installs mivnav.service, mivnav-update@.service (the updater) and a
#      polkit rule that lets this user run the updater, then (re)starts mivnav
#
# Later updates don't need this script: Settings → Software in the UI, or
# /opt/mivnav/current/deploy/update.sh. Re-run this only when update.sh says so
# (a release changed the system files) or to repair an install.
#
# Replaces a source install's unit (deploy/install-from-source.sh, `just
# deploy`); the old checkout is left on disk. Config, credentials, charts and
# all other data stay where they are and are never touched.
#
# Test hooks (deploy/tests/): MIVNAV_ROOT, MIVNAV_STATE_DIR, MIVNAV_GITHUB_*,
# MIVNAV_HEALTH_URL as in deploy/lib.sh, plus MIVNAV_SYSTEMD_DIR,
# MIVNAV_POLKIT_DIR, MIVNAV_SKIP_DEPS=1, MIVNAV_SKIP_ASSETS=1,
# MIVNAV_ALLOW_ROOT=1.
#
# Everything up to the unpack is self-contained, because when piped from curl
# there is no deploy/ directory yet; from then on it uses the bundle's own
# deploy/lib.sh, so this script stays small and the logic lives in one place.

set -euo pipefail

# The whole script is one function, run on the last line: bash then parses
# all of it before running any, so a pipe cut short can't run half a script.
main() {
    local root="${MIVNAV_ROOT:-/opt/mivnav}"
    local state_dir="${MIVNAV_STATE_DIR:-/var/lib/mivnav/update}"
    local repo="${MIVNAV_GITHUB_REPO:-Nukifla/mivnav}"
    local api="${MIVNAV_GITHUB_API:-https://api.github.com}"
    local dl="${MIVNAV_GITHUB_DOWNLOAD:-https://github.com}"
    local systemd_dir="${MIVNAV_SYSTEMD_DIR:-/etc/systemd/system}"
    local polkit_dir="${MIVNAV_POLKIT_DIR:-/etc/polkit-1/rules.d}"
    local want=latest pre=0 bundle="" sums=""

    while [ $# -gt 0 ]; do
        case "$1" in
            --version)    want="${2:?--version needs a tag like v0.2.0}"; shift 2 ;;
            --prerelease) pre=1; shift ;;
            --bundle)     bundle="${2:?--bundle needs a file}"; shift 2 ;;
            --sums)       sums="${2:?--sums needs a file}"; shift 2 ;;
            -h|--help)    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null | sed -n 's/^# \{0,1\}//p'; return 0 ;;
            *) die "unknown option: $1 (see --help)" ;;
        esac
    done

    if [ "$(id -u)" -eq 0 ] && [ "${MIVNAV_ALLOW_ROOT:-0}" != 1 ]; then
        die "run as the user the service should run as (e.g. pi), not root — it uses sudo itself"
    fi
    [ "$(uname -s)" = Linux ] || die "mivnav installs on Linux (Raspberry Pi OS / Debian Bookworm), not $(uname -s)"
    for c in curl tar sha256sum sudo; do
        command -v "$c" >/dev/null 2>&1 || die "'$c' is required"
    done

    local arch
    case "$(uname -m)" in
        aarch64|arm64) arch=aarch64 ;;
        x86_64|amd64)  arch=x86_64 ;;
        *) die "no prebuilt mivnav for $(uname -m); use deploy/install-from-source.sh" ;;
    esac

    local user group
    user="$(id -un)"; group="$(id -gn)"

    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT

    # ── 1. fetch + verify ────────────────────────────────────────────────
    if [ -n "$bundle" ]; then
        [ -f "$bundle" ] || die "no such bundle: $bundle"
        if [ -n "$sums" ]; then
            verify_sha256 "$bundle" "$sums" || die "checksum check failed for $bundle"
            log "Checksum OK: $(basename "$bundle")"
        else
            warn "--bundle without --sums: not checking its checksum"
        fi
    else
        local tag
        tag="$(resolve_tag "$api" "$repo" "$want" "$pre")" || die "could not find the release to install"
        local ver="${tag#v}" name
        name="mivnav-${ver}-${arch}.tar.gz"
        log "Downloading mivnav $tag ($arch)"
        curl -fsSL "$dl/$repo/releases/download/$tag/SHA256SUMS" -o "$tmp/SHA256SUMS" \
            || die "could not download SHA256SUMS for $tag"
        curl -fSL --progress-bar "$dl/$repo/releases/download/$tag/$name" -o "$tmp/$name" \
            || die "could not download $name (is there a build for $arch?)"
        verify_sha256 "$tmp/$name" "$tmp/SHA256SUMS" || die "checksum check failed — not installing"
        log "Checksum OK: $name"
        bundle="$tmp/$name"
    fi

    # ── 2. unpack (to tmp first: the bundle's lib.sh + deps script drive the rest)
    mkdir -p "$tmp/x"
    tar -xzf "$bundle" -C "$tmp/x" --strip-components=1 --no-same-owner || die "could not unpack $bundle"
    [ -f "$tmp/x/deploy/lib.sh" ] || die "$bundle is not a mivnav release bundle"
    # shellcheck source=deploy/lib.sh
    . "$tmp/x/deploy/lib.sh"
    local version
    version="$(tr -d '[:space:]' < "$tmp/x/VERSION")"
    [[ "v$version" =~ $MIVNAV_TAG_RE ]] || die "bad VERSION in bundle: '$version'"
    log "Installing mivnav $version into $root"

    if [ "${MIVNAV_SKIP_DEPS:-0}" != 1 ]; then
        bash "$tmp/x/deploy/install-deps.sh" --runtime
    fi

    # ── 3. lay out /opt/mivnav ───────────────────────────────────────────
    sudo install -d -o "$user" -g "$group" -m0755 "$root" "$root/releases" "$root/system"
    sudo install -d -o "$user" -g "$group" -m0755 "$state_dir"
    local partial="$root/releases/$version.partial"
    rm -rf "$partial"
    mv "$tmp/x" "$partial"
    log "Building the Python environment (uv)"
    mivnav_build_venv "$partial" || die "building the venv failed"
    if [ -e "$root/releases/$version" ]; then
        # Repair / re-install of the same version: replace it in place. current
        # names it by path, so it stays valid across the swap.
        mv -T "$root/releases/$version" "$root/releases/$version.old"
        mv -T "$partial" "$root/releases/$version"
        rm -rf "$root/releases/$version.old"
    else
        mv -T "$partial" "$root/releases/$version"
    fi
    mivnav_activate "$root" "$version"
    mivnav_prune "$root"

    # ── 4. runtime assets ────────────────────────────────────────────────
    if [ "${MIVNAV_SKIP_ASSETS:-0}" != 1 ]; then
        sudo install -d -o "$user" -g "$group" -m0755 /var/lib/mivnav/s57data
        sudo install -d -o "$user" -g "$group" -m0755 /var/cache/mivnav/oexserverd
    fi
    mivnav_fetch_assets "$root/current/backend" || die "fetching the S-52 tables / o-charts decoder failed"

    # ── 5. config ────────────────────────────────────────────────────────
    mivnav_bootstrap_config "$root/current/deploy"

    # ── 6. system files ──────────────────────────────────────────────────
    # Rendered into <root>/system/ — the copy update.sh compares a new
    # release's against, to know when it needs this script run again.
    mivnav_render_system_files "$root/current/deploy" "$root" "$root/system"
    sudo install -d -m0755 "$systemd_dir"
    sudo install -m0644 "$root/system/mivnav.service" "$systemd_dir/mivnav.service"
    sudo install -m0644 "$root/system/mivnav-update@.service" "$systemd_dir/mivnav-update@.service"
    sudo install -d -m0755 "$polkit_dir"
    sudo install -m0644 "$root/system/50-mivnav.rules" "$polkit_dir/50-mivnav.rules"
    sudo systemctl daemon-reload
    sudo systemctl enable mivnav.service
    log "Starting mivnav"
    sudo systemctl restart mivnav.service

    if mivnav_wait_healthy "$version" "$MIVNAV_HEALTH_TIMEOUT"; then
        local ip
        ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
        log "mivnav $version is running. Open http://${ip:-<this-pi>}:8230/ from any device on the boat network."
    else
        die "mivnav $version was installed but did not come up within ${MIVNAV_HEALTH_TIMEOUT}s — see: journalctl -u mivnav -e"
    fi
}

log()  { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# The pre-unpack copies of lib.sh's mivnav_resolve_tag / mivnav_verify_sha256:
# piped from curl there is no lib.sh to source yet. Keep them in step.
resolve_tag() {
    local api="$1" repo="$2" want="$3" pre="$4" url json tag
    local re='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
    if [ "$want" != latest ]; then
        [[ "$want" =~ $re ]] || { echo "not a release tag: $want (expected e.g. v0.2.0)" >&2; return 1; }
        printf '%s\n' "$want"; return 0
    fi
    if [ "$pre" = 1 ]; then url="$api/repos/$repo/releases?per_page=10"; else url="$api/repos/$repo/releases/latest"; fi
    json="$(curl -fsSL --max-time 30 -H 'Accept: application/vnd.github+json' "$url")" \
        || { echo "could not reach $url" >&2; return 1; }
    tag="$(printf '%s' "$json" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 \
        | sed 's/.*"\([^"]*\)"$/\1/')"
    [[ "$tag" =~ $re ]] || { echo "no release found at $url" >&2; return 1; }
    printf '%s\n' "$tag"
}

verify_sha256() {
    local file="$1" sums="$2" name want got
    name="$(basename "$file")"
    want="$(awk -v n="$name" '{ f=$2; sub(/^\*/, "", f) } f==n { print $1; exit }' "$sums")"
    [ -n "$want" ] || { echo "$name is not listed in $sums" >&2; return 1; }
    got="$(sha256sum "$file" | awk '{print $1}')"
    [ "$want" = "$got" ] || { echo "checksum mismatch for $name (expected $want, got $got)" >&2; return 1; }
}

main "$@"
