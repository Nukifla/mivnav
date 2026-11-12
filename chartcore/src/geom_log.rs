// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Counting degenerate geometry results into a breadcrumb the backend can
//! show. Capture is opt-in ([`install`]); see docs/architecture/geom-log.md
//! for why, and why the pure-Rust boolean backend still needs this at all.

use std::sync::Mutex;

/// How many recent messages to keep. Small: this is a breadcrumb for a
/// human, not a log, and the counts are what say whether it is routine.
pub const RECENT_CAP: usize = 32;

#[derive(Debug, Default, Clone)]
pub struct GeomLog {
    pub debug: usize,
    pub warnings: usize,
    pub failures: usize,
    /// Most recent messages, newest last, capped at [`RECENT_CAP`].
    pub recent: Vec<String>,
}

static LOG: Mutex<Option<GeomLog>> = Mutex::new(None);

/// Begin capturing degenerate geometry ops into a counted breadcrumb.
///
/// Idempotent. Until it is called, [`note`] is a no-op and [`captured`]
/// returns `None`, so chartcore imposes nothing on a host that never asks.
pub fn install() {
    let mut guard = LOG.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(GeomLog::default());
    }
}

/// Record one message into the breadcrumb. No-op until [`install`].
pub fn record(msg: &str) {
    let mut guard = LOG.lock().unwrap_or_else(|e| e.into_inner());
    let Some(log) = guard.as_mut() else { return };
    log.failures += 1;
    if log.recent.len() == RECENT_CAP {
        log.recent.remove(0);
    }
    log.recent.push(msg.to_owned());
}

/// Pass a geometry op's result through, counting a `None` as a degenerate
/// result and keeping `msg` as its breadcrumb.
pub fn note<T>(r: Option<T>, msg: &str) -> Option<T> {
    if r.is_none() {
        record(msg);
    }
    r
}

/// What the geometry engine has produced nothing on since [`install`], or
/// `None` if it was never called.
pub fn captured() -> Option<GeomLog> {
    LOG.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Installed, a degenerate op is counted and its message kept where a human
    /// can read it — not dropped. Silencing diagnostics into a black hole would
    /// be worse than the flood it replaces, so this is the half of the feature
    /// that matters.
    #[test]
    fn a_degenerate_op_is_captured_not_lost() {
        install();
        let before = captured().expect("installed").failures;
        // the real path: an op that produced nothing usable, exactly as the
        // mask records when a feature's clipped rings dissolve to empty
        let _ = note::<()>(None, "dissolve produced nothing usable");
        let after = captured().expect("installed");
        assert!(
            after.failures > before,
            "a degenerate op must still be counted, not swallowed"
        );
        assert!(
            after.recent.iter().any(|m| m.contains("nothing usable")),
            "and must still be readable by a human: {:?}",
            after.recent
        );
    }

    /// The counts are what say whether it is routine; `recent` is a bounded
    /// breadcrumb and must not grow without limit on a long-running boat
    /// server.
    #[test]
    fn recent_is_bounded() {
        install();
        for _ in 0..(RECENT_CAP + 20) {
            let _ = note::<()>(None, "degenerate");
        }
        let log = captured().expect("installed");
        assert!(log.recent.len() <= RECENT_CAP, "{}", log.recent.len());
        assert!(log.failures >= RECENT_CAP + 20);
    }
}
