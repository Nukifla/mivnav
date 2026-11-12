#!/usr/bin/env bash
#
# release-notes.sh <tag> [repo] — print the Markdown release notes for <tag>.
#
#   1. The annotated tag's message (everything after its first line) as the
#      summary, so `git tag -a v0.2.0` is where you write "what's new".
#   2. "Changes": the subject of every commit since the previous release.
#      A stable release compares against the previous STABLE tag (so its
#      notes cover all the release candidates in between); a pre-release
#      compares against the previous tag of any kind.
#   3. A link to the full diff on GitHub.
#
# Used by .github/workflows/release.yml (needs the full history and tags:
# checkout with fetch-depth: 0). Runs locally too, to preview:
#     deploy/release-notes.sh v0.2.0

set -euo pipefail

tag="${1:?usage: release-notes.sh <tag> [owner/repo]}"
repo="${2:-Nukifla/mivnav}"

git rev-parse -q --verify "refs/tags/$tag" >/dev/null || {
    echo "release-notes.sh: no such tag: $tag" >&2
    exit 1
}

is_pre() { [[ "$1" == *-* ]]; }

# Previous release: walk tags newest-first by version (versionsort.suffix=- so v0.2.0-rc.1
# sorts before v0.2.0) and take the first one older than <tag>; tags on the
# same commit (e.g. a rebuild) are only "previous" if their version is lower.
prev=""
seen=0
while IFS= read -r t; do
    if [ "$t" = "$tag" ]; then seen=1; continue; fi
    [ "$seen" = 1 ] || continue
    if ! is_pre "$tag" && is_pre "$t"; then continue; fi
    prev="$t"
    break
done < <(git -c versionsort.suffix=- tag --list 'v*' --merged "$tag^{commit}" --sort=-v:refname)

# 1. Summary from the annotated tag (lightweight tags have none).
if [ "$(git cat-file -t "refs/tags/$tag")" = "tag" ]; then
    summary="$(git tag --list "$tag" --format='%(contents:body)' | sed -e '/-----BEGIN PGP SIGNATURE-----/,$d')"
    if [ -n "${summary//[$'\n\t ']/}" ]; then
        printf '%s\n\n' "$summary"
    fi
fi

# 2. Commit subjects since the previous release.
if [ -n "$prev" ]; then
    range="$prev..$tag"
    printf '## Changes since %s\n\n' "$prev"
else
    range="$tag"
    printf '## Changes\n\n'
fi
changes="$(git log --no-merges --reverse --format='- %s' "$range")"
printf '%s\n\n' "${changes:-- No code changes (rebuild only).}"

# 3. Full diff.
if [ -n "$prev" ]; then
    printf '**Full diff**: https://github.com/%s/compare/%s...%s\n' "$repo" "$prev" "$tag"
else
    printf '**Full history**: https://github.com/%s/commits/%s\n' "$repo" "$tag"
fi
