// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! The icon ROLE VOCABULARY and the sentinel hexes that carry it.
//!
//! See docs/architecture/icon-role-sentinels.md for the contract with
//! `assets/s52-icons/icon-roles.json` and the backend theme JSON, and for
//! why sentinels exist at all instead of CSS classes.

/// One entry of the vocabulary. `day` is what a round-trip substitution
/// must restore.
pub struct Role {
    pub name: &'static str,
    pub sentinel: &'static str,
    pub day: &'static str,
}

/// `icon-roles.json`'s `sentinel_prefix`. No real artwork hex collides with
/// the `#fe00XX` block.
pub const SENTINEL_PREFIX: &str = "#fe00";

/// The vocabulary, in `icon-roles.json` order. Kept as an aligned table
/// (rustfmt off) so it diffs one-to-one against the JSON it mirrors.
#[rustfmt::skip]
pub const ROLES: &[Role] = &[
    Role { name: "obj-white",       sentinel: "#fe0000",  day: "#ffffff"   },
    Role { name: "obj-black",       sentinel: "#fe0001",  day: "#000000"   },
    Role { name: "obj-red",         sentinel: "#fe0002",  day: "#ed1c24"   },
    Role { name: "obj-green",       sentinel: "#fe0003",  day: "#00a650"   },
    Role { name: "obj-blue",        sentinel: "#fe0004",  day: "#10508c"   },
    Role { name: "obj-yellow",      sentinel: "#fe0005",  day: "#fab20b"   },
    Role { name: "obj-grey",        sentinel: "#fe0006",  day: "#808080"   },
    Role { name: "obj-brown",       sentinel: "#fe0007",  day: "#a52a2a"   },
    Role { name: "obj-amber",       sentinel: "#fe0008",  day: "#ffbf00"   },
    Role { name: "obj-violet",      sentinel: "#fe0009",  day: "#ee82ee"   },
    Role { name: "obj-orange",      sentinel: "#fe000a",  day: "#f7a837"   },
    Role { name: "obj-magenta",     sentinel: "#fe000b",  day: "#ec008c"   },
    Role { name: "obj-pink",        sentinel: "#fe000c",  day: "#ffc0cb"   },
    Role { name: "lit-generic",     sentinel: "#fe000d",  day: "#800080"   },
    Role { name: "lit-white",       sentinel: "#fe000e",  day: "#fab20b"   },
    Role { name: "lit-red",         sentinel: "#fe000f",  day: "#ed1c24"   },
    Role { name: "lit-green",       sentinel: "#fe0010",  day: "#00a650"   },
    Role { name: "lit-blue",        sentinel: "#fe0011",  day: "#10508c"   },
    Role { name: "lit-yellow",      sentinel: "#fe0012",  day: "#fab20b"   },
    Role { name: "lit-orange",      sentinel: "#fe0013",  day: "#fa870b"   },
    Role { name: "lit-amber",       sentinel: "#fe0014",  day: "#ffbf00"   },
    Role { name: "ink",             sentinel: "#fe0015",  day: "#000000"   },
    Role { name: "paper",           sentinel: "#fe0016",  day: "#ffffff"   },
    Role { name: "art-ink",         sentinel: "#fe0017",  day: "#231f20"   },
    Role { name: "art-black",       sentinel: "#fe0018",  day: "#1a1a1a"   },
    Role { name: "art-grey-dark",   sentinel: "#fe0019",  day: "#505050"   },
    Role { name: "art-grey-mid",    sentinel: "#fe001a",  day: "#666666"   },
    Role { name: "art-grey-light",  sentinel: "#fe001b",  day: "#d1d1d1"   },
    Role { name: "art-grey-pale",   sentinel: "#fe001c",  day: "#eeeeee"   },
    Role { name: "warn-magenta",    sentinel: "#fe001d",  day: "#ec008c"   },
    Role { name: "art-green",       sentinel: "#fe001e",  day: "#2ea948"   },
    Role { name: "art-green-deep",  sentinel: "#fe001f",  day: "#2e8e20"   },
    Role { name: "art-blue-pale",   sentinel: "#fe0020",  day: "#afcce3"   },
    Role { name: "art-violet",      sentinel: "#fe0021",  day: "#de44e8"   },
    Role { name: "art-stroke",      sentinel: "#fe0022",  day: "#333333"   },
];

