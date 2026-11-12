// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Chart features and cells.

use std::collections::BTreeMap;

use super::{AttrValue, Geometry};
use crate::coords::Extent;

/// One chart feature: an S-57 object with its class, attributes and geometry.
/// `attributes` holds only real object attributes — decoder bookkeeping
/// (record ids, LNAM linkage, update numbers) is lifted into typed fields
/// here or dropped.
#[derive(Debug, Clone, PartialEq)]
pub struct Feature {
    /// S-57 object class code (OBJL), e.g. 42 for DEPARE. 0 if unknown.
    pub type_code: u16,
    pub acronym: String,
    pub attributes: BTreeMap<String, AttrValue>,
    /// `None` for geometry-less features (e.g. collection objects, C_AGGR/C_ASSO).
    pub geometry: Option<Geometry>,
    pub extent: Extent,
    /// Minimum display scale (SCAMIN), if present: not shown below 1:scamin.
    /// Typed rather than a plain attribute because it gates rendering.
    pub scamin: Option<u32>,
    pub rcid: Option<u32>,
    /// Worldwide unique feature identifier (LNAM = AGEN+FIDN+FIDS, hex),
    /// used by feature-to-feature linkages (e.g. lights on buoys).
    pub lnam: Option<String>,
    /// LNAMs from S-57 FFPT/LNAM_REFS pointers (structure -> slaves or vice
    /// versa). Populated only by the GDAL S-57 path (`LNAM_REFS=ON`);
    /// consumed by the `aid_group` derive pass.
    pub lnam_refs: Vec<String>,
    /// S-57 display group (GRUP): 1 = "skin of the earth", 2 = everything else.
    pub group: Option<u8>,
    /// QUAPOS of the feature's spatial records, when the decoder exposes
    /// linkages. Empty when unknown — absence means "accurate" per QUALIN01.
    pub spatial_quapos: Vec<i64>,
}

impl Feature {
    /// Decoder-specific metadata (`rcid`, `lnam`, `group`) starts `None`.
    pub fn new(
        type_code: u16,
        acronym: String,
        attributes: BTreeMap<String, AttrValue>,
        geometry: Option<Geometry>,
    ) -> Self {
        let extent = geometry
            .as_ref()
            .map(|g| g.extent())
            .unwrap_or_else(Extent::invalid);
        let scamin = attributes
            .get("SCAMIN")
            .and_then(AttrValue::as_int)
            .and_then(|v| u32::try_from(v).ok())
            .filter(|&v| v > 0);
        Feature {
            type_code,
            acronym,
            attributes,
            geometry,
            extent,
            scamin,
            rcid: None,
            lnam: None,
            lnam_refs: Vec::new(),
            group: None,
            spatial_quapos: Vec::new(),
        }
    }

    pub fn attr(&self, acronym: &str) -> Option<&AttrValue> {
        self.attributes.get(acronym)
    }
}

/// Identity and metadata of a chart cell, from the S-57 dataset
/// identification (DSID/DSPM) records.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CellMeta {
    /// Dataset name, e.g. `"US5OAKIQ.000"`.
    pub name: String,
    pub edition: u32,
    /// 0 for a base cell without applied updates.
    pub update: u32,
    /// Compilation scale denominator (CSCL). The cell's native scale;
    /// drives zoom assignment and coverage priority.
    pub compilation_scale: u32,
}

/// A decoded chart cell: metadata plus all features.
#[derive(Debug, Clone, PartialEq)]
pub struct Cell {
    pub meta: CellMeta,
    pub features: Vec<Feature>,
    /// Union of all feature extents.
    pub extent: Extent,
}

impl Cell {
    /// All features of one object class.
    pub fn features_of<'a>(&'a self, acronym: &'a str) -> impl Iterator<Item = &'a Feature> {
        self.features.iter().filter(move |f| f.acronym == acronym)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::WorldXy;

    #[test]
    fn new_derives_extent_and_scamin() {
        let mut attrs = BTreeMap::new();
        attrs.insert("SCAMIN".to_string(), AttrValue::Int(29999));
        let f = Feature::new(
            75,
            "LIGHTS".into(),
            attrs,
            Some(Geometry::Point(WorldXy::new(10, 20))),
        );
        assert_eq!(f.scamin, Some(29999));
        assert_eq!(f.extent, Extent::new(10, 10, 20, 20));

        let g = Feature::new(0, "C_AGGR".into(), BTreeMap::new(), None);
        assert_eq!(g.scamin, None);
        assert!(!g.extent.valid);
    }

    #[test]
    fn nonpositive_scamin_is_dropped() {
        let mut attrs = BTreeMap::new();
        attrs.insert("SCAMIN".to_string(), AttrValue::Int(0));
        let f = Feature::new(1, "X".into(), attrs, None);
        assert_eq!(f.scamin, None);
    }
}
