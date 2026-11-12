// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

pub mod coords;
pub mod coverage;
pub mod derive;
pub mod geom_log;
pub mod icons;
pub mod mivnav;
pub mod model;
pub mod mvt;
pub mod oex;
pub mod osenc;
pub mod pmtiles;
pub mod routing;
pub mod s52;
// S-57 `.000` decode is GDAL-backed and dev-box-only (`just ingest`); gated
// so the Pi wheel links no libgdal. See CLAUDE.md / the `s57-ingest` feature.
#[cfg(feature = "s57-ingest")]
pub mod s57;
mod union_find;
mod varint;

/// The crate version, exposed to Python as `chartcore.__version__`
/// (see `python.rs`'s `#[pymodule]`).
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(feature = "pyo3")]
mod python;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_matches_manifest() {
        assert_eq!(version(), env!("CARGO_PKG_VERSION"));
    }
}
