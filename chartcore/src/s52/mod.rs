// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! S-52 presentation-library lookup (LUP) tables — a port of ochartsng's
//! `findLUPrecord` / `attributeMatch` / `Attribute::equals`. Still live for
//! `derive::aton`'s `lbl_s` labels and `derive::scamin_exempt`'s
//! DISPLAYBASE/group-1 bypass, even though ATON symbol resolution itself
//! moved to `derive::aton`. See docs/architecture/s52-lup-matcher.md.

mod parse;

use std::collections::BTreeMap;
use std::fmt;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use crate::model::AttrValue;

/// The five LUP tables. `Simplified`/`PaperChart` hold point lookups (the
/// user's symbol-style setting picks one), `Lines` holds line lookups,
/// `PlainBoundaries`/`SymbolizedBoundaries` hold area lookups.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LupTable {
    Simplified,
    PaperChart,
    Lines,
    PlainBoundaries,
    SymbolizedBoundaries,
}

/// One lookup record.
#[derive(Debug, Clone, PartialEq)]
pub struct Lup {
    pub rcid: i64,
    pub class: String,
    pub table: LupTable,
    /// ATTC entries: (6-char attribute acronym, match value). Duplicate
    /// acronyms collapse (last wins) — the reference stores them in a map.
    pub attcs: Vec<(String, String)>,
    pub instruction: String,
    /// Display priority 0-9 (S52Symbols.cpp:154-175 string map).
    pub disp_prio: u8,
    /// Display category, lowercased: "displaybase" | "standard" | "other"
    /// | "mariners".
    pub display_cat: String,
}

/// All lookups, keyed by (table, class), in load order.
#[derive(Debug, Default, Clone)]
pub struct S52Data {
    lups: BTreeMap<(LupTable, String), Vec<Lup>>,
}

impl S52Data {
    /// Add one lookup, replacing any previous one with the same RCID
    /// (patch semantics, `S52Data.cpp:332-364`).
    pub fn add_lup(&mut self, lup: Lup) {
        let list = self.lups.entry((lup.table, lup.class.clone())).or_default();
        list.retain(|l| l.rcid != lup.rcid);
        list.push(lup);
    }

    /// Parse `<lookup>` records from one XML document into the table set.
    pub fn parse_xml(&mut self, xml: &str) {
        parse::parse_lookups(xml, self);
    }

