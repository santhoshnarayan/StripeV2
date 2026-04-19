//! `sim-cli` — CLI driver for the Rust NBA simulator.
//!
//! Reads a single JSON file containing `bracket`, `netRatings`, `simPlayers`,
//! `playoffMinutes`, `adjustments`, `injuries`, and optional `liveGames`,
//! runs N simulations (default 10k), and writes:
//!
//! - `<out_prefix>.projections.json` — per-team % per round and per-player
//!   projections (mean / stddev / p10 / p90).
//! - `<out_prefix>.matrix.bin` — binary blob with a small header followed by
//!   the ESPN ids and the `Float32` sim matrix in row-major order.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use clap::Parser;
use serde::Serialize;

use sim_engine_rs::{
    prepare, run_tournament_sim, Model, SimConfig, SimData, SimResults, SERIES_KEYS,
};

#[derive(Parser, Debug)]
#[command(version, about = "Native Rust NBA playoff Monte Carlo simulator")]
struct Args {
    /// Path to the consolidated SimData JSON file.
    #[arg(long)]
    input: PathBuf,

    /// Number of simulations to run.
    #[arg(long, default_value_t = 10_000)]
    sims: usize,

    /// Output prefix — writes `<prefix>.projections.json` and `<prefix>.matrix.bin`.
    #[arg(long = "out-prefix")]
    out_prefix: PathBuf,

    /// Master RNG seed (defaults to 42 to match the TS engine).
    #[arg(long, default_value_t = 42)]
    seed: u64,

    /// Run sims serially on a single thread instead of using rayon.
    #[arg(long, default_value_t = false)]
    single_thread: bool,

    /// Model selection (lebron|netrtg|blend).
    #[arg(long, default_value = "lebron")]
    model: String,

    /// Per-game point-margin σ.
    #[arg(long, default_value_t = 10.0)]
    stdev: f64,

    /// Home-court advantage in points.
    #[arg(long, default_value_t = 3.0)]
    hca: f64,

    /// LEBRON weight in `blend` mode.
    #[arg(long, default_value_t = 0.5)]
    blend_weight: f64,
}

#[derive(Serialize)]
struct CliManagerProjection {
    team: String,
    full_name: String,
    seed: Option<u32>,
    conference: Option<String>,
    rating: f64,
    r1: f64,
    r2: f64,
    cf: f64,
    finals: f64,
    champ: f64,
}

#[derive(Serialize)]
struct CliPlayerProjection {
    espn_id: String,
    name: String,
    team: String,
    ppg: f64,
    mpg: f64,
    projected_games: f64,
    projected_points: f64,
    projected_points_by_round: [f64; 4],
    projected_games_by_round: [f64; 4],
    stddev: f64,
    p10: f64,
    p90: f64,
}

#[derive(Serialize)]
struct CliSummary {
    num_sims: usize,
    elapsed_sec: f64,
    sims_per_sec: f64,
    threads: usize,
    teams: Vec<CliManagerProjection>,
    players: Vec<CliPlayerProjection>,
    team_names: Vec<String>,
    series_keys: Vec<&'static str>,
}

fn main() -> std::io::Result<()> {
    let args = Args::parse();
    let json = fs::read_to_string(&args.input)?;
    let data: SimData = serde_json::from_str(&json).expect("input JSON parse failed");

    let model = match args.model.as_str() {
        "netrtg" => Model::Netrtg,
        "blend" => Model::Blend,
        _ => Model::Lebron,
    };
    let cfg = SimConfig {
        model,
        sims: args.sims,
        stdev: args.stdev,
        hca: args.hca,
        blend_weight: args.blend_weight,
        seed: args.seed,
    };

    let prepared = prepare(data, cfg);

    let parallel = !args.single_thread;
    let threads = if parallel {
        rayon::current_num_threads()
    } else {
        1
    };

    let t0 = Instant::now();
    let results = run_tournament_sim(&prepared, parallel);
    let elapsed = t0.elapsed().as_secs_f64();
    let sps = args.sims as f64 / elapsed.max(1e-9);
    eprintln!(
        "ran {} sims in {:.3}s ({:.0} sims/sec, {} thread{})",
        args.sims,
        elapsed,
        sps,
        threads,
        if threads == 1 { "" } else { "s" }
    );

    write_projections(&args, &results, elapsed, sps, threads)?;
    write_matrix_bin(&args, &results)?;
    Ok(())
}

