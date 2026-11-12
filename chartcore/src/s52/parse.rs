// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Targeted `<lookup>` parser for `chartsymbols.xml` (machine-generated,
//! stable formatting) — port of `S52Symbols::ProcessLookups`
//! (`provider/src/s52/S52Symbols.cpp:124-237`).

use super::{Lup, LupTable, S52Data};

/// Parse every `<lookup>` element in `xml` into `data`.
pub fn parse_lookups(xml: &str, data: &mut S52Data) {
    let mut rest = xml;
    while let Some(start) = rest.find("<lookup ") {
        let Some(end) = rest[start..].find("</lookup>") else {
            break;
        };
        let block = &rest[start..start + end];
        rest = &rest[start + end + "</lookup>".len()..];
        if let Some(lup) = parse_lookup(block) {
            data.add_lup(lup);
        }
    }
}

fn parse_lookup(block: &str) -> Option<Lup> {
    let head_end = block.find('>')?;
    let head = &block[..head_end];
    let rcid: i64 = xml_attr(head, "RCID")?.parse().ok()?;
    let class = xml_attr(head, "name")?.to_string();
    let body = &block[head_end + 1..];

    let table = match tag_text(body, "table-name").unwrap_or_default().as_str() {
        "Simplified" => LupTable::Simplified,
        "Lines" => LupTable::Lines,
        "Plain" => LupTable::PlainBoundaries,
        "Symbolized" => LupTable::SymbolizedBoundaries,
        _ => LupTable::PaperChart,
    };
    // S52Symbols.cpp:154-175 name -> S52Types.h DisplayPriority ordinal
    let disp_prio = match tag_text(body, "disp-prio").unwrap_or_default().as_str() {
        "Group 1" => 1,
        "Area 1" => 2,
        "Area 2" => 3,
        "Point Symbol" => 4,
        "Line Symbol" => 5,
        "Area Symbol" => 6,
        "Routing" => 7,
        "Hazards" => 8,
        "Mariners" => 9,
        _ => 0,
    };
    let display_cat = match tag_text(body, "display-cat").unwrap_or_default().as_str() {
        "Displaybase" => "displaybase",
        "Standard" => "standard",
        "Mariners" => "mariners",
        _ => "other",
    }
    .to_string();
    let instruction = tag_text(body, "instruction").unwrap_or_default();

    // repeated attrib-code children, in document order; the first 6 chars
    // are the attribute acronym, the rest the value; duplicates collapse
    // (last wins — the reference stores a map keyed by attribute id)
    let mut attcs: Vec<(String, String)> = Vec::new();
    let mut rest = body;
    while let Some(i) = rest.find("<attrib-code") {
        let after = &rest[i..];
        let Some(gt) = after.find('>') else { break };
        let Some(close) = after.find("</attrib-code>") else {
            break;
        };
        let text = decode_entities(&after[gt + 1..close]);
        rest = &after[close + "</attrib-code>".len()..];
        if text.len() < 6 {
            return None; // invalid LUP attribute: the reference drops the rule
        }
        let (name, value) = text.split_at(6);
        attcs.retain(|(n, _)| n != name);
        attcs.push((name.to_string(), value.to_string()));
    }

    Some(Lup {
        rcid,
        class,
        table,
        attcs,
        instruction,
        disp_prio,
        display_cat,
    })
}

/// `attr="value"` in an element head.
fn xml_attr<'a>(head: &'a str, attr: &str) -> Option<&'a str> {
    let pat = format!("{attr}=\"");
    let start = head.find(&pat)? + pat.len();
    let end = head[start..].find('"')?;
    Some(&head[start..start + end])
}

/// Text content of the first `<tag>…</tag>` child.
fn tag_text(body: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = body.find(&open)? + open.len();
    let end = body[start..].find(&close)?;
    Some(decode_entities(&body[start..start + end]))
}

/// The five predefined XML entities (the only ones the file can contain).
fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_real_lookup_block() {
        let xml = r#"<chartsymbols><lookups>
      <lookup id="12705" RCID="31541" name="BCNLAT">
        <type>Point</type>
        <disp-prio>Hazards</disp-prio>
        <radar-prio>On Top</radar-prio>
        <table-name>Simplified</table-name>
        <attrib-code index="0">BCNSHP1</attrib-code>
        <instruction>SY(BCNSTK02);TE('%s','OBJNAM',2,1,2,'15110',-1,-1,CHBLK,21)</instruction>
        <display-cat>Standard</display-cat>
        <comment>17020</comment>
      </lookup>
    </lookups></chartsymbols>"#;
        let mut d = S52Data::default();
        parse_lookups(xml, &mut d);
        assert_eq!(d.len(), 1);
        let lup = d
            .find_lup(
                LupTable::Simplified,
                "BCNLAT",
                &[("BCNSHP".to_string(), crate::model::AttrValue::Int(1))]
                    .into_iter()
                    .collect(),
            )
            .unwrap();
        assert_eq!(lup.rcid, 31541);
        assert_eq!(lup.attcs, vec![("BCNSHP".to_string(), "1".to_string())]);
        assert!(lup.instruction.starts_with("SY(BCNSTK02);TE('%s'"));
        assert_eq!(lup.disp_prio, 8);
        assert_eq!(lup.display_cat, "standard");
    }

    #[test]
    fn unknown_table_defaults_to_paper_and_priorities_map() {
        let xml = r#"<lookup id="1" RCID="7" name="X"><type>Point</type>
            <disp-prio>Routing</disp-prio><table-name>Paper</table-name>
            <instruction></instruction><display-cat>Displaybase</display-cat></lookup>"#;
        let mut d = S52Data::default();
        parse_lookups(xml, &mut d);
        let lup = d
            .find_lup(LupTable::PaperChart, "X", &Default::default())
            .unwrap();
        assert_eq!(lup.disp_prio, 7);
        assert_eq!(lup.display_cat, "displaybase");
        assert!(lup.instruction.is_empty());
    }

    #[test]
    fn entities_decode() {
        assert_eq!(decode_entities("a&amp;b&lt;c&gt;&quot;&apos;"), "a&b<c>\"'");
        assert_eq!(decode_entities("plain"), "plain");
    }
}
