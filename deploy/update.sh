#!/usr/bin/env bash
#
# update.sh — update (or roll back) a RELEASE install of mivnav.
#
#     update.sh latest          newest release (pre-releases only with --prerelease)
#     update.sh v0.2.0          that release (also how you go back further than one)
#     update.sh rollback        back to the previous release (kept on disk)
#     update.sh --check         print current / latest and exit; changes nothing
#
# Lives at /opt/mivnav/current/deploy/update.sh. Runs as the SERVICE USER, not
# root: from a shell, or from the UI via `mivnav-update@<arg>.service`, which
# the polkit rule deploy/install.sh installed lets the backend start. It
# restarts mivnav.service through that same rule, never through sudo.
#
# An update: resolve the tag (GitHub API), download the bundle + SHA256SUMS,
# verify the checksum, unpack to releases/<v>.partial, build its venv, rename
# to releases/<v>, swap the `current` symlink atomically, restart mivnav, and
# wait (up to MIVNAV_HEALTH_TIMEOUT, 90 s) for the health endpoint to report
# the new version. If it doesn't, swap back, restart, and report rolled_back.
# Keeps the current and previous release; older ones are pruned.
#
# A release whose root-owned files (the units, the polkit rule) differ from
# the installed ones can't be applied without root: the updater then changes
# nothing and reports `failed`, asking for deploy/install.sh to be run once.
#
# Progress goes to $MIVNAV_STATE_DIR/status.json (atomically replaced; the
# backend polls it) and the full log to $MIVNAV_STATE_DIR/update.log (bounded).
# Paths are overridable for tests — see the top of deploy/lib.sh.

set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ROOT="$MIVNAV_ROOT"
STATE="$MIVNAV_STATE_DIR"
LOG_MAX_BYTES="${MIVNAV_LOG_MAX_BYTES:-524288}"

STARTED_AT=""
FROM=""
TO=""
FINISHED=0
WORK=""

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

json_str() {
    local s="$1"
    s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
    s="${s//$'\n'/ }"; s="${s//$'\r'/ }"; s="${s//$'\t'/ }"
    printf '"%s"' "$s"
}

# status <state> <message>  — replace status.json atomically, log the line.
status() {
    local state="$1" msg="$2" tmp
    tmp="$STATE/.status.json.$$"
    printf '{"state": %s, "from": %s, "to": %s, "message": %s, "started_at": %s, "updated_at": %s}\n' \
        "$(json_str "$state")" "$(json_str "$FROM")" "$(json_str "$TO")" "$(json_str "$msg")" \
        "$(json_str "$STARTED_AT")" "$(json_str "$(now)")" > "$tmp"
    mv -f "$tmp" "$STATE/status.json"
    printf '[%s] %s: %s\n' "$(now)" "$state" "$msg"
    case "$state" in done|failed|rolled_back) FINISHED=1 ;; esac
}

fail() { status failed "$1"; exit 1; }

on_exit() {
    local rc=$?
    [ -n "$WORK" ] && rm -rf "$WORK"
    # Never leave an in-progress state behind (the backend refuses to start
    # another update while one is "running").
    if [ "$FINISHED" = 0 ] && [ -n "$STARTED_AT" ]; then
        status failed "the updater stopped unexpectedly (exit $rc) — see $STATE/update.log"
    fi
}

restart_service() {
    systemctl restart mivnav.service
}

# check_system_files <release-dir>  — 0 if its rendered units/polkit rule
# match what install.sh installed (kept in $ROOT/system/).
check_system_files() {
    local rel="$1" out f
    out="$WORK/system"
    rm -rf "$out"
    # Rendered by the NEW release's own lib.sh (in a child shell, so its
    # definitions don't replace ours) — its templates and its renderer.
    # shellcheck disable=SC2016  # expanded by the child shell
    bash -c '. "$1/deploy/lib.sh" && mivnav_render_system_files "$1/deploy" "$2" "$3"' \
        _ "$rel" "$ROOT" "$out" || return 1
    for f in mivnav.service mivnav-update@.service 50-mivnav.rules; do
        cmp -s "$out/$f" "$ROOT/system/$f" || { echo "system file differs: $f"; return 1; }
    done
}