    /// Number of lookups loaded (all tables).
    pub fn len(&self) -> usize {
        self.lups.values().map(Vec::len).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// `findLUPrecord` (S52Data.cpp:275-311): best-scoring LUP for the
    /// feature's attributes, ties resolved by file order, fallback to the
    /// first attribute-less LUP of the class.
    pub fn find_lup(
        &self,
        table: LupTable,
        class: &str,
        attributes: &BTreeMap<String, AttrValue>,
    ) -> Option<&Lup> {
        let list = self.lups.get(&(table, class.to_string()))?;
        let mut no_attr: Option<&Lup> = None;
        let mut best: Option<&Lup> = None;
        let mut score = 0;
        for lup in list {
            if lup.attcs.is_empty() {
                if no_attr.is_none() {
                    no_attr = Some(lup);
                }
                continue;
            }
            let n = attribute_match(lup, attributes);
            if n > score {
                score = n;
                best = Some(lup);
            }
        }
        best.or(no_attr)
    }
}

/// `LUPrec::attributeMatch` (S52Data.cpp:165-199). Returns the score, 0
/// meaning "does not match" (an attribute-less object matches nothing —
/// the attribute-less fallback LUP covers it).
fn attribute_match(lup: &Lup, attributes: &BTreeMap<String, AttrValue>) -> usize {
    if attributes.is_empty() {
        return 0;
    }
    let mut score = 0;
    for (name, value) in &lup.attcs {
        match attributes.get(name) {
            None => {
                if value == "?" {
                    // "?" = the object must lack this attribute
                    score += 1;
                    continue;
                }
                return 0;
            }
            Some(attr) => {
                if !attr_equals(attr, value) {
                    return 0;
                }
                score += 1;
            }
        }
    }
    score
}

/// `Attribute::equals` (S52Data.cpp:63-89).
fn attr_equals(attr: &AttrValue, lup_value: &str) -> bool {
    if lup_value.is_empty() || lup_value == " " {
        return true; // wildcard: any value, but the attribute must exist
    }
    if lup_value == "?" {
        return false; // must-lack, and it is present
    }
    match attr {
        AttrValue::Int(v) => atoi(lup_value) == *v,
        AttrValue::Float(v) => (atof(lup_value) - v).abs() < 1e-6,
        AttrValue::Str(v) => v == lup_value,
        // list attributes: exact raw comma-string equality
        AttrValue::IntList(_) | AttrValue::FloatList(_) | AttrValue::StrList(_) => {
            attr_raw_string(attr) == lup_value
        }
        // derived-only variant; ATTC acronyms are uppercase S-57 names and
        // never address derived (lowercase) attributes
        AttrValue::Bool(_) => false,
    }
}

/// The raw comma-joined string form of a list attribute (matches the MVT
/// tile encoding in [`crate::mvt`]).
fn attr_raw_string(attr: &AttrValue) -> String {
    fn join<T: ToString>(v: &[T]) -> String {
        v.iter().map(T::to_string).collect::<Vec<_>>().join(",")
    }
    match attr {
        AttrValue::IntList(v) => join(v),
        AttrValue::FloatList(v) => join(v),
        AttrValue::StrList(v) => v.join(","),
        _ => String::new(),
    }
}

/// C `atoi`: leading whitespace, optional sign, digit prefix; 0 otherwise.
fn atoi(s: &str) -> i64 {
    numeric_prefix(s, false).parse().unwrap_or(0)
}

/// C `atof` for the simple decimal forms LUP values use.
fn atof(s: &str) -> f64 {
    numeric_prefix(s, true).parse().unwrap_or(0.0)
}

fn numeric_prefix(s: &str, dot: bool) -> &str {
    let t = s.trim_start();
    let mut end = 0;
    let bytes = t.as_bytes();
    if end < bytes.len() && (bytes[end] == b'+' || bytes[end] == b'-') {
        end += 1;
    }
    let mut seen_dot = false;
    while end < bytes.len() {
        match bytes[end] {
            b'0'..=b'9' => end += 1,
            b'.' if dot && !seen_dot => {
                seen_dot = true;
                end += 1;
            }
            _ => break,
        }
    }
    &t[..end]
}

// ---------------------------------------------------------------------------
// Instruction helpers (used by the derive pass)
// ---------------------------------------------------------------------------

/// OBJNAM label format of the instruction's text command: `TE('fmt','OBJNAM',…)`
/// keeps its format string, a plain `TX(OBJNAM,…)` is the identity format.
/// `None` when the instruction draws no OBJNAM text.
pub fn objnam_format(instruction: &str) -> Option<&str> {
    if let Some(i) = instruction.find("TE('") {
        let rest = &instruction[i + 4..];
        let end = rest.find('\'')?;
        if rest[end..].starts_with("','OBJNAM'") {
            return Some(&rest[..end]);
        }
    }
    if instruction.contains("TX(OBJNAM,") {
        return Some("%s");
    }
    None
}

// ---------------------------------------------------------------------------
// Acquisition (mirrors frontend/tools/s52-sprites and crate::oex::download)
// ---------------------------------------------------------------------------

/// Pinned ochartsng commit the XML files are fetched from — the SAME commit
/// as the sprite tool (`build-sprites.ts UPSTREAM_COMMIT`), so symbol names
/// resolved here always exist in the generated sprite sheet (or are aliased
/// to QUESMRK1 there).
pub const UPSTREAM_COMMIT: &str = "ed3972268a728d2b1a1d3eccd7861ce38efbee02";

/// The lookup-bearing XML files (SymbolPatch*.xml contain no lookups).
const XML_FILES: [&str; 5] = [
    "chartsymbols.xml",
    "LUPPatch1.xml",
    "LUPPatch2.xml",
    "LUPPatch3.xml",
    "LUPPatch4.xml",
];

#[derive(Debug)]
pub enum DataError {
    Io(io::Error),
    Http(String),
}

impl fmt::Display for DataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DataError::Io(e) => write!(f, "I/O error: {e}"),
            DataError::Http(m) => write!(f, "download failed: {m}"),
        }
    }
}

