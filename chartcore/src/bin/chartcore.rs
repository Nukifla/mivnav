// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! `chartcore` CLI — the ingest pipeline as a command. Argument parsing is
//! hand-rolled (a few flags don't justify clap). S-52 data source
//! precedence: docs/architecture/s52-lup-matcher.md

use std::path::PathBuf;
use std::process::ExitCode;

use chartcore::coords::LLBox;
use chartcore::mvt::{build_tileset, zoom_range_for_scale};
use chartcore::pmtiles::{write_archive_to_path, ArchiveInfo};
use chartcore::s52::{self, S52Data};
use chartcore::s57::{read_cell, S57OpenOptions};

const USAGE: &str = "usage: chartcore ingest <cell.000> -o <out.pmtiles> \
                     [--min-zoom N] [--max-zoom N] [--s52-data <path>|none] [--fetch-s52]";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("ingest") => match ingest(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(CliError::Usage(msg)) => {
                eprintln!("error: {msg}\n{USAGE}");
                ExitCode::from(2)
            }
            Err(CliError::Fail(msg)) => {
                eprintln!("error: {msg}");
                ExitCode::FAILURE
            }
        },
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

enum CliError {
    /// Bad invocation (exit 2).
    Usage(String),
    /// Runtime failure (exit 1).
    Fail(String),
}

/// Resolve S-52 lookup data per the module docs' precedence. `None` (with
/// a warning) when no source is available — the documented graceful skip.
fn load_s52(arg: Option<&str>, fetch: bool) -> Result<Option<S52Data>, CliError> {
    let load = |path: &std::path::Path| -> Result<Option<S52Data>, CliError> {
        let data = s52::load(path)
            .map_err(|e| CliError::Fail(format!("loading S-52 data {}: {e}", path.display())))?;
        if data.is_empty() {
            return Err(CliError::Fail(format!("no lookups in {}", path.display())));
        }
        Ok(Some(data))
    };
    match arg {
        Some("none") => return Ok(None),
        Some(path) => return load(std::path::Path::new(path)),
        None => {}
    }
    if let Ok(dir) = std::env::var("MIVNAV_S57DATA") {
        return load(std::path::Path::new(&dir));
    }
    let cache = s52::default_cache_dir();
    if fetch {
        s52::ensure_data(&cache).map_err(|e| CliError::Fail(e.to_string()))?;
    }
    if cache.join("chartsymbols.xml").exists() {
        return load(&cache);
    }
    eprintln!(
        "warning: no S-52 lookup data (set MIVNAV_S57DATA, pass --s52-data, or --fetch-s52); \
         ATON symbols (sym_s) will not be resolved"
    );
    Ok(None)
}

fn zoom_value(value: Option<&String>, name: &str) -> Result<u8, CliError> {
    value
        .ok_or_else(|| CliError::Usage(format!("{name} needs a value")))?
        .parse()
        .map_err(|_| CliError::Usage(format!("{name} needs an integer 0-20")))
}

fn ingest(args: &[String]) -> Result<(), CliError> {
    let usage = |m: &str| CliError::Usage(m.to_string());

    let mut input: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut min_zoom: Option<u8> = None;
    let mut max_zoom: Option<u8> = None;
    let mut s52_arg: Option<String> = None;
    let mut fetch_s52 = false;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-o" | "--output" => {
                let v = it.next().ok_or_else(|| usage("-o needs a path"))?;
                output = Some(PathBuf::from(v));
            }
            "--min-zoom" => min_zoom = Some(zoom_value(it.next(), "--min-zoom")?),
            "--max-zoom" => max_zoom = Some(zoom_value(it.next(), "--max-zoom")?),
            "--s52-data" => {
                s52_arg = Some(
                    it.next()
                        .ok_or_else(|| usage("--s52-data needs a path"))?
                        .clone(),
                );
            }
            "--fetch-s52" => fetch_s52 = true,
            a if a.starts_with('-') => return Err(usage(&format!("unknown flag {a}"))),
            _ if input.is_none() => input = Some(PathBuf::from(arg)),
            a => return Err(usage(&format!("unexpected argument {a}"))),
        }
    }
    let input = input.ok_or_else(|| usage("missing input cell"))?;
    let output = output.ok_or_else(|| usage("missing -o <out.pmtiles>"))?;

    let s52_data = load_s52(s52_arg.as_deref(), fetch_s52)?;

    let mut cell = read_cell(&input, &S57OpenOptions::default())
        .map_err(|e| CliError::Fail(format!("reading {}: {e}", input.display())))?;
    if !cell.extent.valid {
        return Err(CliError::Fail("cell has no located features".into()));
    }
    chartcore::derive::apply_with(&mut cell, s52_data.as_ref());

    let (derived_min, derived_max) = zoom_range_for_scale(cell.meta.compilation_scale);
    let min_zoom = min_zoom.unwrap_or(derived_min);
    let max_zoom = max_zoom.unwrap_or(derived_max);
    if min_zoom > max_zoom || max_zoom > 20 {
        return Err(usage(&format!("invalid zoom range {min_zoom}-{max_zoom}")));
    }

    let tileset = build_tileset(&cell, min_zoom, max_zoom);
    let info = ArchiveInfo {
        name: cell.meta.name.clone(),
        bounds: LLBox::from_world(&cell.extent),
        min_zoom,
        max_zoom,
        layers: tileset.layers.iter().cloned().collect(),
    };
    // atomic temp+rename write: the backend mmaps served archives, so a
    // re-ingest must never truncate the destination in place (SIGBUS)
    write_archive_to_path(&output, &tileset.tiles, &info)
        .map_err(|e| CliError::Fail(format!("writing {}: {e}", output.display())))?;

    println!(
        "{}: 1:{} scale, {} features -> z{}-z{}, {} tiles, {} layers -> {}",
        cell.meta.name,
        cell.meta.compilation_scale,
        cell.features.len(),
        min_zoom,
        max_zoom,
        tileset.tiles.len(),
        tileset.layers.len(),
        output.display()
    );
    Ok(())
}