fn write_projections(
    args: &Args,
    r: &SimResults,
    elapsed: f64,
    sims_per_sec: f64,
    threads: usize,
) -> std::io::Result<()> {
    let summary = CliSummary {
        num_sims: r.num_sims,
        elapsed_sec: elapsed,
        sims_per_sec,
        threads,
        teams: r
            .teams
            .iter()
            .map(|t| CliManagerProjection {
                team: t.team.clone(),
                full_name: t.full_name.clone(),
                seed: t.seed,
                conference: t.conference.clone(),
                rating: t.rating,
                r1: t.r1,
                r2: t.r2,
                cf: t.cf,
                finals: t.finals,
                champ: t.champ,
            })
            .collect(),
        players: r
            .players
            .iter()
            .map(|p| CliPlayerProjection {
                espn_id: p.espn_id.clone(),
                name: p.name.clone(),
                team: p.team.clone(),
                ppg: p.ppg,
                mpg: p.mpg,
                projected_games: p.projected_games,
                projected_points: p.projected_points,
                projected_points_by_round: p.projected_points_by_round,
                projected_games_by_round: p.projected_games_by_round,
                stddev: p.stddev,
                p10: p.p10,
                p90: p.p90,
            })
            .collect(),
        team_names: r.team_names.clone(),
        series_keys: SERIES_KEYS.to_vec(),
    };
    let mut path = args.out_prefix.clone();
    path.set_extension("projections.json");
    let json = serde_json::to_string_pretty(&summary).expect("serialize");
    fs::write(&path, json)?;
    eprintln!("wrote {}", path.display());
    Ok(())
}

/// Binary layout:
///
/// ```text
///   magic[8]                        b"NBASIM01"
///   num_sims                        u32 LE
///   num_players                     u32 LE
///   series_n                        u32 LE
///   id_block_bytes                  u32 LE   (\0-separated ESPN ids)
///   ids ...                         id_block_bytes bytes
///   sim_matrix                      f32 LE × num_sims × num_players
///   series_winners                  u16 LE × num_sims × series_n
///   playin_seeds                    u16 LE × num_sims × 4
///   team_names_block_bytes          u32 LE   (\0-separated team abbrs)
///   team_names ...                  team_names_block_bytes bytes
/// ```
fn write_matrix_bin(args: &Args, r: &SimResults) -> std::io::Result<()> {
    let mut path = args.out_prefix.clone();
    path.set_extension("matrix.bin");
    let f = fs::File::create(&path)?;
    let mut w = std::io::BufWriter::new(f);

    w.write_all(b"NBASIM01")?;
    let num_players = r.player_ids.len() as u32;
    let num_sims = r.num_sims as u32;
    let series_n = SERIES_KEYS.len() as u32;
    w.write_all(&num_sims.to_le_bytes())?;
    w.write_all(&num_players.to_le_bytes())?;
    w.write_all(&series_n.to_le_bytes())?;

    let id_block: Vec<u8> = r.player_ids.join("\0").into_bytes();
    w.write_all(&(id_block.len() as u32).to_le_bytes())?;
    w.write_all(&id_block)?;

    // sim matrix
    for v in &r.sim_matrix {
        w.write_all(&v.to_le_bytes())?;
    }
    // series winners
    for v in &r.series_winners {
        w.write_all(&v.to_le_bytes())?;
    }
    // playin seeds
    for v in &r.playin_seeds {
        w.write_all(&v.to_le_bytes())?;
    }
    let team_block: Vec<u8> = r.team_names.join("\0").into_bytes();
    w.write_all(&(team_block.len() as u32).to_le_bytes())?;
    w.write_all(&team_block)?;

    w.flush()?;
    eprintln!("wrote {}", path.display());
    Ok(())
}
