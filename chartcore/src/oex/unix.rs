// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Minimal Unix plumbing for the daemon client: signals, FIFOs, process
//! discovery, and child hygiene (see [`harden_child`]).
//!
//! Raw `extern "C"` bindings instead of the `libc` crate — std already links
//! libc. Linux-only, like `oexserverd` itself (`close_range` needs 5.11, the
//! tightest constraint here); no `cfg` gating since `oex` never builds
//! elsewhere.

use std::ffi::{c_char, c_int, c_uint, c_ulong, CString};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::process::Command;

pub const SIGTERM: c_int = 15;
pub const SIGKILL: c_int = 9;
/// `O_NONBLOCK` on Linux (asm-generic value, same on x86_64/aarch64).
pub const O_NONBLOCK: i32 = 0o4000;
/// `close_range(2)` flag: set `FD_CLOEXEC` on the range instead of closing it
/// now. Linux 5.11+.
const CLOSE_RANGE_CLOEXEC: c_uint = 1 << 2;
/// `prctl(2)`: deliver a signal to this process when its parent thread dies.
const PR_SET_PDEATHSIG: c_int = 1;

extern "C" {
    fn kill(pid: c_int, sig: c_int) -> c_int;
    fn mkfifo(path: *const c_char, mode: c_uint) -> c_int;
    /// glibc 2.34+. A missing wrapper is a link error, not a silent fallback
    /// to leaking.
    fn close_range(first: c_uint, last: c_uint, flags: c_uint) -> c_int;
    fn prctl(option: c_int, ...) -> c_int;
    fn getppid() -> c_int;
    fn _exit(status: c_int) -> !;
}

/// Send `sig` to a process (positive pid) or process group (negative pid).
pub fn send_signal(pid: i32, sig: c_int) -> io::Result<()> {
    if unsafe { kill(pid, sig) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Is the process (or process group, negative pid) alive? Signal 0 probes
/// without delivering.
pub fn process_alive(pid: i32) -> bool {
    unsafe { kill(pid, 0) == 0 }
}

/// Create a named pipe. `Ok(false)` if the path already existed.
pub fn make_fifo(path: &Path, mode: u32) -> io::Result<bool> {
    let c = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in fifo path"))?;
    if unsafe { mkfifo(c.as_ptr(), mode) } == 0 {
        return Ok(true);
    }
    let err = io::Error::last_os_error();
    if err.kind() == io::ErrorKind::AlreadyExists {
        Ok(false)
    } else {
        Err(err)
    }
}

/// Live processes running exactly `exe`, excluding ourselves.
///
/// Matches on the kernel's own `/proc/<pid>/exe` link rather than on a name or
/// a cmdline, so it cannot be fooled by a process that merely calls itself
/// `oexserverd`. Pids we may not inspect (other users') fail the readlink and
/// are skipped — we could not signal them anyway.
///
/// A zombie's `exe` link is empty, so an exited-but-unreaped process is
/// correctly reported as gone; callers can poll this to watch a kill land.
///
/// `exe` is canonicalized first: the kernel's link is always fully resolved, so
/// comparing it against an unresolved path would silently match nothing — the
/// worst possible failure for a caller that reaps what this finds.
pub fn find_processes_by_exe(exe: &Path) -> Vec<i32> {
    let mut out = Vec::new();
    let Ok(exe) = exe.canonicalize() else {
        return out; // no such binary: nothing can be running it
    };
    let me = std::process::id() as i32;
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return out;
    };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
            continue; // /proc also holds non-pid entries
        };
        if pid == me {
            continue;
        }
        if std::fs::read_link(format!("/proc/{pid}/exe")).is_ok_and(|p| p == *exe) {
            out.push(pid);
        }
    }
    out
}

/// Is the path a FIFO? Used to assert the response channel is a pipe (no
/// decrypted bytes may ever land in a regular file).
pub fn is_fifo(path: &Path) -> bool {
    use std::os::unix::fs::FileTypeExt;
    std::fs::metadata(path)
        .map(|m| m.file_type().is_fifo())
        .unwrap_or(false)
}

