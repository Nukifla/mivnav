# shellcheck shell=bash
#
# lib.sh — shell functions shared by the installers and the updater.
#
# Sourced, never executed:
#   - install-service.sh  (source installs: `just deploy`, install-from-source.sh)
#   - install.sh          (release installs, after it has unpacked a bundle)
#   - update.sh           (release updates, run as the service user)
#
# Everything here runs as the service user. The few root steps (writing under
# /etc, /var) are in the callers, which use sudo; update.sh never needs root.
#
# Paths are overridable by environment so deploy/tests/ can run all of this
# in a temp dir, without root, systemd or network:
#   MIVNAV_ROOT          release install root            (/opt/mivnav)
#   MIVNAV_STATE_DIR     updater status + log            (/var/lib/mivnav/update)
#   MIVNAV_GITHUB_REPO   owner/name of the release repo  (Nukifla/mivnav)
#   MIVNAV_GITHUB_API    GitHub API base                 (https://api.github.com)
#   MIVNAV_GITHUB_DOWNLOAD  github.com base for assets   (https://github.com)
#   MIVNAV_HEALTH_URL    the backend's health endpoint   (http://127.0.0.1:8230/api/healthz)
#   MIVNAV_HEALTH_TIMEOUT  seconds to wait for it         (90)
#   MIVNAV_SKIP_ASSETS=1 skip the S-52 / oexserverd fetch (tests only)

# S-52 presentation-library commit fetched below (buoys/lights symbology).
# Single source of truth: the justfile reads it from here, and
# `just check-s52-sync` fails if it drifts from chartcore's UPSTREAM_COMMIT
# (chartcore compiled its symbol NAMES against that commit).
S52_COMMIT=ed3972268a728d2b1a1d3eccd7861ce38efbee02

MIVNAV_ROOT="${MIVNAV_ROOT:-/opt/mivnav}"
MIVNAV_STATE_DIR="${MIVNAV_STATE_DIR:-/var/lib/mivnav/update}"
MIVNAV_GITHUB_REPO="${MIVNAV_GITHUB_REPO:-Nukifla/mivnav}"
MIVNAV_GITHUB_API="${MIVNAV_GITHUB_API:-https://api.github.com}"
MIVNAV_GITHUB_DOWNLOAD="${MIVNAV_GITHUB_DOWNLOAD:-https://github.com}"
# /api/healthz, not /healthz: the served app mounts the API under /api, and
# the SPA's index.html fallback answers 200 for any other path — a bare
# /healthz would "pass" with HTML even while the API is broken.
MIVNAV_HEALTH_URL="${MIVNAV_HEALTH_URL:-http://127.0.0.1:8230/api/healthz}"
MIVNAV_HEALTH_TIMEOUT="${MIVNAV_HEALTH_TIMEOUT:-90}"

# uv lives in /usr/local/bin on the Pi (install-deps.sh) so the unit can call
# it by absolute path; fall back to PATH (dev box, tests).
mivnav_uv() {
    if [ -x /usr/local/bin/uv ]; then /usr/local/bin/uv "$@"; else uv "$@"; fi
}

# A release tag is vMAJOR.MINOR.PATCH with an optional -prerelease suffix.
# Strict: update.sh's argument arrives as a systemd unit instance name.
MIVNAV_TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'

mivnav_arch() {
    case "$(uname -m)" in
        aarch64|arm64) echo aarch64 ;;
        x86_64|amd64)  echo x86_64 ;;
        *) return 1 ;;
    esac
}

# --- GitHub releases -------------------------------------------------------

