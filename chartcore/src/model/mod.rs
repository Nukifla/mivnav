// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Normalized chart feature model — the decoder-agnostic equivalent of
//! ochartsng's `S57BaseObject`.
//!
//! Every chart decoder (the GDAL-backed S-57 reader in [`crate::s57`] today,
//! the OSENC decoder in Phase 4) produces this model, and everything
//! downstream (derived-fact pass, coverage partition, MVT encoding) consumes
//! only this model. The vocabulary is S-57's data model — object classes,
//! attribute acronyms, point/line/area primitives — because both source
//! formats speak it, but nothing here depends on any particular decoder or
//! on GDAL types.
//!
//! Geometry is stored in WebMercator world integer coordinates
//! ([`crate::coords`], z20 + 1 sub-pixel bit) so all downstream tiling math
//! is integer-only.

mod attribute;
mod feature;
mod geometry;

pub use attribute::AttrValue;
pub use feature::{Cell, CellMeta, Feature};
pub use geometry::{Geometry, PointZ, Polygon};