reinstall_hint() {
    printf 'run the installer once by hand: curl -fsSL https://github.com/%s/releases/download/%s/install.sh | bash -s -- --version %s' \
        "$MIVNAV_GITHUB_REPO" "$1" "$1"
}

do_update() {
    local want="$1" pre="$2" tag ver arch tarball partial got prev_before
    status checking "Looking for $want"
    tag="$(mivnav_resolve_tag "$want" "$pre" 2>&1)" || fail "Could not find the release: $tag"
    ver="${tag#v}"
    TO="$ver"
    if [ "$ver" = "$FROM" ]; then
        status "done" "Already on $ver"
        return 0
    fi
    # "latest" never downgrades (e.g. from a pre-release); an explicit tag may.
    if [ "$want" = latest ] && mivnav_version_gt "$FROM" "$ver"; then
        status "done" "Already on $FROM, newer than the latest release ($ver)"
        return 0
    fi
    arch="$(mivnav_arch)" || fail "No prebuilt mivnav for $(uname -m)"

    status downloading "Downloading $tag ($arch)"
    tarball="$(mivnav_download_bundle "$tag" "$arch" "$WORK" 2>&1)" || fail "Download failed: ${tarball##*$'\n'}"
    tarball="${tarball##*$'\n'}"

    status installing "Unpacking $ver"
    partial="$ROOT/releases/$ver.partial"
    rm -rf "$partial"
    got="$(mivnav_unpack_bundle "$tarball" "$partial")" || { rm -rf "$partial"; fail "Bundle is damaged"; }
    [ "$got" = "$ver" ] || { rm -rf "$partial"; fail "Bundle says it is $got, expected $ver"; }

    if ! check_system_files "$partial"; then
        rm -rf "$partial"
        fail "Version $ver changes system files and needs root to install; $(reinstall_hint "$tag")"
    fi

    status installing "Building the Python environment for $ver"
    mivnav_build_venv "$partial" || { rm -rf "$partial"; fail "Building the Python environment for $ver failed"; }
    # A same-named dir is a release we went back from earlier (never current).
    rm -rf "${ROOT:?}/releases/$ver"
    mv -T "$partial" "$ROOT/releases/$ver"

    prev_before="$(mivnav_previous_version "$ROOT")"
    status restarting "Restarting on $ver"
    mivnav_activate "$ROOT" "$ver"
    restart_service || true
    if mivnav_wait_healthy "$ver" "$MIVNAV_HEALTH_TIMEOUT"; then
        mivnav_prune "$ROOT"
        status "done" "Updated $FROM → $ver"
        return 0
    fi

    # The new release didn't come up: put the old one back, and forget the
    # broken one so a later "rollback" doesn't pick it.
    status restarting "$ver did not start within ${MIVNAV_HEALTH_TIMEOUT}s — rolling back to $FROM"
    mivnav_activate "$ROOT" "$FROM"
    if [ -n "$prev_before" ]; then
        ln -sfn "releases/$prev_before" "$ROOT/previous.new" && mv -T "$ROOT/previous.new" "$ROOT/previous"
    else
        rm -f "$ROOT/previous"
    fi
    rm -rf "${ROOT:?}/releases/$ver"
    restart_service || true
    if mivnav_wait_healthy "$FROM" "$MIVNAV_HEALTH_TIMEOUT"; then
        status rolled_back "$ver failed its health check; rolled back to $FROM"
    else
        status rolled_back "$ver failed its health check; rolled back to $FROM, which is not answering either — see journalctl -u mivnav"
    fi
    exit 1
}

