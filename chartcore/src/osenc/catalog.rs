// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Embedded S-57 object/attribute catalogue, ported from ochartsng's S-57
//! catalogue CSVs (GPLv2, Andreas Vogel / OpenCPN). See
//! docs/architecture/osenc-record-format.md for why and what it covers.

use std::collections::HashMap;
use std::sync::OnceLock;

/// S-57 attribute value type from the catalogue (`Attributetype` column).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttrType {
    /// `E` — enumeration (single code).
    Enum,
    /// `L` — list of enumeration codes (COLOUR, CATLIT, RESTRN, NATSUR…).
    List,
    /// `F` — float.
    Float,
    /// `I` — integer.
    Int,
    /// `A`/`S` — string (coded / free text).
    Str,
}

pub struct AttrInfo {
    pub acronym: &'static str,
    pub ty: AttrType,
}

struct Catalog {
    attributes: HashMap<u16, AttrInfo>,
    classes: HashMap<u16, &'static str>,
}

/// Minimal CSV field splitter: handles the double-quoted fields the
/// catalogue uses (`"Beacon, lateral"`), no escapes beyond that.
fn csv_fields(line: &str) -> Vec<&str> {
    let mut fields = Vec::new();
    let bytes = line.as_bytes();
    let mut start = 0;
    let mut in_quotes = false;
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'"' => in_quotes = !in_quotes,
            b',' if !in_quotes => {
                fields.push(line[start..i].trim_matches('"'));
                start = i + 1;
            }
            _ => {}
        }
    }
    fields.push(line[start..].trim_matches('"'));
    fields
}

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let mut attributes = HashMap::new();
        for line in include_str!("s57attributes.csv").lines().skip(1) {
            let f = csv_fields(line);
            if f.len() < 4 {
                continue;
            }
            let Ok(code) = f[0].parse::<u16>() else {
                continue;
            };
            let ty = match f[3] {
                "E" => AttrType::Enum,
                "L" => AttrType::List,
                "F" => AttrType::Float,
                "I" => AttrType::Int,
                _ => AttrType::Str, // A, S
            };
            attributes.insert(code, AttrInfo { acronym: f[2], ty });
        }
        let mut classes = HashMap::new();
        for line in include_str!("s57objectclasses.csv").lines().skip(1) {
            let f = csv_fields(line);
            if f.len() < 3 {
                continue;
            }
            let Ok(code) = f[0].parse::<u16>() else {
                continue;
            };
            classes.insert(code, f[2]);
        }
        Catalog {
            attributes,
            classes,
        }
    })
}

/// Attribute info by S-57 attribute code. `None` for codes outside the
/// catalogue (the decoder drops those attributes, like the reference).
pub fn attribute(code: u16) -> Option<&'static AttrInfo> {
    catalog().attributes.get(&code)
}

/// Object class acronym by S-57 object class code (OBJL).
pub fn class_acronym(code: u16) -> Option<&'static str> {
    catalog().classes.get(&code).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_entries() {
        assert_eq!(class_acronym(42), Some("DEPARE"));
        assert_eq!(class_acronym(302), Some("M_COVR"));
        // o-charts 17xxx extension classes are present
        assert_eq!(class_acronym(17028), Some("bcnlat"));
        assert_eq!(class_acronym(64000), None);

        let colour = attribute(75).unwrap();
        assert_eq!((colour.acronym, colour.ty), ("COLOUR", AttrType::List));
        let scamin = attribute(133).unwrap();
        assert_eq!((scamin.acronym, scamin.ty), ("SCAMIN", AttrType::Int));
        let drval1 = attribute(87).unwrap();
        assert_eq!((drval1.acronym, drval1.ty), ("DRVAL1", AttrType::Float));
        let objnam = attribute(116).unwrap();
        assert_eq!((objnam.acronym, objnam.ty), ("OBJNAM", AttrType::Str));
        assert!(attribute(64000).is_none());
    }

    #[test]
    fn csv_quoted_commas() {
        assert_eq!(
            csv_fields(r#"17028,"Beacon, lateral",bcnlat,X"#),
            vec!["17028", "Beacon, lateral", "bcnlat", "X"]
        );
    }
}
