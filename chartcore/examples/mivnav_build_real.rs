// Build a real national `.mivnav` over an installed chart set and report
// §20's "record per run" plus wall-clock — the measurement behind
// `MIVNAV_NEXT_TASKS.md`'s "make a national build tractable" task and its
// "Done when" (file size, tiles-per-rung, portal/shortcut counts).
//
//   cargo run --release --example mivnav_build_real -- <dir-of-.senc> [out.mivnav]
//
// Default dir: backend/data/ocharts/fnc-de-2026-08-30 (the 314-cell CC0
// FNC-DE set `POST /ocharts/fnc/install {"region":"de"}` lays down).
//
// Env knobs:
//   MIVNAV_LOAD_ONLY=1        with an out path: time only the read path
//   MIVNAV_BUILD_BANDS=1      run the band pass without writing a file
//   MIVNAV_BAND_PROFILE[=<i>] time each of one band's four build steps
//                             separately (`label_band` / `detect_portals`
//                             / `build_shortcuts` / `build_band_landmarks`)
//                             — which step is the single-threaded pole
//   MIVNAV_CATZOC=<mode>      off|half|depth_only|full — match the
//                             backend's `artifact_catzoc_allowance_mode`
//                             (default here: off)

use std::path::PathBuf;
use std::time::Instant;

