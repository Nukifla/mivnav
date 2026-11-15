#!/usr/bin/env bash
#
# test_update.sh — exercise the release installer + updater end to end,
# without root, systemd or network.
#
#     bash deploy/tests/test_update.sh        (or: just test-deploy)
#
# Builds a FAKE source tree (a tiny backend + fake chartcore wheel, so venv
# builds are offline and take a second) around the REAL deploy/ scripts,
# bundles several versions of it with the real build-bundle.sh, serves them
# plus fake GitHub API JSON and a fake health endpoint from fake_server.py,
# stubs `sudo` and `systemctl` via PATH, and points every system path
# (/opt/mivnav, /etc/systemd/system, polkit, /var/lib/mivnav/update, $HOME)
# into a temp dir. Needs: bash, python3 (>= 3.12, for the fake venv), uv.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

T="$(mktemp -d)"
SERVER_PID=""
cleanup() {
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
    if [ "${KEEP:-0}" = 1 ]; then echo "kept $T"; else rm -rf "$T"; fi
}
trap cleanup EXIT

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
section() { printf '\n== %s\n' "$1"; }

ARCH="$(uname -m)"; [ "$ARCH" = arm64 ] && ARCH=aarch64

# uv's cache + interpreters stay the real user's (offline, fast); everything
# else that keys off $HOME moves into the sandbox.
UV_CACHE_DIR="$(uv cache dir)"
UV_PYTHON_INSTALL_DIR="$(uv python dir)"
export UV_CACHE_DIR UV_PYTHON_INSTALL_DIR UV_OFFLINE=1 UV_NO_PROGRESS=1

# ── fake source tree ────────────────────────────────────────────────────
SRC="$T/src"
mkdir -p "$SRC/backend/mivnav/api" "$SRC/chartcore" "$SRC/dist"
cp -r "$REPO/deploy" "$SRC/deploy"
rm -rf "$SRC/deploy/tests"
cat > "$SRC/chartcore/pyproject.toml" <<'EOF'
[project]
name = "chartcore"
version = "0.1.0"
requires-python = ">=3.12"
EOF
cat > "$SRC/backend/pyproject.toml" <<'EOF'
[project]
name = "mivnav"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["chartcore"]

[tool.uv.sources]
chartcore = { path = "../chartcore" }
EOF
echo 'app = None' > "$SRC/backend/main.py"
: > "$SRC/backend/mivnav/__init__.py"
: > "$SRC/backend/mivnav/api/__init__.py"
echo 'served_app = None' > "$SRC/backend/mivnav/api/app.py"
mkdir -p "$SRC/backend/mivnav/__pycache__" "$SRC/backend/.venv" "$SRC/backend/data" "$SRC/backend/tests"
: > "$SRC/backend/mivnav/__pycache__/junk.pyc"
echo '<!doctype html>' > "$SRC/dist/index.html"
(cd "$SRC/backend" && uv lock --quiet)

# A fake chartcore wheel, tagged like the real abi3 one.
WHEEL="$T/wheel/chartcore-0.1.0-cp312-abi3-linux_${ARCH}.whl"
mkdir -p "$T/wheel"
python3 - "$WHEEL" "$ARCH" <<'EOF'
import sys, zipfile
path, arch = sys.argv[1:3]
di = "chartcore-0.1.0.dist-info"
files = {
    "chartcore/__init__.py": "FAKE = True\n",
    f"{di}/METADATA": "Metadata-Version: 2.1\nName: chartcore\nVersion: 0.1.0\n",
    f"{di}/WHEEL": f"Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: false\nTag: cp312-abi3-linux_{arch}\n",
}
with zipfile.ZipFile(path, "w") as z:
    for n, c in files.items():
        z.writestr(n, c)
    z.writestr(f"{di}/RECORD", "".join(f"{n},,\n" for n in files) + f"{di}/RECORD,,\n")
EOF

# ── bundles + fake GitHub ───────────────────────────────────────────────
REPO_SLUG="Nukifla/mivnav"
WWW="$T/www"
API_DIR="$WWW/repos/$REPO_SLUG"
mkdir -p "$API_DIR/releases/tags"

