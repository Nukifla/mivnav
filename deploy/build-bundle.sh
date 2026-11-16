#!/usr/bin/env bash
#
# build-bundle.sh — assemble a release bundle from already-built parts.
#
#     deploy/build-bundle.sh <version> <arch> <chartcore-wheel> <frontend-dist> <outdir>
#
# Writes <outdir>/mivnav-<version>-<arch>.tar.gz containing mivnav-<version>/:
#   VERSION          <version> (the tag without its `v`)
#   backend/         pyproject.toml, uv.lock, main.py, mivnav/ — no .venv, no
#                    data/, no tests/, no __pycache__
#   frontend/dist/   the built web UI
#   deploy/          installer, updater, units, polkit rule, default config
#   wheels/          the prebuilt chartcore wheel (abi3: any CPython >= 3.12)
#
# Used by .github/workflows/release.yml (per arch) and `just bundle` (a local
# bundle for the host arch, for testing). Prints the tarball path.

set -euo pipefail

[ $# -eq 5 ] || { echo "usage: $0 <version> <arch> <chartcore-wheel> <frontend-dist> <outdir>" >&2; exit 2; }
version="$1" arch="$2" wheel="$3" dist="$4" outdir="$5"

# The tree to bundle; deploy/tests/ points it at a fake one.
repo="${MIVNAV_BUNDLE_SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

[[ "v$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "bad version '$version' (want e.g. 0.2.0, no leading v)" >&2; exit 1; }
case "$arch" in aarch64|x86_64) ;; *) echo "bad arch '$arch' (aarch64|x86_64)" >&2; exit 1 ;; esac
[ -f "$wheel" ] || { echo "no wheel at $wheel" >&2; exit 1; }
case "$(basename "$wheel")" in
    chartcore-*-abi3-*"$arch"*.whl) ;;
    *) echo "$wheel is not an abi3 chartcore wheel for $arch" >&2; exit 1 ;;
esac
[ -f "$dist/index.html" ] || { echo "$dist does not look like a built frontend (no index.html)" >&2; exit 1; }

name="mivnav-$version"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
top="$stage/$name"
mkdir -p "$top/backend" "$top/frontend" "$top/deploy" "$top/wheels"

printf '%s\n' "$version" > "$top/VERSION"

# backend: an explicit allow-list, so nothing local (.venv, data/, caches,
# tests, tools) can leak in. Note mivnav/data/ IS source (a package) — only
# the top-level backend/data/ is runtime data, and it isn't listed here.
cp "$repo/backend/pyproject.toml" "$repo/backend/uv.lock" "$repo/backend/.python-version" "$repo/backend/main.py" "$top/backend/"
tar -C "$repo/backend" --exclude='__pycache__' --exclude='*.pyc' -cf - mivnav | tar -C "$top/backend" -xf -

cp -r "$dist" "$top/frontend/dist"

# deploy/: everything the Pi side uses; not the tests or this script.
for f in "$repo"/deploy/*; do
    case "$(basename "$f")" in
        tests|build-bundle.sh) continue ;;
    esac
    cp -r "$f" "$top/deploy/"
done

cp "$wheel" "$top/wheels/"

mkdir -p "$outdir"
out="$(cd "$outdir" && pwd)/$name-$arch.tar.gz"
# Reproducible-ish: fixed owner, sorted entries.
tar -C "$stage" --owner=0 --group=0 --numeric-owner --sort=name -czf "$out" "$name"
printf '%s\n' "$out"