use chartcore::coords::Extent;
use chartcore::mivnav::{
    build_all_bands_reporting, build_band_landmarks, build_directional_semantics, build_region,
    build_shortcuts, detect_portals, label_band, load_band, load_region, publish_region_streaming,
    region_hazard_rings, ArtifactReader, ChartSetIdentity, BAND_LADDER_M,
};
use chartcore::model::Cell;
use chartcore::osenc;
use chartcore::routing::artifact::CatzocMode;

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = args
        .next()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../backend/data/ocharts/fnc-de-2026-08-30")
        });
    let out = args.next().filter(|s| !s.is_empty()).map(PathBuf::from);

    // `MIVNAV_LOAD_ONLY=1` with an existing out path: skip the build,
    // just time `ArtifactReader::from_file` + `load_region` + `load_band`
    // — the per-request cost the artifact-cache go/no-go weighs against a
    // per-request rebuild (`MIVNAV_NEXT_TASKS.md` / `MIVNAV_ARTIFACT_TODO.md`).
    if std::env::var_os("MIVNAV_LOAD_ONLY").is_some() {
        let path = out
            .as_deref()
            .expect("MIVNAV_LOAD_ONLY needs an artifact path");
        let sz = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let t = Instant::now();
        let reader = ArtifactReader::from_file(path).expect("open artifact");
        let d_open = t.elapsed();
        let t = Instant::now();
        let built = load_region(&reader).expect("load region");
        let d_region = t.elapsed();
        let t = Instant::now();
        let band = load_band(&reader, &built, 0).expect("load band 0");
        let d_band = t.elapsed();
        println!(
            "load {} ({:.1} MB):  from_file {:.2}s  |  load_region {:.2}s ({} cells)  |  load_band(0) {:.2}s ({} portals, {} shortcuts)",
            path.display(),
            sz as f64 / 1e6,
            d_open.as_secs_f64(),
            d_region.as_secs_f64(),
            built.depth_min.len(),
            d_band.as_secs_f64(),
            band.portals.len(),
            band.shortcuts.len(),
        );
        println!(
            "TOTAL load (from_file + region + one band): {:.2}s",
            (d_open + d_region + d_band).as_secs_f64()
        );
        return;
    }
    // Band topology is `O(bands x region cells)` and 10x the peak RSS of
    // build_region — skip it unless asked, so the region-phase profile
    // can be taken on a memory-limited box.
    let do_bands = std::env::var_os("MIVNAV_BUILD_BANDS").is_some() || out.is_some();

    // `osenc::read_cell` parses SENC only — raw ISO 8211 `.S57`/`.000`
    // needs the `s57-ingest` GDAL path this example does not link.
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            matches!(
                p.extension().and_then(|s| s.to_str()),
                Some("senc" | "osenc")
            )
        })
        .collect();
    paths.sort();
    assert!(
        !paths.is_empty(),
        "no .senc/.osenc cells in {} — this example reads SENC only, not raw .S57/.000",
        dir.display()
    );
    println!("{} cell files in {}", paths.len(), dir.display());

    let t_dec = Instant::now();
    let mut cells: Vec<Cell> = Vec::new();
    for p in &paths {
        let f = std::fs::File::open(p).expect("cell reads");
        match osenc::read_cell(f) {
            Ok(mut c) => {
                chartcore::derive::apply(&mut c);
                cells.push(c);
            }
            Err(e) => eprintln!("skip {}: {e:?}", p.file_name().unwrap().to_string_lossy()),
        }
    }
    println!(
        "decoded {} cells in {:.1}s",
        cells.len(),
        t_dec.elapsed().as_secs_f64()
    );

    let mut region = Extent::invalid();
    for c in &cells {
        region.extend(&c.extent);
    }
    assert!(region.valid, "no usable cell extent");
    println!(
        "region {} x {} world units",
        region.xmax - region.xmin,
        region.ymax - region.ymin
    );

    // `MIVNAV_CATZOC=off|half|depth_only|full` — the build-time survey-
    // confidence policy the backend picks from `RoutingConfig.
    // artifact_catzoc_allowance_mode` (default `full`). It changes which
    // cells `build_region` keeps and how it unions them, so measurements
    // here are only comparable to the backend at the SAME mode.
    let catzoc = std::env::var("MIVNAV_CATZOC")
        .ok()
        .map(|s| CatzocMode::parse(&s))
        .unwrap_or(CatzocMode::Off);
    println!("CATZOC mode: {catzoc:?}");

    let t_reg = Instant::now();
    let built = build_region(&cells, region, catzoc);
    let d_reg = t_reg.elapsed();
    let raster_cells: u64 = built
        .tiles
        .iter()
        .map(|t| t.cols as u64 * t.rows as u64)
        .sum();
    let ladder = chartcore::routing::artifact::ladder::RESOLUTION_LADDER_M;
    let mut per_rung = vec![0u32; ladder.len()];
    for t in &built.tiles {
        per_rung[t.rung as usize] += 1;
    }
    println!(
        "build_region: {:.1}s  |  {} tiles, {} raster cells",
        d_reg.as_secs_f64(),
        built.tiles.len(),
        raster_cells
    );
    println!(
        "  report: {} blocked, {} no-coverage, {} charted-depth, {} vector-required tiles",
        built.report.blocked_cells,
        built.report.no_coverage_cells,
        built.report.charted_depth_cells,
        built.report.vector_required_tiles
    );
    println!("  tiles per rung (0=finest): {per_rung:?}  ladder {ladder:?}");

    // `MIVNAV_BAND_PROFILE[=<band index>]`: time each of the four steps of
    // ONE band's `build_band_topology` separately, so a "which step is the
    // single-threaded long pole" question is answered by measurement, not
    // by reading the code. Default band index 4 (3 m — a mid rung).
    if let Some(v) = std::env::var_os("MIVNAV_BAND_PROFILE") {
        let bi: usize = v
            .to_str()
            .and_then(|s| s.trim().parse().ok())
            .filter(|&i: &usize| i < BAND_LADDER_M.len())
            .unwrap_or(4);
        let band_m = BAND_LADDER_M[bi];
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(0);
        println!("band profile @ rung {bi} ({band_m} m), {threads} cores available:");
        let t = Instant::now();
        let components = label_band(&built, band_m);
        let d_label = t.elapsed();
        let t = Instant::now();
        let portals = detect_portals(&built, &components);
        let d_portals = t.elapsed();
        let t = Instant::now();
        let shortcuts = build_shortcuts(&built, &portals);
        let d_shortcuts = t.elapsed();
        let t = Instant::now();
        let landmarks = build_band_landmarks(&built, &portals);
        let d_landmarks = t.elapsed();
        let total = d_label + d_portals + d_shortcuts + d_landmarks;
        let pct = |d: std::time::Duration| 100.0 * d.as_secs_f64() / total.as_secs_f64().max(1e-9);
        println!(
            "  label_band            {:7.2}s  {:5.1}%   ({} components)",
            d_label.as_secs_f64(),
            pct(d_label),
            components.count
        );
        println!(
            "  detect_portals        {:7.2}s  {:5.1}%   ({} portals)",
            d_portals.as_secs_f64(),
            pct(d_portals),
            portals.len()
        );
        println!(
            "  build_shortcuts       {:7.2}s  {:5.1}%   ({} shortcuts)",
            d_shortcuts.as_secs_f64(),
            pct(d_shortcuts),
            shortcuts.len()
        );
        println!(
            "  build_band_landmarks  {:7.2}s  {:5.1}%",
            d_landmarks.as_secs_f64(),
            pct(d_landmarks),
        );
        let _ = &landmarks;
        println!("  band total            {:7.2}s", total.as_secs_f64());
        return;
    }

    if !do_bands {
        println!("(skipping the band pass — set MIVNAV_BUILD_BANDS=1 or pass an out path)");
        return;
    }

    // Print each band as it finishes — the same `BuildProgress` sink the
    // backend bake job feeds to its progress bar / log.
    struct StderrProgress;
    impl chartcore::mivnav::BuildProgress for StderrProgress {
        fn report(&self, phase: &str, done: u64, total: u64, note: Option<&str>) {
            if let Some(n) = note {
                eprintln!("  [{phase} {done}/{total}] {n}");
            }
        }
    }

    if let Some(out) = out {
        // The path the backend bake job takes: build each band, write it
        // straight into the artifact, drop it — so the ten finished bands
        // are never all resident waiting for the write
        // (`MIVNAV_NEXT_TASKS.md`'s "stream bands to disk" task; measured
        // on FNC-DE: swap thrash gone, ~30 % less wall clock). The region
        // is reused from above — `publish_region_streaming` takes the
        // already-built one, so it is not rebuilt here.
        let hazard_rings = region_hazard_rings(&cells, catzoc);
        let directional = build_directional_semantics(&cells);
        let t_bw = Instant::now();
        let summary = publish_region_streaming(
            &out,
            ChartSetIdentity::new("fnc-de", 1),
            &built,
            &hazard_rings,
            &directional,
            Some(&StderrProgress),
        )
        .expect("build bands + write artifact");
        let d_bw = t_bw.elapsed();
        let sz = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        println!(
            "band pass + write (streamed): {:.1}s  |  {} bands, {} portals, {} shortcuts",
            d_bw.as_secs_f64(),
            summary.bands,
            summary.portals,
            summary.shortcuts
        );
        println!("wrote {} ({:.1} MB)", out.display(), sz as f64 / 1e6);
        println!(
            "TOTAL build (region + streamed bands + write): {:.1}s",
            (d_reg + d_bw).as_secs_f64()
        );
        return;
    }

    // No out path: the in-memory band pass, for profiling the sweep on a
    // box with the RAM to hold all ten bands at once.
    let t_bands = Instant::now();
    let bands = build_all_bands_reporting(&built, Some(&StderrProgress));
    let d_bands = t_bands.elapsed();
    let portals: usize = bands.iter().map(|b| b.portals.len()).sum();
    let shortcuts: usize = bands.iter().map(|b| b.shortcuts.len()).sum();
    println!(
        "build_all_bands: {:.1}s  |  {} bands, {} portals, {} shortcuts",
        d_bands.as_secs_f64(),
        bands.len(),
        portals,
        shortcuts
    );
    println!(
        "TOTAL build (region + bands): {:.1}s",
        (d_reg + d_bands).as_secs_f64()
    );
}