# mivnav_resolve_tag <latest|vX.Y.Z> <include_prereleases 0|1>  → prints the tag.
# `latest` = newest non-prerelease (/releases/latest), or with prereleases the
# newest of /releases (the API lists newest first). No jq on the Pi: the first
# "tag_name" in the response is the one we want either way.
mivnav_resolve_tag() {
    local want="$1" pre="${2:-0}" url json tag
    if [ "$want" != latest ]; then
        [[ "$want" =~ $MIVNAV_TAG_RE ]] || { echo "not a release tag: $want" >&2; return 1; }
        printf '%s\n' "$want"
        return 0
    fi
    if [ "$pre" = 1 ]; then
        url="$MIVNAV_GITHUB_API/repos/$MIVNAV_GITHUB_REPO/releases?per_page=10"
    else
        url="$MIVNAV_GITHUB_API/repos/$MIVNAV_GITHUB_REPO/releases/latest"
    fi
    json="$(curl -fsSL --max-time 30 -H 'Accept: application/vnd.github+json' "$url")" || {
        echo "could not reach $url (offline?)" >&2
        return 1
    }
    tag="$(printf '%s' "$json" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 \
        | sed 's/.*"\([^"]*\)"$/\1/')"
    [[ "$tag" =~ $MIVNAV_TAG_RE ]] || { echo "no release found at $url" >&2; return 1; }
    printf '%s\n' "$tag"
}

# mivnav_download_bundle <tag> <arch> <dir>  → downloads the tarball and
# SHA256SUMS into <dir>, verifies the checksum, prints the tarball path.
mivnav_download_bundle() {
    local tag="$1" arch="$2" dir="$3" ver name base
    ver="${tag#v}"
    name="mivnav-${ver}-${arch}.tar.gz"
    base="$MIVNAV_GITHUB_DOWNLOAD/$MIVNAV_GITHUB_REPO/releases/download/$tag"
    curl -fsSL --max-time 600 "$base/SHA256SUMS" -o "$dir/SHA256SUMS" \
        || { echo "could not download $base/SHA256SUMS" >&2; return 1; }
    curl -fsSL --max-time 1800 "$base/$name" -o "$dir/$name" \
        || { echo "could not download $base/$name" >&2; return 1; }
    mivnav_verify_sha256 "$dir/$name" "$dir/SHA256SUMS" || return 1
    printf '%s\n' "$dir/$name"
}

# mivnav_verify_sha256 <file> <SHA256SUMS>  — the file's line must exist and match.
mivnav_verify_sha256() {
    local file="$1" sums="$2" name want got
    name="$(basename "$file")"
    want="$(awk -v n="$name" '{ f=$2; sub(/^\*/, "", f) } f==n { print $1; exit }' "$sums")"
    [ -n "$want" ] || { echo "$name is not listed in SHA256SUMS" >&2; return 1; }
    got="$(sha256sum "$file" | awk '{print $1}')"
    [ "$want" = "$got" ] || { echo "checksum mismatch for $name (expected $want, got $got)" >&2; return 1; }
}

# mivnav_version_gt <a> <b>  — true if version a is newer than b (semver
# order: 1.2.0 > 1.2.0-rc.2 > 1.2.0-rc.1 > 1.1.9).
mivnav_version_gt() {
    local a="$1" b="$2" ca cb
    [ "$a" != "$b" ] || return 1
    ca="${a%%-*}"; cb="${b%%-*}"
    if [ "$ca" != "$cb" ]; then
        [ "$(printf '%s\n%s\n' "$ca" "$cb" | sort -V | tail -n1)" = "$ca" ]
        return
    fi
    # Same core: a release beats any pre-release of it.
    [ "$a" = "$ca" ] && return 0
    [ "$b" = "$cb" ] && return 1
    [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -n1)" = "$a" ]
}

# --- release dirs ----------------------------------------------------------

# mivnav_unpack_bundle <tarball> <dest>  — unpack the bundle's mivnav-<v>/ into
# <dest> (which must not exist). Prints the bundle's VERSION.
mivnav_unpack_bundle() {
    local tarball="$1" dest="$2"
    mkdir -p "$dest"
    tar -xzf "$tarball" -C "$dest" --strip-components=1 --no-same-owner || return 1
    [ -s "$dest/VERSION" ] || { echo "bundle has no VERSION file" >&2; return 1; }
    [ -d "$dest/backend" ] && [ -d "$dest/frontend/dist" ] && [ -d "$dest/wheels" ] \
        || { echo "bundle is missing backend/, frontend/dist or wheels/" >&2; return 1; }
    tr -d '[:space:]' < "$dest/VERSION"
    echo
}

# mivnav_build_venv <release-dir>  — backend/.venv for a release bundle.
#
# The venv is built in releases/<v>.partial and then renamed, so it must not
# embed its own path: `--relocatable` gives relative script shebangs, and
# `--no-install-project` keeps the backend itself out of site-packages (it is
# imported from WorkingDirectory=backend/, exactly like a source install's
# editable one; an editable .pth would point at the .partial path). chartcore
# comes from the bundle's prebuilt abi3 wheel instead of the lock's
# `../chartcore` path source, which the bundle doesn't ship.
mivnav_build_venv() {
    local rel="$1" wheels
    # Explicit && chain, not `set -e`: callers run this as `… || fail`, a
    # context in which bash ignores -e even inside a subshell.
    wheels=("$rel"/wheels/chartcore-*.whl)
    [ -f "${wheels[0]}" ] || { echo "no chartcore wheel in $rel/wheels" >&2; return 1; }
    (
        cd "$rel/backend" &&
        rm -rf .venv &&
        mivnav_uv venv --relocatable --quiet &&
        mivnav_uv sync --frozen --no-dev --no-install-project --no-install-package chartcore &&
        mivnav_uv pip install --no-deps "${wheels[@]}" &&
        mivnav_uv run --no-sync python -c 'import chartcore, mivnav.api.app'
    )
}

# mivnav_activate <root> <version>  — point current at releases/<version>,
# atomically, and remember the old current as previous.
mivnav_activate() {
    local root="$1" ver="$2" old=""
    if [ -L "$root/current" ]; then
        old="$(basename "$(readlink "$root/current")")"
    fi
    ln -sfn "releases/$ver" "$root/current.new"
    mv -T "$root/current.new" "$root/current"
    if [ -n "$old" ] && [ "$old" != "$ver" ]; then
        ln -sfn "releases/$old" "$root/previous.new"
        mv -T "$root/previous.new" "$root/previous"
    fi
}

# mivnav_current_version <root>  → version of releases/ current points at, or "".
mivnav_current_version() {
    local root="$1"
    [ -L "$root/current" ] || return 0
    basename "$(readlink "$root/current")"
}

mivnav_previous_version() {
    local root="$1"
    [ -L "$root/previous" ] || return 0
    basename "$(readlink "$root/previous")"
}

# mivnav_prune <root>  — keep the current and previous releases, drop the rest
# (including abandoned *.partial dirs).
mivnav_prune() {
    local root="$1" cur prev d name
    cur="$(mivnav_current_version "$root")"
    prev="$(mivnav_previous_version "$root")"
    for d in "$root"/releases/*; do
        [ -e "$d" ] || continue
        name="$(basename "$d")"
        if [ "$name" = "$cur" ] || [ "$name" = "$prev" ]; then continue; fi
        rm -rf -- "$d"
    done
}

# --- system files (root-owned; rendered here, installed by install.sh) ----

# mivnav_render_unit <deploy-dir> <code-dir> <out>  — mivnav.service for a
# service running as the current user with its code at <code-dir> (a source
# checkout, or <root>/current for a release install). The shipped file is
# written for user `pi` and /home/pi/mivnav; for pi + /home/pi/mivnav this is
# byte-identical to it.
mivnav_render_unit() {
    local deploy="$1" code="$2" out="$3" user group
    user="$(id -un)"; group="$(id -gn)"
    sed -e "s#/home/pi/mivnav#${code}#g" \
        -e "s#/home/pi/#${HOME}/#g" \
        -e "s#^User=pi\$#User=${user}#" \
        -e "s#^Group=pi\$#Group=${group}#" \
        -e "s#-o pi -g pi#-o ${user} -g ${group}#g" \
        "$deploy/mivnav.service" > "$out"
}

# mivnav_render_system_files <deploy-dir> <root> <outdir>  — every root-owned
# file a release install puts on the system, rendered for the current user:
#   mivnav.service, mivnav-update@.service, 50-mivnav.rules (polkit)
# install.sh installs them and keeps a copy in <root>/system/; update.sh
# renders the NEW release's set and refuses to switch if any differ from that
# copy (it can't write /etc — the user has to re-run install.sh).
mivnav_render_system_files() {
    local deploy="$1" root="$2" out="$3" user group
    user="$(id -un)"; group="$(id -gn)"
    mkdir -p "$out"
    mivnav_render_unit "$deploy" "$root/current" "$out/mivnav.service"
    sed -e "s#/opt/mivnav#${root}#g" \
        -e "s#^User=pi\$#User=${user}#" \
        -e "s#^Group=pi\$#Group=${group}#" \
        "$deploy/mivnav-update@.service" > "$out/mivnav-update@.service"
    sed -e "s#subject.user != \"pi\"#subject.user != \"${user}\"#" \
        "$deploy/50-mivnav.rules" > "$out/50-mivnav.rules"
}

# --- runtime assets + config (same for both install kinds) ----------------

# mivnav_fetch_assets <backend-dir>  — S-52 tables + oexserverd. Needs the
# /var dirs to exist and be owned by the current user (callers create them
# with sudo). Network only the first time; a no-op once present.
mivnav_fetch_assets() {
    local backend="$1" f dest
    if [ "${MIVNAV_SKIP_ASSETS:-0}" = 1 ]; then
        echo "==> (skipping S-52 tables and oexserverd: MIVNAV_SKIP_ASSETS=1)"
        return 0
    fi
    # S-52 presentation-library tables, into config's ocharts.s52_path.
    for f in chartsymbols.xml LUPPatch1.xml LUPPatch2.xml LUPPatch3.xml LUPPatch4.xml; do
        dest="/var/lib/mivnav/s57data/$f"
        if [ -e "$dest" ]; then continue; fi
        echo "==> Fetching S-52 $f"
        curl --proto '=https' --tlsv1.2 -sSfL \
            "https://raw.githubusercontent.com/wellenvogel/ochartsng/${S52_COMMIT}/s57data/$f" -o "$dest"
    done
    # The o-charts DRM daemon. Fetched here rather than left to the first
    # encrypted-cell access, so a Pi that has been installed can decode
    # offline. A no-op (no network) when the files are present; fails the
    # install if they are missing and can't be fetched, rather than reporting
    # success on a boat whose charts won't open. Path matches config's
    # ocharts.daemon_dir.
    ( cd "$backend" && mivnav_uv run --no-sync python -c \
        "import chartcore; print('==> oexserverd ready:', chartcore.ensure_daemon('/var/cache/mivnav/oexserverd'))" )
}

# mivnav_bootstrap_config <deploy-dir>  — write the default config ONLY if
# none exists; never clobber a live config or the sibling credentials.json.
mivnav_bootstrap_config() {
    local deploy="$1" cfg="$HOME/.config/mivnav/config.json"
    install -d -m0700 "$HOME/.config/mivnav"
    if [ -e "$cfg" ]; then
        echo "==> Config exists ($cfg) — leaving it untouched."
    else
        install -m0600 "$deploy/config.default.json" "$cfg"
        echo "==> Wrote default config -> $cfg"
    fi
}

# mivnav_wait_healthy <version|""> <timeout-s>  — wait for the health URL to
# answer 200, and (if a version is given) to report that version.
mivnav_wait_healthy() {
    local want="$1" timeout="$2" deadline body
    deadline=$(( $(date +%s) + timeout ))
    while :; do
        if body="$(curl -fsS --max-time 5 "$MIVNAV_HEALTH_URL" 2>/dev/null)"; then
            if [ -z "$want" ] || printf '%s' "$body" | grep -q "\"version\"[[:space:]]*:[[:space:]]*\"${want//./\\.}\""; then
                return 0
            fi
        fi
        [ "$(date +%s)" -lt "$deadline" ] || return 1
        sleep 1
    done
}
