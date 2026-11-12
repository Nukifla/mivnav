// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only
//
// Ported from ochartsng's OexControl (provider/src/OexControl.cpp,
// provider/include/OexControl.h; GPLv2, Andreas Vogel), with the raw-FIFO
// transport of the upstream o-charts plugin (o-charts_pi src/Osenc.cpp).

//! `oexserverd` client: the interface to the closed-source o-charts
//! decryption daemon. Sends a fixed 1025-byte [`OexMessage`] naming a chart
//! file and its license key, reads back a plaintext OSENC record stream
//! (decoded by [`crate::osenc`]).
//!
//! Implements **raw FIFO mode** (stock daemon reads `/tmp/OCPN_PIPEX`,
//! writes each response to the pipe named in `fifo_name`) rather than
//! ochartsng's `LD_PRELOAD` shim onto abstract unix sockets. Requests are
//! serialized one at a time. The response pipe is created by this client
//! (mode 0600) so decrypted bytes never touch a regular file on disk —
//! [`FifoTransport`] verifies the response path is a FIFO before every
//! request.
//!
//! [`OexControl`] supervises the daemon: `Unknown -> Starting -> Running ->
//! Error`, pinging every 2s once running; a dead daemon moves to `Error`
//! with no automatic restart (call [`OexControl::restart`]).
//!
//! `/tmp/OCPN_PIPEX` is a system-wide resource: running mivnav next to
//! OpenCPN's o-charts plugin or AvNav on the same machine collides.

pub mod download;
pub mod fpr;
mod unix;

use std::collections::VecDeque;
use std::fmt;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub use download::{ensure_daemon, DownloadError, OCHARTS_PI_TAG};
pub use fpr::{get_fingerprint, Fingerprint};

/// Size of the wire message: `u8 cmd` + `char fifo_name[256]` +
/// `char senc_name[256]` + `char senc_key[512]`, packed, no padding
/// (`OexControl.h:100-105`; `REQUEST_SIZE` in the preload shim).
pub const MESSAGE_SIZE: usize = 1025;

/// The well-known request FIFO the stock daemon reads from.
pub const DEFAULT_REQUEST_PIPE: &str = "/tmp/OCPN_PIPEX";

/// Daemon commands (`OexControl.h:51-62`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum OexCommand {
    /// Full `.oesenc` stream.
    ReadEsenc = 0,
    /// Ping; the daemon answers with the 2 bytes `"OK"`.
    TestAvail = 1,
    Exit = 2,
    /// Header-only `.oesenc` stream.
    ReadEsencHdr = 3,
    OpenRnc = 4,
    OpenRncFull = 5,
    GetHk = 6,
    /// Full `.oesu` stream.
    ReadOesu = 8,
    /// Header-only `.oesu` stream.
    ReadOesuHdr = 9,
}

/// Errors from talking to the daemon.
#[derive(Debug)]
pub enum OexError {
    Io(io::Error),
    /// A field exceeded its fixed wire size.
    FieldTooLong(&'static str),
    /// The daemon did not answer within the deadline.
    Timeout(String),
    /// `send_command` while the daemon is not in the `Running` state.
    NotRunning,
    /// Unexpected daemon behavior (bad ping reply, non-FIFO response path).
    Protocol(String),
}

impl fmt::Display for OexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OexError::Io(e) => write!(f, "I/O error: {e}"),
            OexError::FieldTooLong(what) => write!(f, "{what} too long for the wire format"),
            OexError::Timeout(m) => write!(f, "oexserverd timeout: {m}"),
            OexError::NotRunning => write!(f, "oexserverd is not running"),
            OexError::Protocol(m) => write!(f, "oexserverd protocol error: {m}"),
        }
    }
}

impl std::error::Error for OexError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            OexError::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<io::Error> for OexError {
    fn from(e: io::Error) -> Self {
        OexError::Io(e)
    }
}

/// One request message. Encodes to the packed little-endian 1025-byte wire
/// format; all string fields are NUL-terminated within their fixed slots.
#[derive(Debug, Clone)]
pub struct OexMessage<'a> {
    pub cmd: u8,
    /// Response pipe path. Zeroed in shim mode; a real named-pipe path in
    /// raw FIFO mode.
    pub fifo_name: &'a str,
    /// Chart file path.
    pub senc_name: &'a str,
    /// License key (`RInstallKey`/`UserKey`).
    pub senc_key: &'a str,
}