impl std::error::Error for DataError {}

impl From<io::Error> for DataError {
    fn from(e: io::Error) -> Self {
        DataError::Io(e)
    }
}

/// Default cache directory: `<crate>/tools/s57data` (git-ignored, next to
/// the oexserverd cache).
pub fn default_cache_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tools")
        .join("s57data")
}

/// Ensure the lookup XML files exist in `cache_dir`, downloading whatever
/// is missing from the pinned ochartsng commit (temp + rename, like
/// [`crate::oex::download`]). Never called implicitly — only the CLI's
/// explicit `--fetch-s52` reaches this.
pub fn ensure_data(cache_dir: &Path) -> Result<(), DataError> {
    std::fs::create_dir_all(cache_dir)?;
    for file in XML_FILES {
        let dest = cache_dir.join(file);
        if dest.exists() {
            continue;
        }
        let url = format!(
            "https://raw.githubusercontent.com/wellenvogel/ochartsng/{UPSTREAM_COMMIT}/s57data/{file}"
        );
        let mut response = ureq::get(&url)
            .call()
            .map_err(|e| DataError::Http(format!("{file}: {e}")))?;
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .read_to_end(&mut bytes)
            .map_err(DataError::Io)?;
        if bytes.is_empty() {
            return Err(DataError::Http(format!("{file}: empty response")));
        }
        let tmp = cache_dir.join(format!(".{file}.tmp.{}", std::process::id()));
        std::fs::write(&tmp, &bytes)?;
        std::fs::rename(&tmp, &dest)?;
    }
    Ok(())
}

