// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! S-57 ENC cell reader, backed by GDAL/OGR's S57 driver.
//! Decodes a `.000` base cell (sibling `.001`… updates applied by the driver)
//! into the normalized [`crate::model`]; GDAL types stay inside this module.

mod convert;

use std::fmt;
use std::path::Path;

use gdal::{Dataset, DatasetOptions, GdalOpenFlags};

use crate::coords::Extent;
use crate::model::{Cell, CellMeta};

#[derive(Debug)]
pub enum S57Error {
    /// GDAL/OGR failure (open, layer or feature access).
    Gdal(gdal::errors::GdalError),
    /// The cell has no DSID record — not a valid ENC dataset.
    MissingDsid,
    /// A feature carried a geometry type S-57 cannot contain.
    UnsupportedGeometry { layer: String, wkb_type: String },
}

impl fmt::Display for S57Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            S57Error::Gdal(e) => write!(f, "GDAL error: {e}"),
            S57Error::MissingDsid => write!(f, "S-57 cell has no DSID record"),
            S57Error::UnsupportedGeometry { layer, wkb_type } => {
                write!(f, "unsupported geometry type {wkb_type} in layer {layer}")
            }
        }
    }
}

impl std::error::Error for S57Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            S57Error::Gdal(e) => Some(e),
            _ => None,
        }
    }
}

impl From<gdal::errors::GdalError> for S57Error {
    fn from(e: gdal::errors::GdalError) -> Self {
        S57Error::Gdal(e)
    }
}

/// Open options for the OGR S57 driver; defaults suit the tiling pipeline.
/// M_COVR coverage polygons are ordinary features, always returned —
/// `return_primitives` only gates low-level VI/VC/VE/VF records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct S57OpenOptions {
    /// Apply sibling update files (`.001`, `.002`, …) — `UPDATES=APPLY`.
    pub apply_updates: bool,
    /// Split SOUNDG multipoints into one point feature each, with a DEPTH
    /// attribute — `SPLIT_MULTIPOINT=ON` + `ADD_SOUNDG_DEPTH=ON`.
    /// Off by default: the model keeps soundings as one multipoint.
    pub split_multipoint: bool,
    /// Expose low-level vector primitive records (VI/VC/VE/VF) as extra
    /// layers — `RETURN_PRIMITIVES=ON`. Debugging only.
    pub return_primitives: bool,
    /// Expose FFPT/FSPT linkage fields on features — `RETURN_LINKAGES=ON`.
    pub return_linkages: bool,
    /// Expose the LNAM unique id and LNAM_REFS linkage list — `LNAM_REFS=ON`.
    pub lnam_refs: bool,
    /// Lift QUAPOS onto [`Feature::spatial_quapos`](crate::model::Feature::spatial_quapos):
    /// GDAL's feature schema doesn't surface positional quality (it's on the
    /// VI/VC/VE primitives), so this forces RETURN_PRIMITIVES/LINKAGES internally.
    pub lift_spatial_quapos: bool,
}

impl Default for S57OpenOptions {
    fn default() -> Self {
        S57OpenOptions {
            apply_updates: true,
            split_multipoint: false,
            return_primitives: false,
            return_linkages: false,
            lnam_refs: true,
            lift_spatial_quapos: true,
        }
    }
}

impl S57OpenOptions {
    fn to_open_options(&self) -> Vec<String> {
        fn onoff(v: bool) -> &'static str {
            if v {
                "ON"
            } else {
                "OFF"
            }
        }
        vec![
            format!(
                "UPDATES={}",
                if self.apply_updates {
                    "APPLY"
                } else {
                    "IGNORE"
                }
            ),
            format!("SPLIT_MULTIPOINT={}", onoff(self.split_multipoint)),
            // only meaningful with SPLIT_MULTIPOINT; keep them in lockstep
            format!("ADD_SOUNDG_DEPTH={}", onoff(self.split_multipoint)),
            format!(
                "RETURN_PRIMITIVES={}",
                onoff(self.return_primitives || self.lift_spatial_quapos)
            ),
            format!(
                "RETURN_LINKAGES={}",
                onoff(self.return_linkages || self.lift_spatial_quapos)
            ),
            format!("LNAM_REFS={}", onoff(self.lnam_refs)),
        ]
    }
}