# release <version> [corrupt-sums]  — bundle the fake tree as v<version>.
release() {
    local ver="$1" dldir="$WWW/$REPO_SLUG/releases/download/v$1" tarball
    mkdir -p "$dldir"
    tarball="$(MIVNAV_BUNDLE_SRC="$SRC" bash "$REPO/deploy/build-bundle.sh" "$ver" "$ARCH" "$WHEEL" "$SRC/dist" "$dldir")"
    (cd "$dldir" && sha256sum "$(basename "$tarball")" > SHA256SUMS)
    if [ "${2:-}" = corrupt-sums ]; then
        sed -i "s/^[0-9a-f]*/$(printf '0%.0s' $(seq 64))/" "$dldir/SHA256SUMS"
    fi
    cp "$REPO/deploy/install.sh" "$dldir/install.sh"
    printf '{"tag_name": "v%s", "prerelease": false}\n' "$ver" > "$API_DIR/releases/tags/v$ver"
}
set_latest() { printf '{"url": "x", "tag_name": "v%s", "prerelease": false}\n' "$1" > "$API_DIR/releases/latest"; }

for v in 1.0.0 2.0.0 3.0.0 6.0.0 7.0.0-rc.1; do release "$v"; done
release 5.0.0 corrupt-sums
# 4.0.0 ships a changed update unit → needs root → must be refused.
cp "$SRC/deploy/mivnav-update@.service" "$T/update-unit.orig"
echo "# changed in 4.0.0" >> "$SRC/deploy/mivnav-update@.service"
release 4.0.0
cp "$T/update-unit.orig" "$SRC/deploy/mivnav-update@.service"
set_latest 2.0.0
printf '[{"tag_name": "v7.0.0-rc.1", "prerelease": true}, {"tag_name": "v6.0.0", "prerelease": false}]\n' \
    > "$API_DIR/releases.json"

# ── sandbox + stubs ─────────────────────────────────────────────────────
ROOT="$T/opt/mivnav"
STATE="$T/var/lib/mivnav/update"
BROKEN="$T/broken"
: > "$BROKEN"
mkdir -p "$T/bin" "$T/home"
cat > "$T/bin/sudo" <<'EOF'
#!/usr/bin/env bash
exec "$@"
EOF
cat > "$T/bin/systemctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$T/systemctl.log"
EOF
chmod +x "$T/bin/sudo" "$T/bin/systemctl"

python3 "$HERE/fake_server.py" "$WWW" "$ROOT" "$BROKEN" "$T/port" &
SERVER_PID=$!
for _ in $(seq 50); do [ -s "$T/port" ] && break; sleep 0.1; done
PORT="$(cat "$T/port")"
BASE="http://127.0.0.1:$PORT"

export PATH="$T/bin:$PATH" HOME="$T/home"
export MIVNAV_ROOT="$ROOT" MIVNAV_STATE_DIR="$STATE" MIVNAV_GITHUB_REPO="$REPO_SLUG"
export MIVNAV_GITHUB_API="$BASE" MIVNAV_GITHUB_DOWNLOAD="$BASE"
export MIVNAV_HEALTH_URL="$BASE/api/healthz" MIVNAV_HEALTH_TIMEOUT=3
export MIVNAV_SYSTEMD_DIR="$T/etc/systemd/system" MIVNAV_POLKIT_DIR="$T/etc/polkit-1/rules.d"
export MIVNAV_SKIP_DEPS=1 MIVNAV_SKIP_ASSETS=1 MIVNAV_LOG_MAX_BYTES=4000