impl OexMessage<'_> {
    pub fn encode(&self) -> Result<[u8; MESSAGE_SIZE], OexError> {
        let mut buf = [0u8; MESSAGE_SIZE];
        buf[0] = self.cmd;
        put_field(&mut buf[1..257], self.fifo_name, "fifo name")?;
        put_field(&mut buf[257..513], self.senc_name, "chart file name")?;
        put_field(&mut buf[513..1025], self.senc_key, "chart key")?;
        Ok(buf)
    }
}

fn put_field(slot: &mut [u8], value: &str, what: &'static str) -> Result<(), OexError> {
    let bytes = value.as_bytes();
    // must leave room for the NUL terminator (reference enforces the same)
    if bytes.len() >= slot.len() {
        return Err(OexError::FieldTooLong(what));
    }
    slot[..bytes.len()].copy_from_slice(bytes);
    Ok(())
}

/// The read end of the per-request named pipe. `deadline` bounds the *whole*
/// response, not each `read()` call — see
/// docs/architecture/oexserverd-response-stream.md. Unlinked on drop.
pub struct OexStream {
    file: File,
    path: PathBuf,
    deadline: Instant,
    seen_writer: bool,
    /// In-flight marker of the owning transport (supervisor pings pause
    /// while a request is streaming — raw FIFO mode is serialized).
    active: Option<Arc<AtomicU64>>,
}

impl Read for OexStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            match self.file.read(buf) {
                Ok(0) if self.seen_writer => return Ok(0), // real EOF
                Ok(0) => {}                                // no writer yet: wait below
                Ok(n) => {
                    self.seen_writer = true;
                    return Ok(n);
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    // a writer is connected but has no data ready
                    self.seen_writer = true;
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
            if Instant::now() >= self.deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "timeout waiting for oexserverd response data",
                ));
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

impl Drop for OexStream {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        if let Some(active) = &self.active {
            active.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

/// Raw-FIFO request/response transport (no daemon lifecycle).
///
/// Public separately from [`OexControl`] so protocol tests can run against
/// a mock daemon on a private request pipe.
pub struct FifoTransport {
    request_pipe: PathBuf,
    work_dir: PathBuf,
    counter: AtomicU64,
    /// Number of response streams currently alive.
    active: Arc<AtomicU64>,
}

impl FifoTransport {
    /// `request_pipe` is the daemon's request FIFO ([`DEFAULT_REQUEST_PIPE`]
    /// for the stock daemon); `work_dir` (created, mode 0700) receives the
    /// per-request response pipes.
    pub fn new(request_pipe: PathBuf, work_dir: PathBuf) -> io::Result<FifoTransport> {
        std::fs::create_dir_all(&work_dir)?;
        let mut perms = std::fs::metadata(&work_dir)?.permissions();
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o700);
        std::fs::set_permissions(&work_dir, perms)?;
        Ok(FifoTransport {
            request_pipe,
            work_dir,
            counter: AtomicU64::new(0),
            active: Arc::new(AtomicU64::new(0)),
        })
    }

    /// Are response streams currently alive? Health pings pause then.
    pub fn busy(&self) -> bool {
        self.active.load(Ordering::Relaxed) > 0
    }