/// Layer names of the spatial-primitive pseudo-layers exposed by
/// `RETURN_PRIMITIVES=ON`.
const PRIMITIVE_LAYERS: [&str; 4] = ["IsolatedNode", "ConnectedNode", "Edge", "Face"];

/// Read an S-57 ENC cell into the normalized feature model. The DSID layer
/// becomes [`CellMeta`]; every other layer's features decode into
/// [`crate::model::Feature`]s with geometry converted from lon/lat to world coords.
pub fn read_cell(path: &Path, options: &S57OpenOptions) -> Result<Cell, S57Error> {
    let open_options = options.to_open_options();
    let open_option_refs: Vec<&str> = open_options.iter().map(String::as_str).collect();
    let dataset = Dataset::open_ex(
        path,
        DatasetOptions {
            open_flags: GdalOpenFlags::GDAL_OF_VECTOR | GdalOpenFlags::GDAL_OF_READONLY,
            allowed_drivers: Some(&["S57"]),
            open_options: Some(&open_option_refs),
            sibling_files: None,
        },
    )?;

    let mut meta: Option<CellMeta> = None;
    let mut features = Vec::new();
    let mut spatial_refs: Vec<convert::SpatialRefs> = Vec::new();
    let mut quapos_table: std::collections::HashMap<(i64, i64), i64> =
        std::collections::HashMap::new();
    let mut extent = Extent::invalid();

    for mut layer in dataset.layers() {
        use gdal::vector::LayerAccess;
        let layer_name = layer.name();
        if layer_name == "DSID" {
            if let Some(f) = layer.features().next() {
                meta = Some(convert::dsid_to_meta(&f));
            }
            continue;
        }
        if PRIMITIVE_LAYERS.contains(&layer_name.as_str()) {
            if options.lift_spatial_quapos {
                for f in layer.features() {
                    if let Some((key, quapos)) = convert::primitive_quapos(&f) {
                        quapos_table.insert(key, quapos);
                    }
                }
            }
            if !options.return_primitives {
                continue; // consumed for the lift, not emitted (debug-only)
            }
            // fall through: primitives were explicitly requested as features
            layer.reset_feature_reading();
        }
        for ogr_feature in layer.features() {
            let (feature, refs) = convert::to_model(&layer_name, &ogr_feature)?;
            extent.extend(&feature.extent);
            features.push(feature);
            spatial_refs.push(refs);
        }
    }

    // resolve each feature's spatial-record pointers against the QUAPOS table
    if !quapos_table.is_empty() {
        for (feature, refs) in features.iter_mut().zip(&spatial_refs) {
            feature.spatial_quapos = refs
                .iter()
                .filter_map(|key| quapos_table.get(key))
                .copied()
                .collect();
        }
    }

    Ok(Cell {
        meta: meta.ok_or(S57Error::MissingDsid)?,
        features,
        extent,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_open_options() {
        let opts = S57OpenOptions::default().to_open_options();
        assert!(opts.contains(&"UPDATES=APPLY".to_string()));
        assert!(opts.contains(&"SPLIT_MULTIPOINT=OFF".to_string()));
        // the QUAPOS lift (default on) forces primitives + linkages
        assert!(opts.contains(&"RETURN_PRIMITIVES=ON".to_string()));
        assert!(opts.contains(&"RETURN_LINKAGES=ON".to_string()));
        assert!(opts.contains(&"LNAM_REFS=ON".to_string()));
    }

    #[test]
    fn no_lift_leaves_primitives_and_linkages_off() {
        let opts = S57OpenOptions {
            lift_spatial_quapos: false,
            ..Default::default()
        }
        .to_open_options();
        assert!(opts.contains(&"RETURN_PRIMITIVES=OFF".to_string()));
        assert!(opts.contains(&"RETURN_LINKAGES=OFF".to_string()));
    }

    #[test]
    fn split_multipoint_implies_depth_attribute() {
        let opts = S57OpenOptions {
            split_multipoint: true,
            ..Default::default()
        }
        .to_open_options();
        assert!(opts.contains(&"SPLIT_MULTIPOINT=ON".to_string()));
        assert!(opts.contains(&"ADD_SOUNDG_DEPTH=ON".to_string()));
    }
}