/// The sentinel for `name`, or `None` if the vocabulary has no such role.
pub fn sentinel(name: &str) -> Option<&'static str> {
    ROLES.iter().find(|r| r.name == name).map(|r| r.sentinel)
}

/// The `day` hex a sentinel substitutes back to — the inverse of
/// [`sentinel`], and what the round-trip acceptance test uses.
pub fn day_for_sentinel(sentinel: &str) -> Option<&'static str> {
    ROLES.iter().find(|r| r.sentinel == sentinel).map(|r| r.day)
}

/// `.outline`/`.baseline`/`.basepoint` stroke; outline of every parametric buoy.
pub const INK: &str = "#fe0015";
/// `.basepoint` fill — the disc a buoy body sits on.
pub const PAPER: &str = "#fe0016";
/// `palette::VENDORED_WARNING_MAGENTA`'s role. `resolve_literal`'s per-feature
/// `,RRGGBB` override also lands on this sentinel, not the day hex, so a
/// caller-supplied colour (e.g. `#808080`, `obj-grey`'s day value) is never mistaken for a role.
pub const WARN_MAGENTA: &str = "#fe001d";

/// The sentinel for an S-57 `COLOUR` word (`palette::OBJECT_COLOURS`).
pub fn object_colour(word: &str) -> Option<&'static str> {
    role_for_prefixed("obj-", word)
}

/// Only `"generic"` reaches this in practice — every other word also exists
/// in `OBJECT_COLOURS`, which `recolor_variant` consults first. See
/// docs/architecture/icon-role-sentinels.md.
pub fn light_colour(word: &str) -> Option<&'static str> {
    role_for_prefixed("lit-", word)
}

fn role_for_prefixed(prefix: &str, word: &str) -> Option<&'static str> {
    ROLES
        .iter()
        .find(|r| {
            r.name
                .strip_prefix(prefix)
                .is_some_and(|suffix| suffix.eq_ignore_ascii_case(word))
        })
        .map(|r| r.sentinel)
}

/// Rendered hex -> role, for colour baked into the vendored asset text (not
/// `recolor.rs`'s generated stylesheet); applied after `usvg` normalisation.
/// Ambiguity resolution and editor-metadata greys: docs/architecture/icon-role-sentinels.md.
pub const ASSET_HEXES: &[(&str, &str)] = &[
    ("#000000", "ink"),
    ("#ffffff", "paper"),
    ("#ec008c", "warn-magenta"),
    ("#ed1c24", "obj-red"),
    ("#00a650", "obj-green"),
    ("#fab20b", "obj-yellow"),
    ("#333333", "art-stroke"),
    ("#231f20", "art-ink"),
    ("#1a1a1a", "art-black"),
    ("#2ea948", "art-green"),
    ("#2e8e20", "art-green-deep"),
    ("#afcce3", "art-blue-pale"),
    ("#de44e8", "art-violet"),
    // FAIRWY51/52 only: CHGRD has no role, so mapped to the nearest one
    // that does (obj-grey), measured better than ink — see the doc above.
    ("#808080", "obj-grey"),
    // Editor metadata only — see the doc above.
    ("#505050", "art-grey-dark"),
    ("#666666", "art-grey-mid"),
    ("#d1d1d1", "art-grey-light"),
    ("#eeeeee", "art-grey-pale"),
];

/// Every painted hex in `svg` with an [`ASSET_HEXES`] role, replaced by its
/// sentinel — a plain string substitution; rendered output is verified to
/// use only `#rrggbb` notation, so this reaches every painted value.
pub fn substitute_asset_hexes(svg: &str) -> String {
    let mut out = svg.to_string();
    for (hex, role) in ASSET_HEXES {
        if !out.contains(hex) {
            continue;
        }
        let s = sentinel(role).unwrap_or_else(|| panic!("no such role: {role}"));
        out = out.replace(hex, s);
    }
    out
}

