// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Typed S-57 attribute values.

/// A single S-57 feature attribute value. List variants (COLOUR, CATLIT…)
/// must stay lists — MVT list-encoding is decided downstream, not here.
/// OGR's S-57 driver reports enum-lists as *string* lists (e.g. `["4"]`).
#[derive(Debug, Clone, PartialEq)]
pub enum AttrValue {
    Int(i64),
    Float(f64),
    Str(String),
    /// Derived flags only (`catlnd_marsh`, …) — raw S-57 has no boolean
    /// type, so decoders never produce this variant.
    Bool(bool),
    IntList(Vec<i64>),
    FloatList(Vec<f64>),
    StrList(Vec<String>),
}

impl AttrValue {
    pub fn as_int(&self) -> Option<i64> {
        match self {
            AttrValue::Int(v) => Some(*v),
            _ => None,
        }
    }

    /// Integers are widened to float.
    pub fn as_float(&self) -> Option<f64> {
        match self {
            AttrValue::Float(v) => Some(*v),
            AttrValue::Int(v) => Some(*v as f64),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            AttrValue::Str(v) => Some(v),
            _ => None,
        }
    }

    pub fn is_list(&self) -> bool {
        matches!(
            self,
            AttrValue::IntList(_) | AttrValue::FloatList(_) | AttrValue::StrList(_)
        )
    }

    /// Enum lists arrive from OGR as string lists of numeric codes; this
    /// parses those too. Non-numeric elements are dropped.
    pub fn as_int_list(&self) -> Option<Vec<i64>> {
        match self {
            AttrValue::IntList(v) => Some(v.clone()),
            AttrValue::StrList(v) => Some(v.iter().filter_map(|s| s.trim().parse().ok()).collect()),
            AttrValue::FloatList(v) => Some(v.iter().map(|f| *f as i64).collect()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accessors() {
        assert_eq!(AttrValue::Int(42).as_int(), Some(42));
        assert_eq!(AttrValue::Int(42).as_float(), Some(42.0));
        assert_eq!(AttrValue::Float(1.5).as_float(), Some(1.5));
        assert_eq!(AttrValue::Float(1.5).as_int(), None);
        assert_eq!(AttrValue::Str("x".into()).as_str(), Some("x"));
        assert!(!AttrValue::Int(1).is_list());
    }

    #[test]
    fn int_list_from_any_list_variant() {
        assert!(AttrValue::StrList(vec![]).is_list());
        assert_eq!(
            AttrValue::StrList(vec!["4".into(), "6".into()]).as_int_list(),
            Some(vec![4, 6])
        );
        assert_eq!(
            AttrValue::IntList(vec![1, 2]).as_int_list(),
            Some(vec![1, 2])
        );
        assert_eq!(AttrValue::Int(4).as_int_list(), None);
    }
}