    /// Send one command and return the response stream. `timeout` bounds
    /// connecting/writing to the request pipe, and separately bounds the
    /// whole response read (from stream creation, not reset per `read()`
    /// call).
    pub fn transact(
        &self,
        cmd: u8,
        senc_name: &str,
        senc_key: &str,
        timeout: Duration,
    ) -> Result<OexStream, OexError> {
        // unique response pipe per request
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        let resp_path = self
            .work_dir
            .join(format!("resp-{}-{n}", std::process::id()));
        let _ = std::fs::remove_file(&resp_path);
        unix::make_fifo(&resp_path, 0o600)?;
        // the memory-only guarantee: the daemon must write into a pipe,
        // never a regular file
        if !unix::is_fifo(&resp_path) {
            let _ = std::fs::remove_file(&resp_path);
            return Err(OexError::Protocol(format!(
                "response path {} is not a FIFO",
                resp_path.display()
            )));
        }
        let msg = OexMessage {
            cmd,
            fifo_name: resp_path
                .to_str()
                .ok_or(OexError::FieldTooLong("fifo name"))?,
            senc_name,
            senc_key,
        }
        .encode();
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                let _ = std::fs::remove_file(&resp_path);
                return Err(e);
            }
        };
        // open our read end first (nonblocking, so it doesn't wait for the
        // daemon), then deliver the request
        let result = (|| -> Result<OexStream, OexError> {
            let file = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(unix::O_NONBLOCK)
                .open(&resp_path)?;
            self.write_request(&msg, timeout)?;
            self.active.fetch_add(1, Ordering::Relaxed);
            Ok(OexStream {
                file,
                path: resp_path.clone(),
                deadline: Instant::now() + timeout,
                seen_writer: false,
                active: Some(Arc::clone(&self.active)),
            })
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&resp_path);
        }
        result
    }

    /// Open the request pipe for writing and push the message. Nonblocking
    /// open fails with ENXIO until the daemon has the read end open (and
    /// ENOENT before it created the pipe) — retried until the deadline,
    /// exactly like the upstream plugin's retry loop.
    fn write_request(&self, msg: &[u8; MESSAGE_SIZE], timeout: Duration) -> Result<(), OexError> {
        let deadline = Instant::now() + timeout;
        let mut pipe = loop {
            match std::fs::OpenOptions::new()
                .write(true)
                .custom_flags(unix::O_NONBLOCK)
                .open(&self.request_pipe)
            {
                Ok(f) => break f,
                Err(e)
                    if matches!(e.kind(), io::ErrorKind::NotFound)
                        || e.raw_os_error() == Some(6 /* ENXIO */) =>
                {
                    if Instant::now() >= deadline {
                        return Err(OexError::Timeout(format!(
                            "no reader on request pipe {}",
                            self.request_pipe.display()
                        )));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => return Err(e.into()),
            }
        };
        // 1025 bytes < PIPE_BUF: the write is atomic once accepted
        let mut written = 0;
        while written < msg.len() {
            match pipe.write(&msg[written..]) {
                Ok(n) => written += n,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(OexError::Timeout("request pipe stayed full".into()));
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }
}

/// Daemon lifecycle states (`OexControl.h:45-50`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OexState {
    Unknown,
    Starting,
    Running,
    Error,
}

/// Configuration for the daemon controller.
#[derive(Debug, Clone)]
pub struct OexConfig {
    /// Path to the `oexserverd` executable (see [`ensure_daemon`]). Its
    /// parent directory becomes `LD_LIBRARY_PATH` (dongle libraries).
    pub daemon: PathBuf,
    /// Request FIFO; the stock daemon only knows [`DEFAULT_REQUEST_PIPE`].
    pub request_pipe: PathBuf,
    /// Directory for per-request response pipes.
    pub work_dir: PathBuf,
    /// Pass `-d` to the daemon and keep more log lines.
    pub debug: bool,
    /// How long a start may take until the daemon answers pings (ref: 10 s).
    pub start_timeout: Duration,
    /// SIGTERM grace before SIGKILL on stop (ref: 10 s).
    pub stop_timeout: Duration,
    /// Timeout for one request round-trip / response read.
    pub request_timeout: Duration,
}

impl OexConfig {
    pub fn new(daemon: PathBuf, work_dir: PathBuf) -> OexConfig {
        OexConfig {
            daemon,
            request_pipe: PathBuf::from(DEFAULT_REQUEST_PIPE),
            work_dir,
            debug: false,
            start_timeout: Duration::from_secs(10),
            stop_timeout: Duration::from_secs(10),
            request_timeout: Duration::from_secs(10),
        }
    }
}

const MAX_LOG_LINES: usize = 100;

struct StateData {
    state: OexState,
    requested: OexState,
    error: Option<String>,
    shutdown: bool,
    log: VecDeque<String>,
}

struct Shared {
    config: OexConfig,
    transport: FifoTransport,
    state: Mutex<StateData>,
    cond: Condvar,
}

impl Shared {
    fn set_state(&self, state: OexState, error: Option<String>) {
        let mut s = self.state.lock().unwrap();
        s.state = state;
        s.error = error;
        self.cond.notify_all();
    }

    fn add_log(&self, line: String) {
        let mut s = self.state.lock().unwrap();
        if s.log.len() >= MAX_LOG_LINES {
            s.log.pop_front();
        }
        s.log.push_back(line);
    }

    fn ping(&self, timeout: Duration) -> bool {
        let Ok(mut stream) = self
            .transport
            .transact(OexCommand::TestAvail as u8, "", "", timeout)
        else {
            return false;
        };
        let mut buf = [0u8; 2];
        match stream.read_exact(&mut buf) {
            Ok(()) => &buf == b"OK",
            Err(_) => false,
        }
    }
}

/// Supervised `oexserverd` instance. See module docs.
pub struct OexControl {
    shared: Arc<Shared>,
    supervisor: Option<std::thread::JoinHandle<()>>,
}

impl OexControl {
    /// Create the controller (supervisor thread starts idle; call
    /// [`start`](Self::start)).
    pub fn new(config: OexConfig) -> io::Result<OexControl> {
        let transport = FifoTransport::new(config.request_pipe.clone(), config.work_dir.clone())?;
        let shared = Arc::new(Shared {
            config,
            transport,
            state: Mutex::new(StateData {
                state: OexState::Unknown,
                requested: OexState::Unknown,
                error: None,
                shutdown: false,
                log: VecDeque::new(),
            }),
            cond: Condvar::new(),
        });
        let sup_shared = Arc::clone(&shared);
        let supervisor = std::thread::Builder::new()
            .name("oex-supervisor".into())
            .spawn(move || supervisor_loop(sup_shared))?;
        Ok(OexControl {
            shared,
            supervisor: Some(supervisor),
        })
    }

    fn request(&self, state: OexState) {
        let mut s = self.shared.state.lock().unwrap();
        s.requested = state;
        self.shared.cond.notify_all();
    }

    /// Request daemon start (asynchronous; use [`wait_for_state`](Self::wait_for_state)).
    pub fn start(&self) {
        self.request(OexState::Running);
    }

    /// Request daemon stop.
    pub fn stop(&self) {
        self.request(OexState::Unknown);
    }

    /// Stop, then start again (the only recovery from `Error`).
    pub fn restart(&self) {
        self.stop();
        self.wait_for_state(OexState::Unknown, Duration::from_secs(15));
        self.start();
    }

    pub fn state(&self) -> OexState {
        self.shared.state.lock().unwrap().state
    }

    pub fn last_error(&self) -> Option<String> {
        self.shared.state.lock().unwrap().error.clone()
    }

    /// Captured daemon stdout/stderr (bounded).
    pub fn log(&self) -> Vec<String> {
        self.shared
            .state
            .lock()
            .unwrap()
            .log
            .iter()
            .cloned()
            .collect()
    }

    /// Block until the state equals `state`; false on timeout.
    pub fn wait_for_state(&self, state: OexState, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut s = self.shared.state.lock().unwrap();
        while s.state != state {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return false;
            };
            let (guard, _) = self.shared.cond.wait_timeout(s, remaining).unwrap();
            s = guard;
        }
        true
    }

    /// Send a chart command and return the decrypted response stream.
    /// Requires the `Running` state.
    pub fn send_command(
        &self,
        cmd: OexCommand,
        senc_name: &str,
        senc_key: &str,
    ) -> Result<OexStream, OexError> {
        if self.state() != OexState::Running {
            return Err(OexError::NotRunning);
        }
        self.shared.transport.transact(
            cmd as u8,
            senc_name,
            senc_key,
            self.shared.config.request_timeout,
        )
    }
}

impl Drop for OexControl {
    fn drop(&mut self) {
        {
            let mut s = self.shared.state.lock().unwrap();
            s.shutdown = true;
            self.shared.cond.notify_all();
        }
        if let Some(h) = self.supervisor.take() {
            let _ = h.join();
        }
    }
}

/// Poll interval per state, like the reference's supervisor wait times.
fn poll_interval(state: OexState) -> Duration {
    match state {
        OexState::Unknown | OexState::Starting => Duration::from_millis(100),
        OexState::Running => Duration::from_millis(500),
        OexState::Error => Duration::from_millis(2000),
    }
}

fn supervisor_loop(shared: Arc<Shared>) {
    let mut child: Option<Child> = None;
    let mut last_ping = Instant::now();
    loop {
        // wait for a request/shutdown or the poll tick
        let (state, requested, shutdown) = {
            let s = shared.state.lock().unwrap();
            let interval = poll_interval(s.state);
            let s = shared.cond.wait_timeout(s, interval).unwrap().0;
            (s.state, s.requested, s.shutdown)
        };
        if shutdown {
            if let Some(c) = child.take() {
                stop_daemon(&shared, c);
            }
            shared.set_state(OexState::Unknown, None);
            return;
        }
        if requested != state {
            match requested {
                OexState::Running => {
                    if let Some(c) = child.take() {
                        stop_daemon(&shared, c);
                    }
                    match start_daemon(&shared) {
                        Ok(c) => {
                            child = Some(c);
                            last_ping = Instant::now();
                        }
                        Err(e) => shared.set_state(OexState::Error, Some(e)),
                    }
                }
                _ => {
                    if let Some(c) = child.take() {
                        stop_daemon(&shared, c);
                    }
                    shared.set_state(requested, None);
                }
            }
        }
        // health check while running
        if shared.state.lock().unwrap().state == OexState::Running {
            if let Some(c) = child.as_mut() {
                let direct_alive = matches!(c.try_wait(), Ok(None)); // also reaps
                if last_ping.elapsed() >= Duration::from_secs(2) {
                    last_ping = Instant::now();
                    // some daemon builds fork; the group can outlive our
                    // direct child
                    let alive = direct_alive || unix::process_alive(-(c.id() as i32));
                    // don't ping while a chart stream is in flight — the
                    // raw-FIFO daemon is serialized and a busy daemon
                    // failing a ping is not an error
                    let healthy =
                        alive && (shared.transport.busy() || shared.ping(Duration::from_secs(1)));
                    if !healthy {
                        shared.set_state(
                            OexState::Error,
                            Some("oexserverd stopped answering".into()),
                        );
                    }
                }
            }
        }
    }
}

/// Is this pid the `-g` fingerprint one-shot rather than a daemon? It never
/// touches the request FIFO, so it must be spared by [`reap_stale_daemons`].
fn is_fpr_oneshot(pid: i32) -> bool {
    std::fs::read(format!("/proc/{pid}/cmdline"))
        .map(|c| c.split(|&b| b == 0).any(|arg| arg == b"-g"))
        .unwrap_or(false)
}

/// Kill every `oexserverd` left over from an earlier run, before starting
/// ours: the daemon reads one system-wide FIFO, so two silently steal each
/// other's requests. See docs/architecture/oexserverd-stale-daemon-reaping.md.
fn reap_stale_daemons(exe: &Path) -> Vec<i32> {
    let mut stale: Vec<i32> = unix::find_processes_by_exe(exe)
        .into_iter()
        .filter(|&pid| !is_fpr_oneshot(pid))
        .collect();
    if stale.is_empty() {
        return stale;
    }
    let reaped = stale.clone();
    for &pid in &stale {
        let _ = unix::send_signal(-pid, unix::SIGTERM);
        let _ = unix::send_signal(pid, unix::SIGTERM);
    }
    // re-scanning by exe doubles as the liveness check: a zombie has no exe
    // link, so an exited-but-unreaped orphan drops out on its own
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        let alive = unix::find_processes_by_exe(exe);
        stale.retain(|pid| alive.contains(pid));
        if stale.is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    for &pid in &stale {
        let _ = unix::send_signal(-pid, unix::SIGKILL);
        let _ = unix::send_signal(pid, unix::SIGKILL);
    }
    reaped
}

/// Fork/exec the daemon and ping until it answers. Returns the child or an
/// error string for the `Error` state.
fn start_daemon(shared: &Arc<Shared>) -> Result<Child, String> {
    let config = &shared.config;
    if !config.daemon.exists() {
        return Err(format!(
            "oexserverd not found at {}",
            config.daemon.display()
        ));
    }
    // Never add a second daemon to the shared FIFO. `unix::harden_child`'s
    // PDEATHSIG should mean there is nothing here to find, but it binds only
    // our direct child — a daemon that forked, or one stranded by an older
    // build, still has to be cleared by somebody.
    let reaped = reap_stale_daemons(&config.daemon);
    if !reaped.is_empty() {
        shared.add_log(format!(
            "reaped {} stale oexserverd process(es) before start: {reaped:?}",
            reaped.len()
        ));
    }
    // the stock daemon opens the request FIFO itself; pre-creating it is
    // harmless and covers daemon builds that expect it to exist
    if let Err(e) = unix::make_fifo(&config.request_pipe, 0o666) {
        return Err(format!("cannot create request pipe: {e}"));
    }
    let lib_dir = config
        .daemon
        .parent()
        .unwrap_or(Path::new("."))
        .to_path_buf();
    let mut cmd = Command::new(&config.daemon);
    if config.debug {
        cmd.arg("-d");
    }
    use std::os::unix::process::CommandExt;
    cmd.env("LD_LIBRARY_PATH", &lib_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0); // own group: stop kills descendants too

    // fd hygiene (an inherited :8000 listener EADDRINUSE'd the next dev start)
    // and, critically, the parent-death binding that stops the daemon
    // outliving us when we die without running `stop_daemon`
    unix::harden_child(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("unable to exec oexserverd: {e}"))?;
    for (stream, tag) in [
        (child.stdout.take().map(box_read), "out"),
        (child.stderr.take().map(box_read), "err"),
    ] {
        if let Some(stream) = stream {
            spawn_log_reader(shared, stream, tag, child.id());
        }
    }
    shared.set_state(OexState::Starting, None);
    let deadline = Instant::now() + config.start_timeout;
    loop {
        if shared.ping(Duration::from_secs(3)) {
            shared.set_state(OexState::Running, None);
            return Ok(child);
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("oexserverd exited during start: {status}"));
        }
        if Instant::now() >= deadline {
            stop_daemon(shared, child);
            return Err("unable to connect to oexserverd after start".into());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

fn box_read(r: impl Read + Send + 'static) -> Box<dyn Read + Send> {
    Box::new(r)
}

fn spawn_log_reader(
    shared: &Arc<Shared>,
    stream: Box<dyn Read + Send>,
    tag: &'static str,
    pid: u32,
) {
    let shared = Arc::clone(shared);
    let _ = std::thread::Builder::new()
        .name(format!("oex-log-{tag}"))
        .spawn(move || {
            let mut reader = io::BufReader::new(stream);
            let mut line = String::new();
            use io::BufRead;
            while let Ok(n) = reader.read_line(&mut line) {
                if n == 0 {
                    break;
                }
                shared.add_log(format!("OEXSERVERD[{pid}]/{tag}: {}", line.trim_end()));
                line.clear();
            }
        });
}

/// SIGTERM to the process group, grace period, then SIGKILL.
fn stop_daemon(shared: &Shared, mut child: Child) {
    let pid = child.id() as i32;
    let _ = unix::send_signal(-pid, unix::SIGTERM);
    let _ = unix::send_signal(pid, unix::SIGTERM);
    if !wait_exit(&mut child, shared.config.stop_timeout) {
        let _ = unix::send_signal(-pid, unix::SIGKILL);
        let _ = unix::send_signal(pid, unix::SIGKILL);
        wait_exit(&mut child, Duration::from_secs(2));
    }
}

fn wait_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {}
            Err(_) => return true,
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Chart file kinds and their daemon dispatch (`ChartFactory.cpp:31-45`,
/// `OESUChart.h:86-141`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChartKind {
    /// Encrypted `.oesu` — current o-charts format.
    Oesu,
    /// Encrypted `.oesenc` — legacy o-charts format.
    Oesenc,
    /// Plain unencrypted `.senc`/`.osenc` — read directly, no daemon.
    Senc,
}

impl ChartKind {
    pub fn from_path(path: &Path) -> Option<ChartKind> {
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "oesu" => Some(ChartKind::Oesu),
            "oesenc" => Some(ChartKind::Oesenc),
            "senc" | "osenc" => Some(ChartKind::Senc),
            _ => None,
        }
    }

    /// The daemon command for opening this chart; `None` means "read the
    /// file directly" (the reference's `CMD_UNKNOWN` sentinel).
    pub fn command(&self, header_only: bool) -> Option<OexCommand> {
        match (self, header_only) {
            (ChartKind::Oesu, false) => Some(OexCommand::ReadOesu),
            (ChartKind::Oesu, true) => Some(OexCommand::ReadOesuHdr),
            (ChartKind::Oesenc, false) => Some(OexCommand::ReadEsenc),
            (ChartKind::Oesenc, true) => Some(OexCommand::ReadEsencHdr),
            (ChartKind::Senc, _) => None,
        }
    }
}

/// Open a chart file as an OSENC byte stream: plain files are read
/// directly (the fully-testable-today path); encrypted ones go through the
/// daemon with their license key. This is the analog of
/// `ChartFactory::OpenChartStream`.
pub fn open_chart_stream(
    control: Option<&OexControl>,
    path: &Path,
    key: &str,
    header_only: bool,
) -> Result<Box<dyn Read + Send>, OexError> {
    let kind = ChartKind::from_path(path).ok_or_else(|| {
        OexError::Protocol(format!("unknown chart file type: {}", path.display()))
    })?;
    match kind.command(header_only) {
        None => Ok(Box::new(File::open(path)?)),
        Some(cmd) => {
            let control = control.ok_or(OexError::NotRunning)?;
            let name = path
                .to_str()
                .ok_or(OexError::FieldTooLong("chart file name"))?;
            Ok(Box::new(control.send_command(cmd, name, key)?))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_layout_is_1025_bytes_packed() {
        let msg = OexMessage {
            cmd: 8,
            fifo_name: "/tmp/resp",
            senc_name: "/charts/DE521900.oesu",
            senc_key: "abcdef0123456789",
        };
        let buf = msg.encode().unwrap();
        assert_eq!(buf.len(), MESSAGE_SIZE);
        assert_eq!(buf[0], 8);
        // field offsets per the packed struct: 1, 257, 513
        assert_eq!(&buf[1..10], b"/tmp/resp");
        assert_eq!(buf[10], 0);
        assert_eq!(&buf[257..279], b"/charts/DE521900.oesu\0");
        assert_eq!(&buf[513..530], b"abcdef0123456789\0");
        // everything else is zero
        assert!(buf[279..513].iter().all(|&b| b == 0));
        assert!(buf[530..].iter().all(|&b| b == 0));
    }

    #[test]
    fn message_field_limits() {
        let long = "x".repeat(256);
        let msg = OexMessage {
            cmd: 0,
            fifo_name: "",
            senc_name: &long,
            senc_key: "",
        };
        assert!(matches!(msg.encode(), Err(OexError::FieldTooLong(_))));
        // 255 chars still fit (256th byte is the NUL)
        let ok = "x".repeat(255);
        let msg = OexMessage {
            cmd: 0,
            fifo_name: "",
            senc_name: &ok,
            senc_key: "",
        };
        assert!(msg.encode().is_ok());
        let long_key = "k".repeat(512);
        let msg = OexMessage {
            cmd: 0,
            fifo_name: "",
            senc_name: "",
            senc_key: &long_key,
        };
        assert!(matches!(msg.encode(), Err(OexError::FieldTooLong(_))));
    }

    /// A stand-in for the vendor binary: a copy of `sort`, which blocks
    /// forever on a stdin that never closes and — unlike `sleep` — accepts a
    /// `-g` flag, so it can impersonate the fpr one-shot too. Copied so that
    /// `/proc/<pid>/exe` points at *our* path and nothing else on the machine
    /// can match it.
    fn fake_daemon_binary(dir: &Path) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let exe = dir.join("oexserverd");
        std::fs::copy("/usr/bin/sort", &exe).unwrap();
        exe
    }

    fn spawn_fake_daemon(exe: &Path, args: &[&str]) -> Child {
        Command::new(exe)
            .args(args)
            .stdin(Stdio::piped()) // held open by the Child: it blocks reading
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    /// The invariant that makes the observed six-daemons-on-one-FIFO state
    /// unreachable: a start clears whatever is already running from our binary
    /// instead of adding to it — while sparing a concurrent `-g` fpr one-shot,
    /// which execs the same binary but is not a daemon and holds no FIFO.
    #[test]
    fn start_reaps_stale_daemons_but_spares_the_fpr_oneshot() {
        let _guard = unix::spawn_guard();
        let dir = std::env::temp_dir().join(format!("chartcore-reap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let exe = fake_daemon_binary(&dir);

        let mut stale: Vec<Child> = (0..3).map(|_| spawn_fake_daemon(&exe, &[])).collect();
        let mut oneshot = spawn_fake_daemon(&exe, &["-g"]);
        let stale_pids: Vec<i32> = stale.iter().map(|c| c.id() as i32).collect();
        let oneshot_pid = oneshot.id() as i32;

        let reaped = reap_stale_daemons(&exe);

        assert_eq!(
            reaped.len(),
            3,
            "expected the three daemons, got {reaped:?}"
        );
        for pid in &stale_pids {
            assert!(
                reaped.contains(pid),
                "daemon {pid} was left running: {reaped:?}"
            );
        }
        assert!(
            !reaped.contains(&oneshot_pid),
            "reaped the fpr one-shot {oneshot_pid}"
        );
        // only the one-shot is left holding our exe
        assert_eq!(unix::find_processes_by_exe(&exe), vec![oneshot_pid]);

        for c in stale.iter_mut() {
            let _ = c.wait();
        }
        let _ = oneshot.kill();
        let _ = oneshot.wait();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Nothing to reap must stay cheap and silent — no signals to strangers.
    #[test]
    fn reap_is_a_noop_when_no_daemon_is_running() {
        let _guard = unix::spawn_guard();
        let dir = std::env::temp_dir().join(format!("chartcore-reap-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let exe = fake_daemon_binary(&dir);
        assert!(reap_stale_daemons(&exe).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn chart_kind_dispatch() {
        let k = ChartKind::from_path(Path::new("/a/DE5.oesu")).unwrap();
        assert_eq!(k.command(false), Some(OexCommand::ReadOesu));
        assert_eq!(k.command(true), Some(OexCommand::ReadOesuHdr));
        let k = ChartKind::from_path(Path::new("/a/DE5.OESENC")).unwrap();
        assert_eq!(k.command(false), Some(OexCommand::ReadEsenc));
        assert_eq!(
            ChartKind::from_path(Path::new("/a/x.senc")),
            Some(ChartKind::Senc)
        );
        assert_eq!(
            ChartKind::from_path(Path::new("/a/x.osenc")),
            Some(ChartKind::Senc)
        );
        assert_eq!(ChartKind::Senc.command(false), None);
        assert_eq!(ChartKind::from_path(Path::new("/a/x.000")), None);
    }

    /// The production incident this closes: a daemon dribbling one byte
    /// well within the per-call window (here 40ms, far under the 150ms
    /// deadline) must still time out once the WHOLE response has run past
    /// `deadline` — not keep getting a fresh per-call allowance forever. The
    /// pre-fix behavior (`deadline` recomputed inside `read()` on every
    /// call) would only time out ~150ms after the writer's last byte, i.e.
    /// close to 950ms here; this asserts it fires near the 150ms budget
    /// instead.
    #[test]
    fn read_bounds_whole_response_not_just_per_call_gaps() {
        let dir = std::env::temp_dir().join(format!(
            "chartcore-oexstream-dribble-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("resp");
        unix::make_fifo(&path, 0o600).unwrap();

        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(unix::O_NONBLOCK)
            .open(&path)
            .unwrap();
        let mut stream = OexStream {
            file,
            path: path.clone(),
            deadline: Instant::now() + Duration::from_millis(150),
            seen_writer: false,
            active: None,
        };

        let writer_path = path.clone();
        let writer = std::thread::spawn(move || {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .open(&writer_path)
                .unwrap();
            for _ in 0..20 {
                if f.write_all(b"x").is_err() {
                    break;
                }
                let _ = f.flush();
                std::thread::sleep(Duration::from_millis(40));
            }
        });

        let start = Instant::now();
        let mut buf = [0u8; 1];
        let err = loop {
            match stream.read(&mut buf) {
                Ok(0) => panic!("writer's steady dribble should never look like real EOF here"),
                Ok(_) => continue,
                Err(e) => break e,
            }
        };
        let elapsed = start.elapsed();

        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(
            elapsed < Duration::from_millis(500),
            "took {elapsed:?}; a per-call-reset deadline would let a steady \
             dribble stall past the {:?} whole-response budget",
            Duration::from_millis(150)
        );

        drop(stream);
        let _ = writer.join();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