/// Every sentinel in `svg` replaced by its `day` hex — inverse of what this
/// module emits. Exposed (not test-only): also the reference implementation
/// of a client's palette substitution.
pub fn substitute_to_day(svg: &str) -> String {
    let mut out = svg.to_string();
    for r in ROLES {
        if out.contains(r.sentinel) {
            out = out.replace(r.sentinel, r.day);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: &str = include_str!("../../assets/s52-icons/icon-roles.json");

    /// `"key": "value"` on one line — enough for `icon-roles.json`, whose
    /// role entries are strictly one per line.
    fn field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
        let needle = format!("\"{key}\":");
        let rest = line.split(&needle).nth(1)?;
        let start = rest.find('"')? + 1;
        let end = rest[start..].find('"')? + start;
        Some(&rest[start..end])
    }

    /// The JSON's `roles` block, as `(name, index, day)`. Every role entry
    /// is exactly one line and is the only kind of line carrying an
    /// `"index"` field, so no block tracking is needed.
    fn json_roles() -> Vec<(String, String, String)> {
        let mut out = Vec::new();
        for line in JSON.lines() {
            let t = line.trim();
            if !t.contains("\"index\":") {
                continue;
            }
            let name = t.split('"').nth(1).expect("role name").to_string();
            out.push((
                name,
                field(t, "index").expect("index").to_string(),
                field(t, "day").expect("day").to_string(),
            ));
        }
        out
    }

    #[test]
    fn the_rust_table_matches_icon_roles_json() {
        let json = json_roles();
        assert_eq!(
            json.len(),
            ROLES.len(),
            "icon-roles.json has {} roles, ROLES has {}",
            json.len(),
            ROLES.len()
        );
        assert!(
            json.len() >= 35,
            "mini-parser found only {} roles",
            json.len()
        );
        let prefix = field(
            JSON.lines()
                .find(|l| l.contains("\"sentinel_prefix\""))
                .expect("sentinel_prefix"),
            "sentinel_prefix",
        )
        .expect("sentinel_prefix value");
        assert_eq!(prefix, SENTINEL_PREFIX);

        for ((name, index, day), r) in json.iter().zip(ROLES) {
            assert_eq!(name, r.name, "role order drifted");
            assert_eq!(
                format!("{SENTINEL_PREFIX}{index}"),
                r.sentinel,
                "{name}: sentinel"
            );
            assert_eq!(day, r.day, "{name}: day hex");
        }
    }

    #[test]
    fn sentinels_are_unique_and_inside_the_reserved_block() {
        let mut seen = std::collections::BTreeSet::new();
        for r in ROLES {
            assert!(
                r.sentinel.starts_with(SENTINEL_PREFIX) && r.sentinel.len() == 7,
                "{}: {} is not a #fe00XX sentinel",
                r.name,
                r.sentinel
            );
            assert!(seen.insert(r.sentinel), "duplicate sentinel {}", r.sentinel);
        }
    }

    #[test]
    fn every_object_and_light_colour_word_has_a_role() {
        use crate::icons::palette;
        for (_, word, _) in palette::OBJECT_COLOURS {
            assert!(object_colour(word).is_some(), "no obj-{word} role");
        }
        for (word, _) in palette::LIGHT_COLOURS {
            assert!(light_colour(word).is_some(), "no lit-{word} role");
        }
    }

    /// Every role's `day` must be exactly the hex the corresponding table
    /// entry paints today — the vocabulary is only useful if a substituted
    /// day icon is byte-identical to a baked one.
    #[test]
    fn role_day_values_match_the_palette_tables_they_came_from() {
        use crate::icons::palette;
        for (_, word, hex) in palette::OBJECT_COLOURS {
            let s = object_colour(word).unwrap();
            assert_eq!(
                day_for_sentinel(s).unwrap(),
                hex.to_lowercase(),
                "obj-{word}"
            );
        }
        for (word, hex) in palette::LIGHT_COLOURS {
            let s = light_colour(word).unwrap();
            assert_eq!(
                day_for_sentinel(s).unwrap(),
                hex.to_lowercase(),
                "lit-{word}"
            );
        }
        assert_eq!(day_for_sentinel(INK).unwrap(), "#000000");
        assert_eq!(day_for_sentinel(PAPER).unwrap(), "#ffffff");
        assert_eq!(
            day_for_sentinel(WARN_MAGENTA).unwrap(),
            palette::VENDORED_WARNING_MAGENTA
        );
    }

    /// Every [`ASSET_HEXES`] entry must name a real role, and must map to a
    /// role whose `day` value is that very hex — otherwise substituting the
    /// sentinel back would not restore the day icon.
    #[test]
    fn the_asset_hex_table_round_trips_through_its_own_roles() {
        let mut seen = std::collections::BTreeSet::new();
        for (hex, role) in ASSET_HEXES {
            assert!(seen.insert(*hex), "{hex} mapped twice");
            let s = sentinel(role).unwrap_or_else(|| panic!("no such role: {role}"));
            assert_eq!(day_for_sentinel(s).unwrap(), *hex, "{role}");
        }
    }
}
