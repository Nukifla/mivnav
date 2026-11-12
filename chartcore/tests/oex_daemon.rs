// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! oexserverd client tests.
//!
//! Two independent axes, neither needing o-charts credentials:
//! * a **mock daemon** (plain Rust thread speaking the raw-FIFO protocol)
//!   validates our client bytes, framing and both license-failure verdicts;
//! * the **real vendor binary** (public download, `#[ignore]`d so offline
//!   CI stays green — run with `cargo test -- --ignored`) validates
//!   launch, ping and clean shutdown against the actual closed-source code.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chartcore::oex::{
    ensure_daemon, FifoTransport, OexCommand, OexConfig, OexControl, OexState, MESSAGE_SIZE,
};
use chartcore::osenc::write::SencWriter;
use chartcore::osenc::{OsencError, ServerStatus};

struct TestDir(PathBuf);
impl TestDir {
    fn new(tag: &str) -> TestDir {
        let dir = std::env::temp_dir().join(format!("chartcore-oex-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TestDir(dir)
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A parsed 1025-byte request as the daemon would see it.
struct MockRequest {
    cmd: u8,
    fifo_name: String,
    senc_name: String,
    senc_key: String,
}

fn cstr(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

/// Minimal mock oexserverd: creates the request FIFO, reads 1025-byte
/// messages and answers each on the pipe named in the request. Exits on
/// CMD_EXIT. Panics in the thread surface as test failures via the
/// response never arriving (client times out).
fn spawn_mock_daemon(
    request_pipe: PathBuf,
    respond: impl Fn(&MockRequest) -> Vec<u8> + Send + 'static,
) -> std::thread::JoinHandle<Vec<MockRequest>> {
    // the daemon side owns the request pipe, like the real one
    let c_path = std::ffi::CString::new(request_pipe.as_os_str().as_encoded_bytes()).unwrap();
    extern "C" {
        fn mkfifo(path: *const std::ffi::c_char, mode: std::ffi::c_uint) -> std::ffi::c_int;
    }
    assert_eq!(unsafe { mkfifo(c_path.as_ptr(), 0o600) }, 0, "mock mkfifo");
    std::thread::spawn(move || {
        let mut seen = Vec::new();
        'outer: loop {
            // blocking open: waits for a client to connect a write end
            let mut pipe = std::fs::File::open(&request_pipe).expect("mock: open request pipe");
            loop {
                let mut buf = [0u8; MESSAGE_SIZE];
                match pipe.read_exact(&mut buf) {
                    Ok(()) => {}
                    Err(_) => break, // EOF: writer closed; reopen
                }
                let req = MockRequest {
                    cmd: buf[0],
                    fifo_name: cstr(&buf[1..257]),
                    senc_name: cstr(&buf[257..513]),
                    senc_key: cstr(&buf[513..1025]),
                };
                if req.cmd == OexCommand::Exit as u8 {
                    break 'outer;
                }
                let response = respond(&req);
                // open the client's response pipe for writing (blocks
                // until... nothing: the client already holds the read end)
                use std::io::Write;
                let mut out = std::fs::OpenOptions::new()
                    .write(true)
                    .open(&req.fifo_name)
                    .expect("mock: open response pipe");
                out.write_all(&response).expect("mock: write response");
                seen.push(req);
            }
        }
        seen
    })
}

fn transport(dir: &Path) -> (PathBuf, FifoTransport) {
    let request_pipe = dir.join("OCPN_PIPEX");
    let transport = FifoTransport::new(request_pipe.clone(), dir.join("work")).expect("transport");
    (request_pipe, transport)
}

fn shutdown_mock(
    transport: &FifoTransport,
    handle: std::thread::JoinHandle<Vec<MockRequest>>,
) -> Vec<MockRequest> {
    // CMD_EXIT unblocks and terminates the mock loop
    let _ = transport.transact(OexCommand::Exit as u8, "", "", Duration::from_secs(2));
    handle.join().expect("mock daemon thread")
}

#[test]
fn mock_daemon_ping_and_message_bytes() {
    let dir = TestDir::new("ping");
    let (request_pipe, transport) = transport(&dir.0);
    let handle = spawn_mock_daemon(request_pipe, |req| {
        assert_eq!(req.cmd, OexCommand::TestAvail as u8);
        b"OK".to_vec()
    });

    let mut stream = transport
        .transact(OexCommand::TestAvail as u8, "", "", Duration::from_secs(5))
        .expect("transact");
    let mut buf = [0u8; 2];
    stream.read_exact(&mut buf).expect("ping reply");
    assert_eq!(&buf, b"OK");
    // and EOF after the daemon closes
    let mut rest = Vec::new();
    stream.read_to_end(&mut rest).expect("clean EOF");
    assert!(rest.is_empty());
    drop(stream);

    let seen = shutdown_mock(&transport, handle);
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].senc_name, "");
    assert_eq!(seen[0].senc_key, "");
    assert!(seen[0].fifo_name.contains("resp-"), "{}", seen[0].fifo_name);
}

/// Full chart request: the mock streams a synthetic OSENC cell (leading
/// SERVER_STATUS like the real daemon) and the response decodes through
/// the real OSENC decoder — client framing, FIFO plumbing and decoder all
/// exercised together.
#[test]
fn mock_daemon_chart_stream_decodes() {
    let dir = TestDir::new("chart");
    let (request_pipe, transport) = transport(&dir.0);
    let handle = spawn_mock_daemon(request_pipe, |req| {
        assert_eq!(req.cmd, OexCommand::ReadOesu as u8);
        assert_eq!(req.senc_name, "/charts/DE521900.oesu");
        assert_eq!(req.senc_key, "fabricated-key");
        let mut w = SencWriter::new();
        w.server_status(ServerStatus {
            server_status: 1,
            decrypt_status: 1,
            expire_status: 1,
            ..Default::default()
        })
        .version(201)
        .cell_name("DE521900")
        .cell_edition(7)
        .extent(&chartcore::coords::LLBox {
            n_lat: 54.6,
            s_lat: 54.5,
            w_lon: 9.0,
            e_lon: 9.1,
        })
        .native_scale(12000)
        .feature(75, 1, 1)
        .point_geometry(54.55, 9.05);
        w.into_bytes()
    });

    let stream = transport
        .transact(
            OexCommand::ReadOesu as u8,
            "/charts/DE521900.oesu",
            "fabricated-key",
            Duration::from_secs(5),
        )
        .expect("transact");
    let cell = chartcore::osenc::read_cell(stream).expect("daemon stream decodes");
    assert_eq!(cell.meta.name, "DE521900");
    assert_eq!(cell.meta.edition, 7);
    assert_eq!(cell.features.len(), 1);
    assert_eq!(cell.features[0].acronym, "LIGHTS");

    shutdown_mock(&transport, handle);
}

#[test]
fn mock_daemon_license_failure_verdicts() {
    let dir = TestDir::new("verdict");
    let (request_pipe, transport) = transport(&dir.0);
    let handle = spawn_mock_daemon(request_pipe, |req| {
        let mut w = SencWriter::new();
        let ok = ServerStatus {
            server_status: 1,
            decrypt_status: 1,
            expire_status: 1,
            ..Default::default()
        };
        if req.senc_key == "wrong-key" {
            w.server_status(ServerStatus {
                decrypt_status: 0,
                ..ok
            });
        } else {
            w.server_status(ServerStatus {
                expire_status: 0,
                grace_days_allowed: 30,
                grace_days_remaining: 0,
                ..ok
            });
        }
        w.into_bytes()
    });

    let stream = transport
        .transact(
            OexCommand::ReadOesu as u8,
            "/x.oesu",
            "wrong-key",
            Duration::from_secs(5),
        )
        .expect("transact");
    assert!(matches!(
        chartcore::osenc::read_cell(stream),
        Err(OsencError::Decrypt(s)) if s.decrypt_status == 0
    ));

    let stream = transport
        .transact(
            OexCommand::ReadOesu as u8,
            "/x.oesu",
            "expired-key",
            Duration::from_secs(5),
        )
        .expect("transact");
    assert!(matches!(
        chartcore::osenc::read_cell(stream),
        Err(OsencError::Expired(s)) if s.grace_days_allowed == 30
    ));

    shutdown_mock(&transport, handle);
}

#[test]
fn transact_times_out_without_daemon() {
    let dir = TestDir::new("nodaemon");
    let (_request_pipe, transport) = transport(&dir.0);
    // no mock: the request pipe doesn't even exist
    let err = transport
        .transact(
            OexCommand::TestAvail as u8,
            "",
            "",
            Duration::from_millis(200),
        )
        .err()
        .expect("must time out");
    assert!(
        matches!(err, chartcore::oex::OexError::Timeout(_)),
        "{err:?}"
    );
}

/// Launch the real vendor daemon: download (cached, git-ignored), start,
/// ping, clean shutdown. `#[ignore]`d because it needs network on first
/// run, x86_64 Linux, and the system-wide `/tmp/OCPN_PIPEX`; run manually:
/// `cargo test --test oex_daemon -- --ignored --nocapture`.
#[test]
#[ignore = "needs the downloaded vendor binary and the global /tmp/OCPN_PIPEX"]
fn real_daemon_start_ping_stop() {
    let cache = chartcore::oex::download::default_cache_dir();
    let daemon = match ensure_daemon(&cache) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("skipping: cannot obtain oexserverd ({e})");
            return;
        }
    };
    let dir = TestDir::new("real");
    let config = OexConfig::new(daemon, dir.0.join("work"));
    let control = OexControl::new(config).expect("control");
    control.start();
    let running = control.wait_for_state(OexState::Running, Duration::from_secs(15));
    if !running {
        panic!(
            "daemon did not reach Running: state {:?}, error {:?}, log:\n{}",
            control.state(),
            control.last_error(),
            control.log().join("\n")
        );
    }
    // Running means CMD_TEST_AVAIL answered "OK"; poke it once more
    // explicitly via a header request with a bogus file — any response
    // (even none) must not wedge the client
    let r = control.send_command(OexCommand::ReadOesuHdr, "/nonexistent.oesu", "bogus");
    if let Ok(mut stream) = r {
        let mut sink = Vec::new();
        let _ = stream.read_to_end(&mut sink); // timeout or EOF both fine
        eprintln!("bogus-open response: {} bytes", sink.len());
    }
    control.stop();
    assert!(
        control.wait_for_state(OexState::Unknown, Duration::from_secs(15)),
        "daemon did not stop cleanly"
    );
    eprintln!("daemon log:\n{}", control.log().join("\n"));
}