do_rollback() {
    local prev
    prev="$(mivnav_previous_version "$ROOT")"
    [ -n "$prev" ] && [ -d "$ROOT/releases/$prev" ] || fail "There is no previous release to roll back to"
    TO="$prev"
    status checking "Rolling back $FROM → $prev"
    check_system_files "$ROOT/releases/$prev" \
        || fail "Version $prev uses different system files and needs root; $(reinstall_hint "v$prev")"
    status restarting "Restarting on $prev"
    mivnav_activate "$ROOT" "$prev"
    restart_service || true
    if mivnav_wait_healthy "$prev" "$MIVNAV_HEALTH_TIMEOUT"; then
        status "done" "Rolled back $FROM → $prev"
        return 0
    fi
    mivnav_activate "$ROOT" "$FROM"
    restart_service || true
    mivnav_wait_healthy "$FROM" "$MIVNAV_HEALTH_TIMEOUT" || true
    fail "$prev did not start within ${MIVNAV_HEALTH_TIMEOUT}s; stayed on $FROM"
}

do_check() {
    local pre="$1" tag cur
    cur="$(mivnav_current_version "$ROOT")"
    tag="$(mivnav_resolve_tag latest "$pre")" || exit 1
    printf 'current: %s\nlatest:  %s\n' "${cur:-none}" "${tag#v}"
    if [ "${tag#v}" = "$cur" ] || mivnav_version_gt "$cur" "${tag#v}"; then
        echo "Up to date."
    else
        echo "Update available: update.sh ${tag}"
    fi
}

usage() {
    echo "usage: update.sh [--prerelease] latest|vX.Y.Z|rollback   or   update.sh [--prerelease] --check" >&2
    exit 2
}

main() {
    local pre="${MIVNAV_INCLUDE_PRERELEASES:-0}" check=0 arg=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --prerelease) pre=1 ;;
            --check)      check=1 ;;
            -h|--help)    usage ;;
            -*)           usage ;;
            *)            [ -z "$arg" ] || usage; arg="$1" ;;
        esac
        shift
    done
    if [ "$check" = 1 ]; then do_check "$pre"; return; fi
    [ -n "$arg" ] || usage
    if [ "$arg" != latest ] && [ "$arg" != rollback ] && ! [[ "$arg" =~ $MIVNAV_TAG_RE ]]; then
        echo "not a release tag: $arg (expected e.g. v0.2.0)" >&2
        usage
    fi
    [ "$(id -u)" -ne 0 ] || [ "${MIVNAV_ALLOW_ROOT:-0}" = 1 ] \
        || { echo "run update.sh as the mivnav service user, not root" >&2; exit 1; }

    mkdir -p "$STATE"
    # One updater at a time. A second one leaves the first's status alone.
    exec 9>"$STATE/update.lock"
    flock -n 9 || { echo "another update is already running" >&2; exit 1; }

    # Bound the log before appending to it: keep the newest half once it
    # passes the cap.
    local log="$STATE/update.log"
    if [ -f "$log" ] && [ "$(stat -c %s "$log")" -gt "$LOG_MAX_BYTES" ]; then
        tail -c "$((LOG_MAX_BYTES / 2))" "$log" > "$log.tmp" && mv -f "$log.tmp" "$log"
    fi
    exec > >(tee -a "$log") 2>&1
    echo "──── $(now) update.sh $arg"

    FROM="$(mivnav_current_version "$ROOT")"
    STARTED_AT="$(now)"
    WORK="$(mktemp -d "$ROOT/.update.XXXXXX")"
    trap on_exit EXIT
    [ -n "$FROM" ] || fail "$ROOT/current is missing — this is not a release install; run install.sh"

    case "$arg" in
        rollback) do_rollback ;;
        *)        do_update "$arg" "$pre" ;;
    esac
}

# One function, called last: bash has parsed the whole script before running
# any of it, so swapping `current` (this file's own directory) mid-run is safe.
main "$@"