/// Make `cmd`'s child safe to exec from a long-lived server: drop fds it has
/// no business holding, and bind its lifetime to ours (both because
/// `oexserverd` gets orphaned and holds whatever it has forever). Rationale,
/// the SIGKILL-not-SIGTERM and per-thread PDEATHSIG subtleties, and the
/// EADDRINUSE bug this fixes: see docs/architecture/oexserverd-child-hygiene.md.
pub fn harden_child(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    let parent = std::process::id() as c_int;
    // SAFETY: pre_exec runs in the child after fork(2), possibly still
    // threaded — only async-signal-safe work is allowed, since a lock held
    // by another thread at fork time is now held forever. This closure is
    // four raw syscalls plus an errno read; no allocation, no locks.
    unsafe {
        cmd.pre_exec(move || {
            if close_range(3, c_uint::MAX, CLOSE_RANGE_CLOEXEC) != 0 {
                return Err(io::Error::last_os_error());
            }
            if prctl(PR_SET_PDEATHSIG, SIGKILL as c_ulong) != 0 {
                return Err(io::Error::last_os_error());
            }
            // closes the fork/prctl race: a reparented child means the
            // parent died before the signal was armed, so refuse to exec
            // rather than run on unsupervised and immortal
            if getppid() != parent {
                _exit(1);
            }
            Ok(())
        });
    }
}

