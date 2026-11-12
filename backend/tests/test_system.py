# SPDX-License-Identifier: GPL-2.0-only
"""/system: version + install detection, the GitHub release check, the
updater's status file, and starting the updater unit.

Nothing here touches the real machine: the filesystem layout is a temp
tree (:class:`SystemPaths`), GitHub is an ``httpx.MockTransport``, and
systemctl is a recording fake runner.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from mivnav.api.app import app, served_app
from mivnav.api.system import get_system_paths, get_systemctl, get_update_checker
from mivnav.config.model import UpdatesConfig
from mivnav.system import (
    SystemPaths,
    UpdateChecker,
    compare_versions,
    current_version,
    install_info,
    parse_version,
    read_status,
    valid_target,
)
from mivnav.system.updates import CACHE_TTL_S, ERROR_TTL_S, STALE_AFTER_S, pick_latest

# --- fixtures -----------------------------------------------------------------


def release_layout(root: Path, version: str = "0.2.0", unit: bool = True) -> SystemPaths:
    """``/opt/mivnav`` in miniature: releases/<v>/ with VERSION, reached
    through a ``current`` symlink exactly as the service reaches it."""
    release = root / "opt" / "releases" / version
    (release / "backend").mkdir(parents=True)
    (release / "VERSION").write_text(f"{version}\n")
    current = root / "opt" / "current"
    current.symlink_to(release)
    unit_file = root / "etc" / "mivnav-update@.service"
    if unit:
        unit_file.parent.mkdir(parents=True)
        unit_file.write_text("[Unit]\n")
    return SystemPaths(
        app_dir=current,
        releases_root=root / "opt" / "releases",
        update_unit_files=(unit_file,),
        status_file=root / "state" / "status.json",
    )


def source_layout(root: Path) -> SystemPaths:
    checkout = root / "src" / "mivnav"
    (checkout / "backend").mkdir(parents=True)
    unit_file = root / "etc" / "mivnav-update@.service"
    unit_file.parent.mkdir(parents=True)
    unit_file.write_text("[Unit]\n")  # installed, but this is not a release
    return SystemPaths(
        app_dir=checkout,
        releases_root=root / "opt" / "releases",
        update_unit_files=(unit_file,),
        status_file=root / "state" / "status.json",
    )


def write_status(paths: SystemPaths, **fields: object) -> None:
    paths.status_file.parent.mkdir(parents=True, exist_ok=True)
    paths.status_file.write_text(json.dumps(fields))


def now_iso(delta_s: float = 0.0) -> str:
    return (datetime.now(UTC) + timedelta(seconds=delta_s)).isoformat(timespec="seconds")


class FakeSystemctl:
    def __init__(self, code: int = 0, output: str = "") -> None:
        self.calls: list[list[str]] = []
        self.code = code
        self.output = output

    def __call__(self, argv):
        self.calls.append(list(argv))
        return self.code, self.output


def gh_release(tag: str, *, prerelease: bool = False, draft: bool = False, day: int = 1) -> dict:
    return {
        "tag_name": tag,
        "prerelease": prerelease,
        "draft": draft,
        "published_at": f"2026-11-{day:02d}T10:00:00Z",
        "html_url": f"https://github.com/nukifla/mivnav/releases/tag/{tag}",
        "body": f"notes for {tag}",
    }


class FakeGitHub:
    """A MockTransport answering the releases endpoint, counting calls."""

    def __init__(self, releases: list[dict] | None = None, status: int = 200) -> None:
        self.releases = releases or []
        self.status = status
        self.offline = False
        self.calls = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if self.offline:
            raise httpx.ConnectError("no route to host", request=request)
        assert request.url.path == "/repos/Nukifla/mivnav/releases"
        return httpx.Response(self.status, json=self.releases)

    def checker(self, clock=None, **config) -> UpdateChecker:
        kwargs = {"clock": clock} if clock is not None else {}
        return UpdateChecker(
            UpdatesConfig(**config), transport=httpx.MockTransport(self.handler), **kwargs
        )


class Clock:
    def __init__(self) -> None:
        self.t = 1_000_000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def overrides() -> Iterator[dict]:
    """Set system dependency overrides; drop exactly those keys after (never
    `get_runtime`, which the session fixture owns)."""
    keys = (get_system_paths, get_systemctl, get_update_checker)
    yield app.dependency_overrides
    for key in keys:
        app.dependency_overrides.pop(key, None)


def use(overrides: dict, paths: SystemPaths, runner=None, checker=None) -> None:
    overrides[get_system_paths] = lambda: paths
    if runner is not None:
        overrides[get_systemctl] = lambda: runner
    if checker is not None:
        overrides[get_update_checker] = lambda: checker


client = TestClient(app)


# --- version + install detection ---------------------------------------------


def test_release_install_with_unit_can_update(tmp_path: Path, overrides: dict) -> None:
    use(overrides, release_layout(tmp_path))
    assert client.get("/system/version").json() == {
        "version": "0.2.0",
        "install": "release",
        "can_update": True,
        "commit": None,
    }


def test_release_install_without_unit_cannot_update(tmp_path: Path) -> None:
    info = install_info(release_layout(tmp_path, unit=False))
    assert (info.install, info.can_update) == ("release", False)


def test_source_checkout_is_dev_and_never_updatable(tmp_path: Path, overrides: dict) -> None:
    paths = source_layout(tmp_path)
    git = paths.app_dir / ".git"
    (git / "refs" / "heads").mkdir(parents=True)
    (git / "HEAD").write_text("ref: refs/heads/main\n")
    (git / "refs" / "heads" / "main").write_text("0123456789abcdef0123456789abcdef01234567\n")
    use(overrides, paths)
    assert client.get("/system/version").json() == {
        "version": "dev",
        "install": "source",
        "can_update": False,
        "commit": "0123456789ab",
    }


def test_source_commit_from_detached_head_and_packed_refs(tmp_path: Path) -> None:
    paths = source_layout(tmp_path)
    git = paths.app_dir / ".git"
    git.mkdir()
    (git / "HEAD").write_text("abcdefabcdefabcdefabcdefabcdefabcdefabcd\n")
    assert install_info(paths).commit == "abcdefabcdef"
    (git / "HEAD").write_text("ref: refs/heads/main\n")
    (git / "packed-refs").write_text(
        "# pack-refs with: peeled\n1111111111111111111111111111111111111111 refs/heads/main\n"
    )
    assert install_info(paths).commit == "111111111111"


def test_no_git_no_commit(tmp_path: Path) -> None:
    assert install_info(source_layout(tmp_path)).commit is None


def test_version_file_blank_or_missing_is_dev(tmp_path: Path) -> None:
    assert current_version(tmp_path) == "dev"
    (tmp_path / "VERSION").write_text("  \n")
    assert current_version(tmp_path) == "dev"
    (tmp_path / "VERSION").write_text("1.2.3\n")
    assert current_version(tmp_path) == "1.2.3"


def test_releases_root_itself_is_not_a_release(tmp_path: Path) -> None:
    paths = release_layout(tmp_path)
    odd = SystemPaths(
        app_dir=paths.releases_root,
        releases_root=paths.releases_root,
        update_unit_files=paths.update_unit_files,
        status_file=paths.status_file,
    )
    assert install_info(odd).install == "source"


def test_healthz_carries_the_version() -> None:
    body = client.get("/healthz").json()
    assert body == {"status": "ok", "version": current_version()}
    # The served app answers it at the root too, not with the SPA's index.html.
    assert TestClient(served_app).get("/healthz").json() == body


# --- versions + targets -------------------------------------------------------


def test_version_ordering() -> None:
    assert compare_versions("0.2.0", "0.1.9") == 1
    assert compare_versions("v0.2.0", "0.2.0") == 0
    assert compare_versions("0.10.0", "0.9.0") == 1
    assert compare_versions("0.2.0-rc.1", "0.2.0") == -1
    assert compare_versions("0.2.0-rc.2", "0.2.0-rc.10") == -1
    assert compare_versions("0.2.0-rc.1", "0.2.0-beta") == 1  # "rc" > "beta"
    assert compare_versions("0.2.0-1", "0.2.0-alpha") == -1  # numeric < alnum
    assert compare_versions("dev", "0.1.0") is None
    assert parse_version("v1.2") is None


@pytest.mark.parametrize("target", ["latest", "v0.2.0", "v0.2.0-rc.1", "v10.20.30"])
def test_valid_targets(target: str) -> None:
    assert valid_target(target)


@pytest.mark.parametrize(
    "target",
    [
        "",
        "0.2.0",  # tags carry the v
        "v0.2",
        "v01.2.3",
        "rollback",  # its own endpoint
        "latest;reboot",
        "v0.2.0 ",
        "v0.2.0/../x",
        "v0.2.0-rc..1",
        "v0.2.0-$(id)",
        "v0.2.0\\x2d",
        "LATEST",
        "v0.2.0-" + "a" * 80,
    ],
)
def test_invalid_targets_rejected(target: str, tmp_path: Path, overrides: dict) -> None:
    assert not valid_target(target)
    runner = FakeSystemctl()
    use(overrides, release_layout(tmp_path), runner)
    resp = client.post("/system/update", json={"version": target})
    assert resp.status_code == 422
    assert runner.calls == []


# --- the GitHub release check --------------------------------------------------


def test_pick_latest_by_version_not_order_skipping_drafts_and_strays() -> None:
    releases = [
        gh_release("v0.1.5", day=5),  # backport published last
        gh_release("v0.3.0", draft=True),
        gh_release("nightly"),
        gh_release("v0.2.0", day=2),
        gh_release("v0.3.0-rc.1", prerelease=True, day=4),
    ]
    latest = pick_latest(releases, include_prereleases=False)
    assert latest is not None
    assert latest.version == "0.2.0"
    assert latest.notes == "notes for v0.2.0"
    assert latest.notes_url == "https://github.com/nukifla/mivnav/releases/tag/v0.2.0"
    assert latest.published_at == "2026-11-02T10:00:00Z"
    with_pre = pick_latest(releases, include_prereleases=True)
    assert with_pre is not None and with_pre.version == "0.3.0-rc.1"


def test_dash_tag_is_a_prerelease_even_if_github_says_not() -> None:
    latest = pick_latest([gh_release("v0.3.0-rc.1"), gh_release("v0.2.0")], False)
    assert latest is not None and latest.version == "0.2.0"


def test_no_releases_is_no_latest_and_no_error() -> None:
    gh = FakeGitHub([])
    result = asyncio.run(gh.checker().check())
    assert (result.latest, result.error) == (None, None)
    assert result.checked_at is not None


@pytest.mark.parametrize(
    ("tag", "available"),
    [("v0.3.0", True), ("v0.2.0", False), ("v0.1.0", False)],
)
def test_update_endpoint_newer_same_older(
    tag: str, available: bool, tmp_path: Path, overrides: dict
) -> None:
    gh = FakeGitHub([gh_release(tag)])
    use(overrides, release_layout(tmp_path, "0.2.0"), checker=gh.checker())
    body = client.get("/system/update").json()
    assert body["current"] == "0.2.0"
    assert body["latest"]["version"] == tag.removeprefix("v")
    assert body["available"] is available
    assert body["status"] == {
        "state": "idle",
        "from": None,
        "to": None,
        "message": None,
        "started_at": None,
        "updated_at": None,
    }
    assert body["error"] is None
    assert body["checked_at"]


def test_dev_checkout_never_has_an_update_available(tmp_path: Path, overrides: dict) -> None:
    gh = FakeGitHub([gh_release("v9.0.0")])
    use(overrides, source_layout(tmp_path), checker=gh.checker())
    body = client.get("/system/update").json()
    assert (body["current"], body["latest"]["version"], body["available"]) == ("dev", "9.0.0", False)


def test_prerelease_offered_only_when_configured(tmp_path: Path, overrides: dict) -> None:
    releases = [gh_release("v0.3.0-rc.1", prerelease=True), gh_release("v0.2.1")]
    paths = release_layout(tmp_path, "0.2.0")
    use(overrides, paths, checker=FakeGitHub(releases).checker())
    assert client.get("/system/update").json()["latest"]["version"] == "0.2.1"
    use(overrides, paths, checker=FakeGitHub(releases).checker(include_prereleases=True))
    assert client.get("/system/update").json()["latest"]["version"] == "0.3.0-rc.1"


def test_offline_is_an_answer_not_a_failure(tmp_path: Path, overrides: dict) -> None:
    gh = FakeGitHub([gh_release("v0.3.0")])
    gh.offline = True
    use(overrides, release_layout(tmp_path), checker=gh.checker())
    resp = client.get("/system/update")
    assert resp.status_code == 200
    body = resp.json()
    assert body["latest"] is None and body["available"] is False
    assert "not reachable" in body["error"]


def test_rate_limit_is_named(tmp_path: Path) -> None:
    gh = FakeGitHub(status=403)
    result = asyncio.run(gh.checker().check())
    assert result.error is not None and "HTTP 403" in result.error and "rate limited" in result.error


def test_garbage_answer_is_an_error() -> None:
    gh = FakeGitHub()
    gh.releases = {"message": "weird"}  # type: ignore[assignment]
    result = asyncio.run(gh.checker().check())
    assert result.error is not None and "not understood" in result.error


def test_success_cached_for_six_hours_refresh_bypasses() -> None:
    gh, clock = FakeGitHub([gh_release("v0.2.0")]), Clock()
    checker = gh.checker(clock)
    asyncio.run(checker.check())
    asyncio.run(checker.check())
    assert gh.calls == 1
    clock.t += CACHE_TTL_S - 1
    asyncio.run(checker.check())
    assert gh.calls == 1
    asyncio.run(checker.check(refresh=True))
    assert gh.calls == 2
    clock.t += CACHE_TTL_S + 1
    asyncio.run(checker.check())
    assert gh.calls == 3


def test_failure_cached_briefly_and_last_known_latest_kept() -> None:
    gh, clock = FakeGitHub([gh_release("v0.2.0")]), Clock()
    checker = gh.checker(clock)
    asyncio.run(checker.check())
    gh.offline = True
    first = asyncio.run(checker.check(refresh=True))
    assert first.error is not None
    assert first.latest is not None and first.latest.version == "0.2.0"
    asyncio.run(checker.check())  # a poll: no re-dial
    assert gh.calls == 2
    clock.t += ERROR_TTL_S + 1
    asyncio.run(checker.check())
    assert gh.calls == 3


def test_automatic_check_off_only_asks_when_told() -> None:
    gh = FakeGitHub([gh_release("v0.2.0")])
    checker = gh.checker(check=False)
    result = asyncio.run(checker.check())
    assert (result.latest, result.checked_at, result.error, gh.calls) == (None, None, None, 0)
    asyncio.run(checker.check(refresh=True))
    assert gh.calls == 1
    clock_result = asyncio.run(checker.check())  # the explicit answer is kept
    assert clock_result.latest is not None and gh.calls == 1


def test_refresh_query_reaches_the_checker(tmp_path: Path, overrides: dict) -> None:
    gh = FakeGitHub([gh_release("v0.2.0")])
    use(overrides, release_layout(tmp_path), checker=gh.checker())
    client.get("/system/update")
    client.get("/system/update?refresh=0")
    assert gh.calls == 1
    client.get("/system/update?refresh=1")
    assert gh.calls == 2


def test_checker_rebuilt_when_updates_slice_changes(isolated_runtime) -> None:
    runtime = isolated_runtime
    first = runtime.update_checker()
    assert runtime.update_checker() is first
    runtime.patch_config({"track": {"history_provider": "x"}})
    assert runtime.update_checker() is first  # unrelated slice: kept
    try:
        runtime.patch_config({"updates": {"include_prereleases": True}})
        second = runtime.update_checker()
        assert second is not first
        assert second.config.include_prereleases is True
        assert client.get("/config").json()["config"]["updates"] == {
            "check": True,
            "include_prereleases": True,
        }
    finally:
        runtime.patch_config(
            {"updates": {"include_prereleases": False}, "track": {"history_provider": None}}
        )


# --- the status file ---------------------------------------------------------------


def test_status_missing_is_idle(tmp_path: Path) -> None:
    assert read_status(tmp_path / "nope.json").state == "idle"


@pytest.mark.parametrize(
    "raw", ["{not json", "[]", '{"state": "exploded"}', '{"state": 3}', ""]
)
def test_status_corrupt_is_idle_with_a_message(tmp_path: Path, raw: str) -> None:
    path = tmp_path / "status.json"
    path.write_text(raw)
    status = read_status(path)
    assert status.state == "idle"
    assert status.message and "unreadable" in status.message


def test_status_passes_through_with_from_alias(tmp_path: Path, overrides: dict) -> None:
    paths = release_layout(tmp_path)
    fields = {
        "state": "downloading",
        "from": "0.1.0",
        "to": "0.2.0",
        "message": "Downloading mivnav-0.2.0-aarch64.tar.gz",
        "started_at": now_iso(-5),
        "updated_at": now_iso(-1),
    }
    write_status(paths, **fields)
    use(overrides, paths, checker=FakeGitHub().checker())
    assert client.get("/system/update").json()["status"] == fields


def test_status_stuck_in_progress_reads_as_failed(tmp_path: Path) -> None:
    paths = release_layout(tmp_path)
    write_status(
        paths, state="installing", started_at=now_iso(-STALE_AFTER_S - 120),
        updated_at=now_iso(-STALE_AFTER_S - 60),
    )
    status = read_status(paths.status_file)
    assert status.state == "failed"
    assert status.message and "stopped reporting" in status.message


def test_unreadable_status_file_is_not_a_500(tmp_path: Path) -> None:
    path = tmp_path / "status.json"
    path.mkdir()  # a directory where the file should be: read fails with OSError
    assert read_status(path).state == "idle"


# --- starting the updater -------------------------------------------------------------


def test_post_update_starts_the_template_unit(tmp_path: Path, overrides: dict) -> None:
    runner = FakeSystemctl()
    use(overrides, release_layout(tmp_path), runner)
    resp = client.post("/system/update", json={"version": "v0.3.0-rc.1"})
    assert resp.status_code == 202
    assert resp.json() == {"unit": "mivnav-update@v0.3.0-rc.1.service"}
    assert runner.calls == [
        ["systemctl", "start", "--no-block", "mivnav-update@v0.3.0-rc.1.service"]
    ]


def test_post_update_defaults_to_latest(tmp_path: Path, overrides: dict) -> None:
    runner = FakeSystemctl()
    use(overrides, release_layout(tmp_path), runner)
    assert client.post("/system/update", json={}).json()["unit"] == "mivnav-update@latest.service"


@pytest.mark.parametrize("path", ["/system/update", "/system/update/rollback"])
def test_source_install_is_400(path: str, tmp_path: Path, overrides: dict) -> None:
    runner = FakeSystemctl()
    use(overrides, source_layout(tmp_path), runner)
    resp = client.post(path, json={"version": "latest"})
    assert resp.status_code == 400
    assert "git" in resp.json()["detail"]
    assert runner.calls == []


def test_release_without_unit_is_400(tmp_path: Path, overrides: dict) -> None:
    runner = FakeSystemctl()
    use(overrides, release_layout(tmp_path, unit=False), runner)
    resp = client.post("/system/update", json={"version": "latest"})
    assert resp.status_code == 400
    assert "install.sh" in resp.json()["detail"]
    assert runner.calls == []


@pytest.mark.parametrize("state", ["checking", "downloading", "installing", "restarting"])
@pytest.mark.parametrize("path", ["/system/update", "/system/update/rollback"])
def test_in_progress_is_409(state: str, path: str, tmp_path: Path, overrides: dict) -> None:
    runner = FakeSystemctl()
    paths = release_layout(tmp_path)
    write_status(paths, state=state, started_at=now_iso(-10), updated_at=now_iso(-1))
    use(overrides, paths, runner)
    resp = client.post(path, json={"version": "latest"})
    assert resp.status_code == 409
    assert state in resp.json()["detail"]
    assert runner.calls == []


@pytest.mark.parametrize("state", ["idle", "done", "failed", "rolled_back"])
def test_settled_states_allow_a_new_update(state: str, tmp_path: Path, overrides: dict) -> None:
    runner = FakeSystemctl()
    paths = release_layout(tmp_path)
    write_status(paths, state=state)
    use(overrides, paths, runner)
    assert client.post("/system/update", json={"version": "latest"}).status_code == 202


def test_rollback_starts_the_rollback_instance(tmp_path: Path, overrides: dict) -> None:
    runner = FakeSystemctl()
    use(overrides, release_layout(tmp_path), runner)
    resp = client.post("/system/update/rollback")
    assert resp.status_code == 202
    assert resp.json() == {"unit": "mivnav-update@rollback.service"}
    assert runner.calls == [["systemctl", "start", "--no-block", "mivnav-update@rollback.service"]]


def test_systemd_refusal_is_503_with_its_words(tmp_path: Path, overrides: dict) -> None:
    runner = FakeSystemctl(code=4, output="Access denied")
    use(overrides, release_layout(tmp_path), runner)
    resp = client.post("/system/update", json={"version": "latest"})
    assert resp.status_code == 503
    assert "Access denied" in resp.json()["detail"]


def test_default_seams_point_at_the_real_layout() -> None:
    paths = get_system_paths()
    assert paths.releases_root == Path("/opt/mivnav/releases")
    assert paths.status_file == Path("/var/lib/mivnav/update/status.json")
    assert Path("/etc/systemd/system/mivnav-update@.service") in paths.update_unit_files
    # The running code's release dir is the repo root in a checkout.
    assert (paths.app_dir / "backend" / "mivnav").is_dir()
    assert os.path.realpath(paths.app_dir) == str(paths.app_dir)
