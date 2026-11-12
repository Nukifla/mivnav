// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! `oexserverd` binary acquisition: fetched from the public
//! `github.com/bdbcat/o-charts_pi` repo, never vendored, cached in a
//! git-ignored dir. See docs/architecture/oexserverd-binary-provenance.md.

use std::fmt;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

/// Pinned o-charts_pi git tag the binaries are fetched from. `v2.1.17` is the
/// newest tag on o-charts `main` that ships the daemon (daemon Version 1.48
/// x86_64 / 1.49 aarch64); it supersedes 1.0.29.0's buggy "Version 1.21".
pub const OCHARTS_PI_TAG: &str = "v2.1.17";

/// Files each supported platform's daemon needs: the executable plus the
/// dongle-support libraries it links against (`LD_LIBRARY_PATH` points at
/// the cache dir). Library name/count differ by arch (verified against
/// upstream o-charts_pi v2.1.17; aarch64 ships no libusb).
#[cfg(target_arch = "x86_64")]
const FILES: &[&str] = &["oexserverd", "libsgllnx64-2.29.02.so", "libusb-0.1.so.4"];
#[cfg(target_arch = "aarch64")]
const FILES: &[&str] = &["oexserverd", "libsglarm64-2.31.0.0.so"];
// Fallback so the crate still compiles on other arches; `ensure_daemon`
// rejects them at runtime before these are ever used (behaviour unchanged).
#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
const FILES: &[&str] = &["oexserverd"];

/// Upstream `libs/oeserverd/<subdir>` the binaries are fetched from, by arch.
#[cfg(target_arch = "aarch64")]
const ARCH_SUBDIR: &str = "linuxarm64";
#[cfg(not(target_arch = "aarch64"))]
const ARCH_SUBDIR: &str = "linux64";

/// Name of the daemon executable within the cache directory.
pub const DAEMON_EXE: &str = "oexserverd";

#[derive(Debug)]
pub enum DownloadError {
    /// Only x86_64 (`linux64`) and aarch64 (`linuxarm64`) Linux binaries are
    /// published upstream.
    UnsupportedPlatform,
    Io(io::Error),
    Http(String),
}

impl fmt::Display for DownloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DownloadError::UnsupportedPlatform => {
                write!(
                    f,
                    "oexserverd is only available for x86_64 or aarch64 Linux"
                )
            }
            DownloadError::Io(e) => write!(f, "I/O error: {e}"),
            DownloadError::Http(m) => write!(f, "download failed: {m}"),
        }
    }
}

impl std::error::Error for DownloadError {}

impl From<io::Error> for DownloadError {
    fn from(e: io::Error) -> Self {
        DownloadError::Io(e)
    }
}

fn url(file: &str) -> String {
    format!(
        "https://raw.githubusercontent.com/bdbcat/o-charts_pi/{OCHARTS_PI_TAG}/libs/oeserverd/{ARCH_SUBDIR}/{file}"
    )
}

/// Ensure the daemon binary (and its libraries) exist in `cache_dir`,
/// downloading whatever is missing. Returns the path to the executable.
/// Files are written via a temp name + rename so an interrupted download
/// never leaves a truncated file that later runs would trust.
pub fn ensure_daemon(cache_dir: &Path) -> Result<PathBuf, DownloadError> {
    if !cfg!(all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    )) {
        return Err(DownloadError::UnsupportedPlatform);
    }
    std::fs::create_dir_all(cache_dir)?;
    for file in FILES {
        let dest = cache_dir.join(file);
        if dest.exists() {
            continue;
        }
        let mut response = ureq::get(&url(file))
            .call()
            .map_err(|e| DownloadError::Http(format!("{file}: {e}")))?;
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .read_to_end(&mut bytes)
            .map_err(DownloadError::Io)?;
        if bytes.is_empty() {
            return Err(DownloadError::Http(format!("{file}: empty response")));
        }
        let tmp = cache_dir.join(format!(".{file}.tmp.{}", std::process::id()));
        std::fs::write(&tmp, &bytes)?;
        if *file == DAEMON_EXE {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::rename(&tmp, &dest)?;
    }
    Ok(cache_dir.join(DAEMON_EXE))
}

/// The default cache directory used by tests and tooling:
/// `<crate>/tools/oexserverd` (git-ignored).
pub fn default_cache_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tools")
        .join("oexserverd")
}