cur()  { basename "$(readlink "$ROOT/current")"; }
prev() { if [ -L "$ROOT/previous" ]; then basename "$(readlink "$ROOT/previous")"; fi; }
releases() { local d out=""; for d in "$ROOT"/releases/*; do out+="$(basename "$d") "; done; printf '%s' "$out"; }
state() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$STATE/status.json" "$1"; }
UPDATE() { "$ROOT/current/deploy/update.sh" "$@" > "$T/out" 2>&1; }
DL="$WWW/$REPO_SLUG/releases/download"

# ── tests ───────────────────────────────────────────────────────────────
section "bundle contents"
listing="$(tar -tzf "$DL/v1.0.0/mivnav-1.0.0-$ARCH.tar.gz")"
check "top dir + VERSION"     grep -qx "mivnav-1.0.0/VERSION" <<<"$listing"
check "wheel"                 grep -q "^mivnav-1.0.0/wheels/chartcore-.*abi3.*\.whl$" <<<"$listing"
check "frontend dist"         grep -qx "mivnav-1.0.0/frontend/dist/index.html" <<<"$listing"
check "update.sh + units"     bash -c 'grep -qx "mivnav-1.0.0/deploy/update.sh" && true' <<<"$listing"
check "no __pycache__/.venv/data/tests" bash -c '! grep -Eq "__pycache__|\.venv|backend/data|backend/tests|deploy/tests|build-bundle"' <<<"$listing"

section "install.sh: refuses a bundle whose checksum doesn't match"
if bash "$REPO/deploy/install.sh" --bundle "$DL/v5.0.0/mivnav-5.0.0-$ARCH.tar.gz" --sums "$DL/v5.0.0/SHA256SUMS" > "$T/out" 2>&1; then
    bad "install with bad checksum succeeded"
else
    check "checksum mismatch reported" grep -q "checksum mismatch" "$T/out"
    check "nothing installed" test ! -e "$ROOT/current"
fi
check "failed install leaves a log"   grep -q "checksum mismatch" "$HOME/mivnav-install.log"
check "…with diagnostics appended"    grep -q "Diagnostics follow" "$HOME/mivnav-install.log"
check "…and says to send it"          grep -q "Please send .*mivnav-install.log" "$T/out"

section "install.sh --diagnose"
if bash "$REPO/deploy/install.sh" --diagnose > "$T/out" 2>&1; then ok "diagnose exits 0"; else bad "diagnose exits 0"; cat "$T/out"; fi
check "report written"                grep -q "# mivnav diagnostics" "$HOME/mivnav-diagnostics.txt"
check "report has os-release"         grep -q 'cat /etc/os-release' "$HOME/mivnav-diagnostics.txt"
check "diagnose installs nothing"     test ! -e "$ROOT/current"

section "install.sh v1.0.0 (latest download path, --version)"
if bash "$REPO/deploy/install.sh" --version v1.0.0 > "$T/out" 2>&1; then ok "install exits 0"; else bad "install exits 0"; cat "$T/out"; fi
check "current -> 1.0.0"        test "$(cur)" = 1.0.0
check "relative symlink"        test "$(readlink "$ROOT/current")" = releases/1.0.0
check "venv built"              test -x "$ROOT/current/backend/.venv/bin/python"
check "chartcore wheel in venv" bash -c "cd '$ROOT/current/backend' && uv run --no-sync python -c 'import chartcore; assert chartcore.FAKE'"
check "unit installed, points at current" grep -qx "WorkingDirectory=$ROOT/current/backend" "$MIVNAV_SYSTEMD_DIR/mivnav.service"
check "unit rendered for this user" grep -qx "User=$(id -un)" "$MIVNAV_SYSTEMD_DIR/mivnav.service"
check "update unit installed"   grep -qx "ExecStart=$ROOT/current/deploy/update.sh %i" "$MIVNAV_SYSTEMD_DIR/mivnav-update@.service"
check "polkit rule for this user" grep -q "subject.user != \"$(id -un)\"" "$MIVNAV_POLKIT_DIR/50-mivnav.rules"
check "system copy kept"        cmp -s "$ROOT/system/mivnav.service" "$MIVNAV_SYSTEMD_DIR/mivnav.service"
check "config bootstrapped"     test -f "$HOME/.config/mivnav/config.json"
check "install log written"     grep -q "is running" "$HOME/mivnav-install.log"
check "no diagnostics on success" bash -c "! grep -q 'Diagnostics follow' '$HOME/mivnav-install.log'"
check "systemctl enable+restart" bash -c "grep -qx 'enable mivnav.service' '$T/systemctl.log' && grep -qx 'restart mivnav.service' '$T/systemctl.log'"
check "no partial left"         test ! -e "$ROOT/releases/1.0.0.partial"

section "install.sh re-run (repair) is idempotent and keeps config"
echo '{"marker": true}' > "$HOME/.config/mivnav/config.json"
if bash "$REPO/deploy/install.sh" --bundle "$DL/v1.0.0/mivnav-1.0.0-$ARCH.tar.gz" --sums "$DL/v1.0.0/SHA256SUMS" > "$T/out" 2>&1; then ok "re-install exits 0"; else bad "re-install exits 0"; cat "$T/out"; fi
check "still current -> 1.0.0"  test "$(cur)" = 1.0.0
check "config untouched"        grep -q marker "$HOME/.config/mivnav/config.json"
check "releases: just 1.0.0"    test "$(releases)" = "1.0.0 "

section "update.sh --check"
UPDATE --check || true
check "reports latest 2.0.0"    grep -q "latest:  2.0.0" "$T/out"
UPDATE --check --prerelease || true
check "--prerelease sees 7.0.0-rc.1" grep -q "latest:  7.0.0-rc.1" "$T/out"
check "--check writes no status" test ! -e "$STATE/status.json"

section "update.sh rejects bad arguments"
if UPDATE 'v1;rm -rf /'; then bad "bad arg accepted"; else ok "bad arg rejected"; fi
if UPDATE; then bad "no arg accepted"; else ok "no arg rejected"; fi

section "update.sh latest → 2.0.0"
if UPDATE latest; then ok "update exits 0"; else bad "update exits 0"; cat "$T/out"; fi
check "current -> 2.0.0"        test "$(cur)" = 2.0.0
check "previous -> 1.0.0"       test "$(prev)" = 1.0.0
check "status done"             test "$(state state)" = "done"
check "status from/to"          test "$(state from)-$(state to)" = 1.0.0-2.0.0
check "status has timestamps"   bash -c "[[ \$(python3 -c 'import json;d=json.load(open(\"$STATE/status.json\"));print(d[\"started_at\"],d[\"updated_at\"])') =~ ^[0-9]{4}-.*Z\ [0-9]{4}-.*Z$ ]]"
check "restarted mivnav"        test "$(grep -c 'restart mivnav.service' "$T/systemctl.log")" -ge 3
check "log written"             grep -q "update.sh latest" "$STATE/update.log"

section "update.sh latest again → already up to date"
if UPDATE latest; then ok "exits 0"; else bad "exits 0"; fi
check "status done, already"    bash -c "grep -q 'Already on 2.0.0' '$STATE/status.json'"

section "health check fails → automatic rollback"
echo 3.0.0 > "$BROKEN"
if UPDATE v3.0.0; then bad "broken update exits non-zero"; else ok "broken update exits non-zero"; fi
check "status rolled_back"      test "$(state state)" = rolled_back
check "message: health check"   grep -q "failed its health check; rolled back to 2.0.0\"" "$STATE/status.json"
check "current back on 2.0.0"   test "$(cur)" = 2.0.0
check "previous still 1.0.0"    test "$(prev)" = 1.0.0
check "broken release removed"  test ! -e "$ROOT/releases/3.0.0"

section "explicit rollback"
if UPDATE rollback; then ok "rollback exits 0"; else bad "rollback exits 0"; cat "$T/out"; fi
check "current -> 1.0.0"        test "$(cur)" = 1.0.0
check "previous -> 2.0.0 (roll forward possible)" test "$(prev)" = 2.0.0
check "status done"             test "$(state state)-$(state to)" = done-1.0.0

section "sha mismatch rejected"
if UPDATE v5.0.0; then bad "bad checksum accepted"; else ok "bad checksum rejected"; fi
check "status failed"           test "$(state state)" = failed
check "message says checksum"   grep -q "checksum mismatch" "$STATE/status.json"
check "current unchanged"       test "$(cur)" = 1.0.0
check "nothing unpacked"        bash -c "! ls -d '$ROOT'/releases/5.0.0* 2>/dev/null"

section "unit-file change refused"
if UPDATE v4.0.0; then bad "unit change accepted"; else ok "unit change refused"; fi
check "status failed"           test "$(state state)" = failed
check "message says system files + install.sh" bash -c "grep -q 'changes system files' '$STATE/status.json' && grep -q 'install.sh' '$STATE/status.json'"
check "current unchanged"       test "$(cur)" = 1.0.0
check "nothing left"            bash -c "! ls -d '$ROOT'/releases/4.0.0* 2>/dev/null"

section "pruning keeps current + previous"
UPDATE v2.0.0 || { bad "update to 2.0.0"; cat "$T/out"; }
UPDATE v6.0.0 || { bad "update to 6.0.0"; cat "$T/out"; }
check "current 6.0.0, previous 2.0.0" test "$(cur)/$(prev)" = 6.0.0/2.0.0
check "releases: 2.0.0 6.0.0"   test "$(releases)" = "2.0.0 6.0.0 "

section "concurrency + log bound"
exec 8>"$STATE/update.lock"; flock 8
if UPDATE latest; then bad "second updater ran"; else ok "second updater refused while locked"; fi
check "refusal left status alone" test "$(state to)" = 6.0.0
flock -u 8; exec 8>&-
for _ in 1 2 3; do UPDATE latest || true; done
check "log bounded"             test "$(stat -c %s "$STATE/update.log")" -le 8000
check "no work dirs left"       bash -c "! ls -d '$ROOT'/.update.* 2>/dev/null"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