/// Serializes every spawning test in the crate — between `fork` and `exec` a
/// child holds every inheritable fd of the forking thread, so parallel tests
/// race on shared sockets/fds. See docs/architecture/oexserverd-child-hygiene.md.
/// Poison-tolerant: a failing test reports its own assertion, not a cascade.
#[cfg(test)]
pub(super) fn spawn_guard() -> std::sync::MutexGuard<'static, ()> {
    static SPAWN: std::sync::Mutex<()> = std::sync::Mutex::new(());
    SPAWN.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Write};
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    /// Set on the re-executed test binary to select the helper role below.
    const HELPER_ENV: &str = "CHARTCORE_OEX_PDEATHSIG_HELPER";
    /// libtest path of the helper "test".
    const HELPER_TEST: &str = "oex::unix::tests::pdeathsig_helper";

    /// `F_SETFD` — clearing it drops `FD_CLOEXEC`, i.e. what Python's
    /// `socket.set_inheritable(True)` does (uvicorn's reloader does this to
    /// its listening socket).
    const F_SETFD: c_int = 2;

    extern "C" {
        fn fcntl(fd: c_int, cmd: c_int, ...) -> c_int;
    }

    /// What `/proc/<pid>/fd/<n>` points at, e.g. `socket:[610853664]`.
    fn fd_target(pid: &str, fd: &str) -> Option<String> {
        std::fs::read_link(format!("/proc/{pid}/fd/{fd}"))
            .ok()
            .map(|p| p.to_string_lossy().into())
    }

    /// Every `/proc/<pid>/fd` entry above stderr, as (fd, target).
    fn extra_fds(pid: &str) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(format!("/proc/{pid}/fd")).unwrap() {
            let fd = entry.unwrap().file_name().to_string_lossy().into_owned();
            if fd.parse::<i32>().map(|n| n <= 2).unwrap_or(true) {
                continue;
            }
            if let Some(target) = fd_target(pid, &fd) {
                out.push((fd, target));
            }
        }
        out
    }

    /// Regression test for the `oexserverd` port-8000 leak: an inheritable
    /// listening socket must not ride into a spawned child.
    ///
    /// Mirrors the live failure exactly — `fastapi dev`'s reloader clears
    /// `FD_CLOEXEC` on its listener, and `std::process::Command` only rewires
    /// 0/1/2, so every other inheritable fd is exec'd into the child. The
    /// orphaned daemon then pinned :8000 open after the backend died.
    #[test]
    fn spawned_child_does_not_inherit_listening_socket() {
        use std::net::TcpListener;
        use std::os::fd::AsRawFd;

        let _guard = spawn_guard();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        // make it inheritable, as uvicorn's reloader does
        assert_eq!(unsafe { fcntl(listener.as_raw_fd(), F_SETFD, 0) }, 0);
        let socket = fd_target("self", &listener.as_raw_fd().to_string()).unwrap();
        assert!(
            socket.starts_with("socket:["),
            "expected a socket link, got {socket}"
        );

        let mut cmd = Command::new("sleep");
        cmd.arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        harden_child(&mut cmd);
        let mut child = cmd.spawn().unwrap();

        let pid = child.id().to_string();
        let leaked = extra_fds(&pid);
        let _ = child.kill();
        let _ = child.wait();

        assert!(
            !leaked.iter().any(|(_, target)| *target == socket),
            "child inherited the listening socket {socket}: {leaked:?}"
        );

        // NO SOCKET above stderr, rather than NO FD above stderr. The wider
        // form was flaky (jt task uwnotlts, observed twice under a loaded
        // `just check`): this reads /proc/<pid>/fd of a child that has only
        // just exec'd, and for a moment the dynamic loader still holds its
        // own mapping fd — the failures both reported exactly
        // `[("3", "/usr/lib/libc.so.6")]`. Concurrent load widens that
        // window, so parallel work makes it MORE likely, not less.
        //
        // MEASURED, 400 runs of this one test with a full `cargo test --lib`
        // running alongside: the `leaked.is_empty()` form failed 28 times
        // (27 on the loader's libc fd, once on an `LC_COLLATE` locale fd —
        // so it was never only libc), the form below zero times.
        //
        // Sockets are the property the test is actually for, and a
        // /proc/<pid>/fd symlink says which kind an fd is directly
        // (`socket:[...]` versus a file path), so narrowing costs nothing:
        // this still fails on ANY inherited socket, including one this test
        // never opened, which is strictly more than the assert above it
        // checks. A retry/settle loop was the alternative and is worse — it
        // would have to sleep long enough to outlast an arbitrary loader,
        // and a sleep tuned to hide a transient also hides a real leak that
        // is closed slightly later.
        let sockets: Vec<_> = leaked
            .iter()
            .filter(|(_, target)| target.starts_with("socket:["))
            .collect();
        assert!(
            sockets.is_empty(),
            "child holds inherited socket(s) above stderr: {sockets:?} (all: {leaked:?})"
        );
    }

    /// The user-visible symptom, end to end: after the socket's owner drops it,
    /// the port must be free even though a child it spawned is still alive.
    /// This is the EADDRINUSE that greeted the next `just dev` — an orphaned
    /// `oexserverd` kept :8000 bound long after the backend exited.
    #[test]
    fn child_outliving_socket_owner_does_not_pin_the_port() {
        use std::net::TcpListener;
        use std::os::fd::AsRawFd;

        let _guard = spawn_guard();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_eq!(unsafe { fcntl(listener.as_raw_fd(), F_SETFD, 0) }, 0);

        let mut cmd = Command::new("sleep");
        cmd.arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        harden_child(&mut cmd);
        let mut child = cmd.spawn().unwrap();

        drop(listener); // the "backend" dies; the child lives on
        let rebound = TcpListener::bind(("127.0.0.1", port));
        let _ = child.kill();
        let _ = child.wait();

        rebound.unwrap_or_else(|e| panic!("child still pins port {port}: {e}"));
    }

    /// Both spawn sites pipe and read the child's stdout; the fd range starts
    /// at 3 precisely so std's dup2 onto 0/1/2 survives it.
    #[test]
    fn piped_stdout_still_readable() {
        let _guard = spawn_guard();
        let mut cmd = Command::new("echo");
        cmd.arg("hello")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        harden_child(&mut cmd);
        let out = cmd.spawn().unwrap().wait_with_output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hello");
    }

    /// Guards the `CLOSE_RANGE_CLOEXEC`-over-plain-close choice: std reports
    /// exec failure to the parent over a CLOEXEC pipe on an fd above stderr.
    /// Closing the range outright would eat it and turn a `spawn()` error into
    /// a child that silently exits 1.
    #[test]
    fn failed_exec_still_reports_as_spawn_error() {
        let _guard = spawn_guard();
        let mut cmd = Command::new("/nonexistent/chartcore-oex-does-not-exist");
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        harden_child(&mut cmd);
        let err = cmd
            .spawn()
            .expect_err("spawn of a missing binary must fail");
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    /// A hardened `sleep`, configured exactly like the real daemon spawn:
    /// piped-away stdio and **its own process group**, which is what makes a
    /// terminal SIGINT miss it.
    fn spawn_hardened_sleep() -> std::process::Child {
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new("sleep");
        cmd.arg("300")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        harden_child(&mut cmd);
        cmd.spawn().unwrap()
    }

    /// `/proc/<pid>/stat` state letter, or `None` if the pid is gone.
    fn proc_state(pid: i32) -> Option<char> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // comm is parenthesized and may contain spaces: state follows ") "
        stat.rsplit_once(") ")
            .and_then(|(_, rest)| rest.chars().next())
    }

    /// Gone, or a zombie awaiting a reaper: either way it is not running.
    fn process_dead(pid: i32) -> bool {
        matches!(proc_state(pid), None | Some('Z'))
    }

    fn wait_until_dead(pid: i32, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if process_dead(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        process_dead(pid)
    }

    /// Not a real test — the child half of `child_dies_when_parent_is_killed`,
    /// reached only when the test binary is re-executed with [`HELPER_ENV`]
    /// set. Under a normal `cargo test` it returns immediately.
    ///
    /// It stands in for the backend: spawn the daemon from a dedicated,
    /// long-lived thread (as `supervisor_loop` does), report its pid, then
    /// block forever. It never runs a graceful stop — the parent test kills it
    /// outright.
    #[test]
    fn pdeathsig_helper() {
        if std::env::var(HELPER_ENV).is_err() {
            return;
        }
        // never waited on, deliberately: this process is about to be killed
        // outright, which is the whole point of the scenario
        #[allow(clippy::zombie_processes)]
        std::thread::spawn(|| {
            let child = spawn_hardened_sleep();
            println!("PID={}", child.id());
            std::io::stdout().flush().unwrap();
            std::thread::sleep(Duration::from_secs(300));
        })
        .join()
        .unwrap();
    }

    /// Regression test for the leaked-`oexserverd` P0: a daemon must not
    /// survive the death of the process that spawned it.
    ///
    /// Reproduces the live failure. `start_daemon` puts the daemon in its own
    /// process group so that a graceful `stop` can signal its descendants —
    /// but that also means a terminal SIGINT (Ctrl-C on `just dev`), which the
    /// tty delivers to the *backend's* group, never reaches the daemon. Any
    /// exit that skips the graceful stop path therefore stranded a daemon;
    /// they accumulated, contended on the one shared request FIFO, and wedged
    /// the next backend.
    ///
    /// SIGKILL to the parent is the strongest form of that exit — no atexit
    /// handler, no Drop, no supervisor code runs at all. Nothing the parent
    /// could do on its way out can pass this test; only the kernel binding the
    /// child's lifetime to the parent's can.
    #[test]
    fn child_dies_when_parent_is_killed() {
        let _guard = spawn_guard();
        let mut helper = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", HELPER_TEST, "--nocapture"])
            .env(HELPER_ENV, "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        // read the grandchild's pid off the helper's stdout
        let mut lines = io::BufReader::new(helper.stdout.take().unwrap()).lines();
        let grandchild: i32 = loop {
            let line = lines
                .next()
                .expect("helper exited without reporting a pid")
                .unwrap();
            if let Some(pid) = line.strip_prefix("PID=") {
                break pid.trim().parse().unwrap();
            }
        };
        assert!(
            !process_dead(grandchild),
            "grandchild {grandchild} never started"
        );

        // the backend dies hard: no graceful stop, no unwinding
        send_signal(helper.id() as i32, SIGKILL).unwrap();
        helper.wait().unwrap();

        let died = wait_until_dead(grandchild, Duration::from_secs(5));
        if !died {
            // never leave one of ours behind, even when the assertion fails
            let _ = send_signal(grandchild, SIGKILL);
        }
        assert!(
            died,
            "daemon {grandchild} survived the death of the process that spawned it"
        );
    }

    /// The other half of the parent-death contract, and the reason
    /// `start_daemon` may only ever be called from the supervisor thread.
    ///
    /// `PR_SET_PDEATHSIG` fires when the parent **thread** that forked the
    /// child exits — not when the parent process does. Our embedder is
    /// threaded (uvicorn/Python), so a spawn from a short-lived worker thread
    /// would kill the daemon the moment that thread finished. It is safe here
    /// only because the fork happens on `oex-supervisor`, a dedicated thread
    /// that lives exactly as long as the `OexControl` that owns the daemon.
    ///
    /// This test pins that semantic down so a future refactor that moves the
    /// spawn onto a transient thread fails loudly here instead of silently
    /// killing the daemon in production.
    #[test]
    fn child_dies_when_spawning_thread_exits() {
        let _guard = spawn_guard();
        // Child is Send: hand it back so we stay the reaper and never leak a
        // zombie out of this test.
        let mut child = std::thread::spawn(spawn_hardened_sleep).join().unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            match child.try_wait().unwrap() {
                Some(s) => break Some(s),
                None if Instant::now() >= deadline => break None,
                None => std::thread::sleep(Duration::from_millis(20)),
            }
        };
        let Some(status) = status else {
            let _ = child.kill();
            let _ = child.wait();
            panic!("child outlived the thread that spawned it");
        };
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(
            status.signal(),
            Some(SIGKILL),
            "expected the parent-death signal"
        );
    }

    #[test]
    fn fifo_create_and_probe() {
        let dir = std::env::temp_dir().join(format!("chartcore-unix-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("f");
        assert!(make_fifo(&p, 0o600).unwrap());
        assert!(is_fifo(&p));
        assert!(!make_fifo(&p, 0o600).unwrap()); // second create: existed
        let regular = dir.join("r");
        std::fs::write(&regular, b"x").unwrap();
        assert!(!is_fifo(&regular));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn signal_probe() {
        // our own pid is alive; pid max+1-ish is not ours to signal
        assert!(process_alive(std::process::id() as i32));
    }
}
