// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! On-demand tiling: CellTiler vs build_tileset on a real ENC cell, and
//! the RAM-only OSENC → derive → tile pipeline.

use chartcore::coords::LLBox;
use chartcore::mvt::{decode::decode_tile, zoom_range_for_scale, CellTiler};
use chartcore::osenc::write::{reference_point, sm, RawTuple, SencWriter};
// The `.000`-cell half of this file needs the GDAL-backed reader; gated so
// the default (gdal-free) build still runs the pure-Rust OSENC pipeline test
// below — the o-charts path the Pi actually serves. See the `s57-ingest`
// feature in Cargo.toml.
#[cfg(feature = "s57-ingest")]
use chartcore::mvt::build_tileset;
#[cfg(feature = "s57-ingest")]
use chartcore::mvt::{drop_scamin_hidden_tile, ScaminBias};
#[cfg(feature = "s57-ingest")]
use chartcore::s57::{read_cell, S57OpenOptions};

#[cfg(feature = "s57-ingest")]
fn fixture_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/US5OAKIQ.000")
}

/// Every tile the batch path builds for the NOAA fixture cell must come
/// out of the on-demand cutter byte-identical — the o-charts serving path
/// may not depend on which pipeline produced a tile.
///
/// Both paths now finalize the tile with the same server-side SCAMIN drop
/// (`build_tileset` bakes it in; the serve path applies `drop_scamin_hidden_tile`
/// to the single-cell cut), so the comparison finalizes the raw cut the same
/// way. The drop is byte-identical because both feed it the same raw cut bytes.
#[cfg(feature = "s57-ingest")]
#[test]
fn cut_matches_build_tileset_on_real_cell() {
    let mut cell = read_cell(&fixture_path(), &S57OpenOptions::default()).expect("fixture reads");
    chartcore::derive::apply(&mut cell);
    let (_, max_zoom) = zoom_range_for_scale(cell.meta.compilation_scale);
    // two zooms are plenty: max (most tiles) and a coarse one
    let min_zoom = max_zoom.saturating_sub(4);
    let ts = build_tileset(&cell, min_zoom, max_zoom);
    assert!(!ts.tiles.is_empty());
    let tiler = CellTiler::new(cell.clone());
    for ((z, x, y), bytes) in &ts.tiles {
        if *z != min_zoom && *z != max_zoom {
            continue;
        }
        let served = tiler
            .cut(*z, *x, *y)
            .map(|c| drop_scamin_hidden_tile(&c, *z, max_zoom, ScaminBias::default()).unwrap());
        assert_eq!(
            served.as_deref(),
            Some(bytes.as_slice()),
            "tile {z}/{x}/{y} differs between build_tileset and CellTiler::cut"
        );
    }
    // neighbors outside the built set are clean misses
    let (z, x, y) = *ts.tiles.keys().next().unwrap();
    for dx in [-3i64, 3] {
        let qx = (x as i64 + dx).rem_euclid(1 << z) as u32;
        if !ts.tiles.contains_key(&(z, qx, y)) {
            assert_eq!(tiler.cut(z, qx, y), None);
        }
    }
}

/// The o-charts serving chain end-to-end, all in RAM: synthetic OSENC
/// bytes → decoder → derive pass → single-tile cut → MVT decode.
#[test]
fn osenc_stream_to_tile_in_ram() {
    let ll = LLBox {
        n_lat: 54.60,
        s_lat: 54.50,
        w_lon: 9.00,
        e_lon: 9.10,
    };
    let rp = reference_point(&ll);
    let ring: Vec<(f32, f32)> = [(54.58, 9.02), (54.58, 9.08), (54.52, 9.08), (54.52, 9.02)]
        .iter()
        .map(|&(la, lo)| sm(la, lo, rp, 1.0))
        .collect();

    let mut w = SencWriter::new();
    w.version(201)
        .cell_name("SYNTH1")
        .cell_edition(1)
        .extent(&ll)
        .native_scale(12000)
        .feature(42, 1, 3) // DEPARE
        .attr_double(87, 2.0) // DRVAL1
        .attr_double(88, 5.0) // DRVAL2
        .area_geometry(&ll, &[], &[RawTuple::forward(1)], 4, None)
        .edge_table(&[(1, ring)], None)
        .feature(129, 2, 1) // SOUNDG
        .multipoint(&ll, &{
            let (e, n) = sm(54.55, 9.05, rp, 1.0);
            vec![(e, n, 7.5)]
        });
    let bytes = w.into_bytes();

    let mut cell = chartcore::osenc::read_cell(&bytes[..]).expect("osenc decodes");
    assert_eq!(cell.meta.name, "SYNTH1");
    chartcore::derive::apply(&mut cell);

    let tiler = CellTiler::new(cell.clone());
    let (_, max_zoom) = zoom_range_for_scale(cell.meta.compilation_scale);
    // the tile containing the cell center at max zoom
    let center = chartcore::coords::lat_lon_to_world(54.55, 9.05);
    let t = chartcore::coords::world_point_to_tile(center, max_zoom as u32);
    let tile = tiler
        .cut(max_zoom, t.x as u32, t.y as u32)
        .expect("center tile has content");
    let decoded = decode_tile(&tile).expect("valid MVT");
    let depare = decoded.layer("DEPARE").expect("DEPARE layer");
    assert_eq!(depare.features.len(), 1);
    let soundg = decoded.layer("SOUNDG").expect("SOUNDG layer");
    assert_eq!(soundg.features.len(), 1);
    assert!(
        soundg.features[0].tags.iter().any(|(k, _)| k == "DEPTH"),
        "sounding carries DEPTH"
    );
}
