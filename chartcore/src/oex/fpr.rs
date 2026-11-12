// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only
//
// Ported from ochartsng's OexControl::GetFpr / execOexCommand
// (provider/src/OexControl.cpp:739-901; GPLv2, Andreas Vogel).

//! System fingerprint generation, by running `oexserverd -g <dir>/` and
//! parsing its stdout. See docs/architecture/oex-fingerprint.md for the
//! flow and why the daemon version is pinned ([`super::download`]).

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::OexError;

/// A generated fingerprint: the `.fpr` file name (the shop's `xfprName`)
/// and its content hex-encoded (the shop's `xfpr`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fingerprint {
    pub name: String,
    pub value_hex: String,
}

/// Generate the system fingerprint by running `<daemon> -g <tmp_dir>/`.
/// `tmp_dir` is created if missing and the generated file removed after
/// (caller keeps only the in-memory hex; it's a machine id, not chart data).
pub fn get_fingerprint(
    daemon: &Path,
    tmp_dir: &Path,
    timeout: Duration,
) -> Result<Fingerprint, OexError> {
    std::fs::create_dir_all(tmp_dir)?;
    let mut arg = tmp_dir
        .to_str()
        .ok_or(OexError::Protocol("non-UTF8 tmp dir".into()))?
        .to_string();
    // the vendor binary treats the argument as a prefix: it must end in '/'
    if !arg.ends_with('/') {
        arg.push('/');
    }
    let lib_dir = daemon.parent().unwrap_or(Path::new("."));
    let mut cmd = Command::new(daemon);
    cmd.arg("-g")
        .arg(&arg)
        .env("LD_LIBRARY_PATH", lib_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // short-lived, but the same inherit-everything exec as the daemon — don't
    // hand the vendor binary our embedder's sockets
    super::unix::harden_child(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| OexError::Protocol(format!("unable to run fpr command: {e}")))?;

    // bounded stdout read (the reference caps at 200 KiB)
    let mut output = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let mut buf = [0u8; 4096];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if output.len() < 204_800 {
                        output.push_str(&String::from_utf8_lossy(&buf[..n]));
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    }
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(OexError::Timeout("fpr command did not terminate".into()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => break,
        }
    }

    // find the stdout line naming the fpr file: contains "fpr"/"FPR" and a ':'
    let mut fpr_path = None;
    for line in output.lines() {
        if line.contains("ERROR") || line.contains("error") {
            return Err(OexError::Protocol(format!("fpr command failed: {line}")));
        }
        if (line.contains("FPR") || line.contains("fpr")) && line.contains(':') {
            let (_, path) = line.split_once(':').unwrap();
            let path = path.trim();
            if !path.is_empty() {
                fpr_path = Some(path.to_string());
                break;
            }
        }
    }
    let fpr_path = fpr_path
        .ok_or_else(|| OexError::Protocol("no fpr filename in oexserverd output".into()))?;
    let bytes = std::fs::read(&fpr_path)
        .map_err(|e| OexError::Protocol(format!("cannot read fpr file {fpr_path}: {e}")))?;
    let _ = std::fs::remove_file(&fpr_path);
    if bytes.is_empty() {
        return Err(OexError::Protocol("empty fpr file".into()));
    }
    let name = Path::new(&fpr_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or(fpr_path.clone());
    let value_hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(Fingerprint { name, value_hex })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fake_daemon(dir: &Path, script: &str) -> std::path::PathBuf {
        let path = dir.join("oexserverd");
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn parses_fpr_from_fake_daemon() {
        let _guard = crate::oex::unix::spawn_guard();
        let dir = std::env::temp_dir().join(format!("chartcore-fpr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // mimics the vendor binary: writes a file into the prefix dir and
        // names it on stdout
        let daemon = fake_daemon(
            &dir,
            "#!/bin/sh\nout=\"$2fake-host.fpr\"\nprintf 'ab\\x10' > \"$out\"\necho \"fpr file: $out\"\n",
        );
        let tmp = dir.join("fpr");
        let fpr = get_fingerprint(&daemon, &tmp, Duration::from_secs(5)).unwrap();
        assert_eq!(fpr.name, "fake-host.fpr");
        assert_eq!(fpr.value_hex, "616210");
        assert!(!tmp.join("fake-host.fpr").exists(), "fpr file cleaned up");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn error_line_is_reported() {
        let _guard = crate::oex::unix::spawn_guard();
        let dir = std::env::temp_dir().join(format!("chartcore-fpr-err-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let daemon = fake_daemon(&dir, "#!/bin/sh\necho 'ERROR: no hardware id'\n");
        let err = get_fingerprint(&daemon, &dir.join("fpr"), Duration::from_secs(5)).unwrap_err();
        assert!(matches!(err, OexError::Protocol(m) if m.contains("no hardware id")));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