/// Load lookup data from `path`: a single XML file, or a directory holding
/// `chartsymbols.xml` plus optional `*Patch*.xml` overlays (loaded sorted
/// by name after the main file, like `S52Data::init`, S52Data.cpp:233-238).
pub fn load(path: &Path) -> io::Result<S52Data> {
    let mut data = S52Data::default();
    if path.is_file() {
        data.parse_xml(&std::fs::read_to_string(path)?);
        return Ok(data);
    }
    data.parse_xml(&std::fs::read_to_string(path.join("chartsymbols.xml"))?);
    let mut patches: Vec<PathBuf> = std::fs::read_dir(path)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.contains("Patch") && n.ends_with(".xml"))
        })
        .collect();
    patches.sort();
    for patch in patches {
        data.parse_xml(&std::fs::read_to_string(patch)?);
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup_xml(rows: &[(&str, i64, &str, &str, &[&str], &str)]) -> String {
        // (class, rcid, type, table, attcs, instruction)
        let mut out = String::from("<chartsymbols><lookups>");
        for (i, (class, rcid, typ, table, attcs, inst)) in rows.iter().enumerate() {
            out.push_str(&format!(
                r#"<lookup id="{i}" RCID="{rcid}" name="{class}">"#
            ));
            out.push_str(&format!("<type>{typ}</type>"));
            out.push_str("<disp-prio>Hazards</disp-prio>");
            out.push_str(&format!("<table-name>{table}</table-name>"));
            for a in *attcs {
                out.push_str(&format!(r#"<attrib-code index="0">{a}</attrib-code>"#));
            }
            out.push_str(&format!("<instruction>{inst}</instruction>"));
            out.push_str("<display-cat>Standard</display-cat>");
            out.push_str("</lookup>");
        }
        out.push_str("</lookups></chartsymbols>");
        out
    }

    fn data(rows: &[(&str, i64, &str, &str, &[&str], &str)]) -> S52Data {
        let mut d = S52Data::default();
        d.parse_xml(&lookup_xml(rows));
        d
    }

    fn attrs(pairs: &[(&str, AttrValue)]) -> BTreeMap<String, AttrValue> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn scoring_picks_the_most_specific_lup() {
        let d = data(&[
            ("BCNLAT", 1, "Point", "Simplified", &["COLOUR4"], "SY(ONE)"),
            (
                "BCNLAT",
                2,
                "Point",
                "Simplified",
                &["COLOUR4", "BCNSHP1"],
                "SY(TWO)",
            ),
            ("BCNLAT", 3, "Point", "Simplified", &[], "SY(DEF)"),
        ]);
        let a = attrs(&[
            ("COLOUR", AttrValue::StrList(vec!["4".into()])),
            ("BCNSHP", AttrValue::Int(1)),
        ]);
        let lup = d.find_lup(LupTable::Simplified, "BCNLAT", &a).unwrap();
        assert_eq!(lup.instruction, "SY(TWO)");
        assert_eq!(lup.disp_prio, 8);
    }

    #[test]
    fn ties_go_to_file_order_and_no_score_falls_back_to_attributeless() {
        let d = data(&[
            ("X", 1, "Point", "Simplified", &["COLOUR1"], "SY(FIRST)"),
            ("X", 2, "Point", "Simplified", &["BCNSHP1"], "SY(SECOND)"),
            ("X", 3, "Point", "Simplified", &[], "SY(DEF)"),
        ]);
        // both single-attr LUPs match with score 1: first in file order wins
        let a = attrs(&[
            ("COLOUR", AttrValue::StrList(vec!["1".into()])),
            ("BCNSHP", AttrValue::Int(1)),
        ]);
        assert_eq!(
            d.find_lup(LupTable::Simplified, "X", &a)
                .unwrap()
                .instruction,
            "SY(FIRST)"
        );
        // nothing matches -> the attribute-less fallback
        let b = attrs(&[("COLOUR", AttrValue::StrList(vec!["9".into()]))]);
        assert_eq!(
            d.find_lup(LupTable::Simplified, "X", &b)
                .unwrap()
                .instruction,
            "SY(DEF)"
        );
        // an attribute-less *object* also falls back (attributeMatch returns 0)
        assert_eq!(
            d.find_lup(LupTable::Simplified, "X", &attrs(&[]))
                .unwrap()
                .instruction,
            "SY(DEF)"
        );
        // unknown class -> None
        assert!(d.find_lup(LupTable::Simplified, "Y", &a).is_none());
        // wrong table -> None
        assert!(d.find_lup(LupTable::PaperChart, "X", &a).is_none());
    }

    #[test]
    fn list_attributes_compare_by_exact_raw_string() {
        let d = data(&[
            (
                "X",
                1,
                "Point",
                "Simplified",
                &["COLOUR3,4,3"],
                "SY(STRIPED)",
            ),
            ("X", 2, "Point", "Simplified", &["COLOUR3"], "SY(RED)"),
            ("X", 3, "Point", "Simplified", &[], "SY(DEF)"),
        ]);
        let striped = attrs(&[(
            "COLOUR",
            AttrValue::StrList(vec!["3".into(), "4".into(), "3".into()]),
        )]);
        assert_eq!(
            d.find_lup(LupTable::Simplified, "X", &striped)
                .unwrap()
                .instruction,
            "SY(STRIPED)"
        );
        // order matters: 4,3,3 is not 3,4,3 and not "3"
        let other = attrs(&[(
            "COLOUR",
            AttrValue::StrList(vec!["4".into(), "3".into(), "3".into()]),
        )]);
        assert_eq!(
            d.find_lup(LupTable::Simplified, "X", &other)
                .unwrap()
                .instruction,
            "SY(DEF)"
        );
        // IntList encodes the same way
        let il = attrs(&[("COLOUR", AttrValue::IntList(vec![3, 4, 3]))]);
        assert_eq!(
            d.find_lup(LupTable::Simplified, "X", &il)
                .unwrap()
                .instruction,
            "SY(STRIPED)"
        );
    }

    #[test]
    fn question_mark_means_must_lack() {
        let d = data(&[
            ("X", 1, "Point", "Simplified", &["CATLAM?"], "SY(NOLAM)"),
            ("X", 2, "Point", "Simplified", &[], "SY(DEF)"),
        ]);
        let without = attrs(&[("COLOUR", AttrValue::Int(3))]);
        assert_eq!(
            d.find_lup(LupTable::Simplified, "X", &without)
                .unwrap()
                .instruction,
            "SY(NOLAM)"
        );
        let with = attrs(&[("CATLAM", AttrValue::Int(1))]);
        assert_eq!(
            d.find_lup(LupTable::Simplified, "X", &with)
                .unwrap()
                .instruction,
            "SY(DEF)"
        );
    }

    #[test]
    fn empty_value_is_a_wildcard_requiring_presence() {
        let d = data(&[
            ("X", 1, "Point", "Simplified", &["VALSOU"], "SY(SND)"),
            ("X", 2, "Point", "Simplified", &[], "SY(DEF)"),
        ]);
        let with = attrs(&[("VALSOU", AttrValue::Float(3.5))]);
        assert_eq!(
            d.find_lup(LupTable::Simplified, "X", &with)
                .unwrap()
                .instruction,
            "SY(SND)"
        );
        let without = attrs(&[("WATLEV", AttrValue::Int(3))]);
        assert_eq!(
            d.find_lup(LupTable::Simplified, "X", &without)
                .unwrap()
                .instruction,
            "SY(DEF)"
        );
    }

    #[test]
    fn numeric_comparison_semantics() {
        // int: exact (atoi); float: 1e-6 tolerance (atof)
        assert!(attr_equals(&AttrValue::Int(7), "7"));
        assert!(!attr_equals(&AttrValue::Int(7), "8"));
        assert!(attr_equals(&AttrValue::Float(20.0), "20"));
        assert!(attr_equals(&AttrValue::Float(20.0000005), "20"));
        assert!(!attr_equals(&AttrValue::Float(20.01), "20"));
        // string values on string attributes compare exactly
        assert!(attr_equals(
            &AttrValue::Str("triangle, point up|TR".into()),
            "triangle, point up|TR"
        ));
        // wildcard / must-lack
        assert!(attr_equals(&AttrValue::Int(7), ""));
        assert!(attr_equals(&AttrValue::Int(7), " "));
        assert!(!attr_equals(&AttrValue::Int(7), "?"));
    }

    #[test]
    fn patch_lookup_replaces_by_rcid() {
        let mut d = data(&[
            ("X", 1, "Point", "Simplified", &["COLOUR1"], "SY(OLD)"),
            ("X", 2, "Point", "Simplified", &[], "SY(DEF)"),
        ]);
        d.parse_xml(&lookup_xml(&[(
            "X",
            1,
            "Point",
            "Simplified",
            &["COLOUR1"],
            "SY(NEW)",
        )]));
        assert_eq!(d.len(), 2);
        let a = attrs(&[("COLOUR", AttrValue::StrList(vec!["1".into()]))]);
        assert_eq!(
            d.find_lup(LupTable::Simplified, "X", &a)
                .unwrap()
                .instruction,
            "SY(NEW)"
        );
    }

    #[test]
    fn attc_parses_as_six_char_name_plus_value() {
        // string-valued ATTC with commas and spaces (real row in the xml)
        let d = data(&[(
            "TOPMAR",
            9,
            "Point",
            "Paper",
            &["COLOUR3", "INFORMtriangle, point up|TR"],
            "SY(TOPSHP20)",
        )]);
        let lup = &d.lups[&(LupTable::PaperChart, "TOPMAR".to_string())][0];
        assert_eq!(
            lup.attcs,
            vec![
                ("COLOUR".to_string(), "3".to_string()),
                ("INFORM".to_string(), "triangle, point up|TR".to_string()),
            ]
        );
        let a = attrs(&[
            ("COLOUR", AttrValue::StrList(vec!["3".into()])),
            ("INFORM", AttrValue::Str("triangle, point up|TR".into())),
        ]);
        assert_eq!(
            d.find_lup(LupTable::PaperChart, "TOPMAR", &a)
                .unwrap()
                .instruction,
            "SY(TOPSHP20)"
        );
    }

    #[test]
    fn instruction_helpers() {
        assert_eq!(
            objnam_format("SY(X);TE('bn %s','OBJNAM',2,1,2,'15110',-1,-1,CHBLK,21)"),
            Some("bn %s")
        );
        assert_eq!(
            objnam_format("SY(X);TX(OBJNAM,3,2,2,'1508',1,-1,CHBLK,26)"),
            Some("%s")
        );
        assert_eq!(objnam_format("SY(X)"), None);
        // TE on a non-OBJNAM attribute is not a label
        assert_eq!(
            objnam_format("TE('%s','INFORM',2,1,2,'15110',-1,-1,CHBLK,21)"),
            None
        );
    }
}
