//! Native Rust port of the NBA playoff Monte Carlo simulator that lives in
//! `packages/sim/src/tournament.ts`.
//!
//! The model semantics mirror the TypeScript implementation as closely as
//! possible (margin = N(spread + hca, stdev), totalPts=220, LEBRON minutes
//! scaled to 240, Dirichlet point distribution, best-of-7 series, 4-region
//! bracket walker, live-game injection branches). The PRNG differs:
//! TS uses xoshiro128**, Rust uses xoshiro256++ via SplitMix64 seeding —
//! aggregate distributions over thousands of sims should match within
//! sampling tolerance, but per-sim values will not be identical.

pub mod rng;

#[cfg(target_arch = "wasm32")]
pub mod wasm;

#[cfg(not(target_arch = "wasm32"))]
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::rng::Rng;

// ─── Series keys (canonical order) ──────────────────────────────────────────
//
// Mirrors the order seen in `tournament.ts` so the consumer can index
// `seriesWinners[..]` deterministically.
pub const SERIES_KEYS: [&str; 15] = [
    "r1.east.1v8",
    "r1.east.4v5",
    "r1.east.3v6",
    "r1.east.2v7",
    "r1.west.1v8",
    "r1.west.4v5",
    "r1.west.3v6",
    "r1.west.2v7",
    "r2.east.top",
    "r2.east.bot",
    "r2.west.top",
    "r2.west.bot",
    "cf.east",
    "cf.west",
    "finals",
];

// ─── Configuration & input data ─────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Model {
    Netrtg,
    Lebron,
    Blend,
}

impl Default for Model {
    fn default() -> Self {
        Model::Lebron
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SimConfig {
    pub model: Model,
    pub sims: usize,
    pub stdev: f64,
    pub hca: f64,
    #[serde(rename = "blendWeight", default)]
    pub blend_weight: f64,
    /// Master seed (defaults to 42 to match the TS engine's hard-coded seed).
    #[serde(default = "default_seed")]
    pub seed: u64,
}

fn default_seed() -> u64 {
    42
}

impl Default for SimConfig {
    fn default() -> Self {
        SimConfig {
            model: Model::Lebron,
            sims: 10_000,
            stdev: 10.0,
            hca: 3.0,
            blend_weight: 0.5,
            seed: 42,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SimPlayer {
    pub espn_id: String,
    pub nba_id: String,
    pub name: String,
    pub team: String,
    pub pos: String,
    pub mpg: f64,
    pub ppg: f64,
    pub gp: f64,
    pub lebron: f64,
    pub o_lebron: f64,
    pub d_lebron: f64,
    pub war: f64,
    #[serde(default)]
    pub autofill: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlayerAdjustment {
    pub espn_id: String,
    pub name: String,
    pub team: String,
    #[serde(default)]
    pub o_lebron_delta: f64,
    #[serde(default)]
    pub d_lebron_delta: f64,
    #[serde(default)]
    pub minutes_override: Option<f64>,
    /// Per-game availability probabilities (length 30). When absent the field
    /// defaults to all `1.0` — matching the TS default behaviour.
    #[serde(default)]
    pub availability: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InjuryEntry {
    pub team: String,
    pub status: String,
    pub injury: String,
    pub availability: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LiveGameState {
    #[serde(rename = "seriesKey")]
    pub series_key: String,
    #[serde(rename = "gameNum")]
    pub game_num: u32,
    pub status: String, // "pre" | "in" | "post"
    #[serde(rename = "homeTeam")]
    pub home_team: String,
    #[serde(rename = "awayTeam")]
    pub away_team: String,
    #[serde(rename = "homeScore")]
    pub home_score: i32,
    #[serde(rename = "awayScore")]
    pub away_score: i32,
    #[serde(rename = "remainingFraction")]
    pub remaining_fraction: f64,
    #[serde(rename = "playerPoints")]
    pub player_points: HashMap<String, f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NetRatingEntry {
    pub net_rtg_per100: f64,
    pub avg_poss: f64,
    pub net_rtg_per_game: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Bracket {
    #[serde(rename = "eastSeeds")]
    pub east_seeds: Vec<(u32, String)>,
    #[serde(rename = "westSeeds")]
    pub west_seeds: Vec<(u32, String)>,
    #[serde(rename = "eastPlayin", default)]
    pub east_playin: Vec<(u32, String)>,
    #[serde(rename = "westPlayin", default)]
    pub west_playin: Vec<(u32, String)>,
    #[serde(rename = "seriesPattern")]
    pub series_pattern: Vec<bool>,
    #[serde(rename = "teamAliases", default)]
    pub team_aliases: HashMap<String, String>,
    #[serde(rename = "teamFullNames", default)]
    pub team_full_names: HashMap<String, String>,
    #[serde(rename = "playinR2", default)]
    pub playin_r2: Option<PlayinR2>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct PlayinR2 {
    #[serde(default)]
    pub east: Option<PlayinR2Result>,
    #[serde(default)]
    pub west: Option<PlayinR2Result>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlayinR2Result {
    pub winner: String,
    pub loser: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SimData {
    pub bracket: Bracket,
    #[serde(rename = "netRatings")]
    pub net_ratings: HashMap<String, NetRatingEntry>,
    #[serde(rename = "simPlayers")]
    pub sim_players: Vec<SimPlayer>,
    #[serde(rename = "playoffMinutes")]
    pub playoff_minutes: HashMap<String, HashMap<String, f64>>,
    #[serde(default)]
    pub adjustments: Vec<PlayerAdjustment>,
    #[serde(default)]
    pub injuries: HashMap<String, serde_json::Value>,
    #[serde(rename = "liveGames", default)]
    pub live_games: Vec<LiveGameState>,
}

// ─── Output ─────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct TeamSimResult {
    pub team: String,
    #[serde(rename = "fullName")]
    pub full_name: String,
    pub seed: Option<u32>,
    pub conference: Option<String>,
    pub rating: f64,
    pub r1: f64,
    pub r2: f64,
    pub cf: f64,
    pub finals: f64,
    pub champ: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct PlayerProjection {
    #[serde(rename = "espnId")]
    pub espn_id: String,
    pub name: String,
    pub team: String,
    pub ppg: f64,
    pub mpg: f64,
    #[serde(rename = "projectedGames")]
    pub projected_games: f64,
    #[serde(rename = "projectedPoints")]
    pub projected_points: f64,
    #[serde(rename = "projectedPointsByRound")]
    pub projected_points_by_round: [f64; 4],
    #[serde(rename = "projectedGamesByRound")]
    pub projected_games_by_round: [f64; 4],
    /// Per-game means, length 28 = 4 rounds * 7 games. Index = round * 7 + game.
    #[serde(rename = "projectedPointsByGame")]
    pub projected_points_by_game: Vec<f64>,
    #[serde(rename = "projectedGamesByGame")]
    pub projected_games_by_game: Vec<f64>,
    pub stddev: f64,
    pub p10: f64,
    pub p90: f64,
}

/// Matches `SimResults` in `packages/sim/src/types.ts` plus the additional
/// fields requested by Slice 1 (`seriesWinners`, `playinSeeds`, `teamNames`,
/// `teamIndex`).
pub struct SimResults {
    pub teams: Vec<TeamSimResult>,
    pub players: Vec<PlayerProjection>,
    /// Row-major `[sim, player]` matrix, `Float32` to halve disk size.
    pub sim_matrix: Vec<f32>,
    pub player_index: HashMap<String, usize>,
    pub player_ids: Vec<String>,
    pub num_sims: usize,
    /// Per-team max round reached (0..=5), one byte per sim.
    pub team_round_reached: HashMap<String, Vec<u8>>,
    /// Series winners per sim — row-major `[sim, series]` of length
    /// `num_sims * SERIES_KEYS.len()`. Each entry stores the team's index in
    /// `team_names` (or `u16::MAX` if unfilled).
    pub series_winners: Vec<u16>,
    /// Per-sim play-in outcomes (`east7`, `east8`, `west7`, `west8`) packed
    /// row-major as four `team_index` slots.
    pub playin_seeds: Vec<u16>,
    /// Stable list of team abbreviations (the bracket's union of all seeds).
    pub team_names: Vec<String>,
    pub team_index: HashMap<String, u16>,
}

// ─── Internal precomputed state ─────────────────────────────────────────────

#[derive(Clone)]
pub struct TeamPointDistribution {
    pub count: usize,
    pub player_idx: Vec<i32>,
    pub alphas: Vec<f64>,
}

/// Static, immutable precomputed inputs that every sim/thread shares.
pub struct PreparedSim {
    pub config: SimConfig,
    pub bracket: Bracket,
    pub net_ratings: HashMap<String, f64>,
    pub rosters_by_team: HashMap<String, Vec<usize>>, // team → indices into players
    pub players: Vec<SimPlayer>,
    pub player_index: HashMap<String, usize>,
    pub player_ids: Vec<String>,
    pub playoff_minutes: HashMap<String, HashMap<String, f64>>,
    pub adjustments_by_id: HashMap<String, PlayerAdjustment>,
    pub injuries_by_name: HashMap<String, InjuryEntry>,
    pub aliases: HashMap<String, String>,
    pub aliases_rev: HashMap<String, String>,
    pub live_by_key: HashMap<String, Vec<LiveGameState>>,
    pub team_dist_by_key: HashMap<String, TeamPointDistribution>,
    pub max_team_count: usize,
    pub team_names: Vec<String>,
    pub team_index: HashMap<String, u16>,
    pub series_index: HashMap<String, usize>,
}

const NUM_ROUNDS: usize = 4;
/// Per-(round,gameNum) accumulator dimension. Index = round * 7 + game_num
/// where game_num ∈ 0..7 (NBA series caps at 7 games).
const NUM_GAME_SLOTS: usize = NUM_ROUNDS * 7;
const CONCENTRATION: f64 = 20.0;
const TOTAL_PTS: f64 = 220.0;

fn build_alias_rev(aliases: &HashMap<String, String>) -> HashMap<String, String> {
    let mut rev = HashMap::with_capacity(aliases.len());
    for (k, v) in aliases {
        rev.insert(v.clone(), k.clone());
    }
    rev
}

fn resolve_team<'a, V>(
    team: &str,
    data: &'a HashMap<String, V>,
    aliases: &HashMap<String, String>,
    aliases_rev: &HashMap<String, String>,
) -> String {
    if data.contains_key(team) {
        return team.to_string();
    }
    if let Some(alt) = aliases.get(team) {
        if data.contains_key(alt) {
            return alt.clone();
        }
    }
    if let Some(alt) = aliases_rev.get(team) {
        if data.contains_key(alt) {
            return alt.clone();
        }
    }
    team.to_string()
}

fn seed_order(team: &str, seeds: &[(u32, String)], playin: &[(u32, String)]) -> u32 {
    for (s, t) in seeds {
        if t == team {
            return *s;
        }
    }
    for (s, t) in playin {
        if t == team {
            return *s;
        }
    }
    99
}

fn order_matchup(
    a: String,
    b: String,
    all_seeds: &[(u32, String)],
    all_playin: &[(u32, String)],
) -> (String, String) {
    let sa = seed_order(&a, all_seeds, all_playin);
    let sb = seed_order(&b, all_seeds, all_playin);
    if sa < sb {
        (a, b)
    } else {
        (b, a)
    }
}

/// One-time setup that mirrors the top of `runTournamentSim` in TS.
pub fn prepare(data: SimData, config: SimConfig) -> PreparedSim {
    let bracket = data.bracket;
    let aliases = bracket.team_aliases.clone();
    let aliases_rev = build_alias_rev(&aliases);

    // Players + per-team rosters
    let players = data.sim_players;
    let mut player_index: HashMap<String, usize> = HashMap::with_capacity(players.len());
    let mut player_ids: Vec<String> = Vec::with_capacity(players.len());
    let mut rosters_by_team: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, p) in players.iter().enumerate() {
        player_index.insert(p.espn_id.clone(), idx);
        player_ids.push(p.espn_id.clone());
        rosters_by_team.entry(p.team.clone()).or_default().push(idx);
    }

    // Net ratings flattened to per-game value (the JS file already has this).
    let mut net_ratings: HashMap<String, f64> = HashMap::with_capacity(data.net_ratings.len());
    for (team, info) in &data.net_ratings {
        net_ratings.insert(team.clone(), info.net_rtg_per_game);
    }
    for (seed_abbr, csv_abbr) in &aliases {
        if net_ratings.contains_key(csv_abbr) && !net_ratings.contains_key(seed_abbr) {
            let v = net_ratings[csv_abbr];
            net_ratings.insert(seed_abbr.clone(), v);
        }
    }

    // Adjustments + injuries
    let mut adjustments_by_id: HashMap<String, PlayerAdjustment> = HashMap::new();
    for adj in data.adjustments {
        adjustments_by_id.insert(adj.espn_id.clone(), adj);
    }
    let mut injuries_by_name: HashMap<String, InjuryEntry> = HashMap::new();
    for (name, value) in data.injuries {
        if name == "_meta" {
            continue;
        }
        if let Ok(entry) = serde_json::from_value::<InjuryEntry>(value) {
            injuries_by_name.insert(name, entry);
        }
    }

    // Per-team Dirichlet distributions (point-share weights)
    let mut team_dist_by_key: HashMap<String, TeamPointDistribution> = HashMap::new();
    let mut max_team_count: usize = 1;
    for (team_key, roster_idxs) in &rosters_by_team {
        let pm = data.playoff_minutes.get(team_key);
        let empty: HashMap<String, f64> = HashMap::new();
        let pm = pm.unwrap_or(&empty);
        let mut idx: Vec<i32> = Vec::new();
        let mut w: Vec<f64> = Vec::new();
        let mut total: f64 = 0.0;
        for &pi in roster_idxs {
            let p = &players[pi];
            let mins = *pm.get(&p.nba_id).unwrap_or(&0.0);
            if mins <= 0.0 {
                continue;
            }
            let pts_per_min = if p.mpg > 0.0 { p.ppg / p.mpg } else { 1.0 };
            let ww = pts_per_min * mins;
            idx.push(pi as i32);
            w.push(ww);
            total += ww;
        }
        let count = idx.len();
        let mut alphas = vec![0.0f64; count];
        if total > 0.0 {
            for i in 0..count {
                alphas[i] = (w[i] / total) * CONCENTRATION;
            }
        }
        team_dist_by_key.insert(
            team_key.clone(),
            TeamPointDistribution {
                count,
                player_idx: idx,
                alphas,
            },
        );
        if count > max_team_count {
            max_team_count = count;
        }
    }
    // Mirror the distribution map across team aliases so hot-path lookups
    // never need to resolve aliases.
    let alias_pairs: Vec<(String, String)> = aliases
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for (seed_abbr, csv_abbr) in alias_pairs {
        let d = team_dist_by_key
            .get(&seed_abbr)
            .or_else(|| team_dist_by_key.get(&csv_abbr))
            .cloned();
        if let Some(d) = d {
            team_dist_by_key.insert(seed_abbr, d.clone());
            team_dist_by_key.insert(csv_abbr, d);
        }
    }

    // Live game lookup
    let mut live_by_key: HashMap<String, Vec<LiveGameState>> = HashMap::new();
    for g in data.live_games {
        if g.series_key.is_empty() {
            continue;
        }
        live_by_key.entry(g.series_key.clone()).or_default().push(g);
    }
    for arr in live_by_key.values_mut() {
        arr.sort_by_key(|g| g.game_num);
    }

    // Stable team-name ordering: east seeds → east playin → west seeds → west playin.
    let mut team_names: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let push =
        |team: &str, team_names: &mut Vec<String>, seen: &mut std::collections::HashSet<String>| {
            if !seen.contains(team) {
                seen.insert(team.to_string());
                team_names.push(team.to_string());
            }
        };
    for (_, t) in &bracket.east_seeds {
        push(t, &mut team_names, &mut seen);
    }
    for (_, t) in &bracket.east_playin {
        push(t, &mut team_names, &mut seen);
    }
    for (_, t) in &bracket.west_seeds {
        push(t, &mut team_names, &mut seen);
    }
    for (_, t) in &bracket.west_playin {
        push(t, &mut team_names, &mut seen);
    }
    let team_index: HashMap<String, u16> = team_names
        .iter()
        .enumerate()
        .map(|(i, t)| (t.clone(), i as u16))
        .collect();

    let series_index: HashMap<String, usize> = SERIES_KEYS
        .iter()
        .enumerate()
        .map(|(i, k)| (k.to_string(), i))
        .collect();

    PreparedSim {
        config,
        bracket,
        net_ratings,
        rosters_by_team,
        players,
        player_index,
        player_ids,
        playoff_minutes: data.playoff_minutes,
        adjustments_by_id,
        injuries_by_name,
        aliases,
        aliases_rev,
        live_by_key,
        team_dist_by_key,
        max_team_count,
        team_names,
        team_index,
        series_index,
    }
}

// ─── Per-sim work buffers (allocate once per worker) ────────────────────────

struct SimScratch {
    accum_games: Vec<f32>,
    accum_pts: Vec<f64>,
    scratch_shares: Vec<f64>,
}

impl SimScratch {
    fn new(num_players: usize, max_team_count: usize) -> Self {
        SimScratch {
            accum_games: vec![0.0f32; num_players * NUM_GAME_SLOTS],
            accum_pts: vec![0.0f64; num_players * NUM_GAME_SLOTS],
            scratch_shares: vec![0.0f64; max_team_count.max(1)],
        }
    }

    fn reset(&mut self) {
        for v in &mut self.accum_games {
            *v = 0.0;
        }
        for v in &mut self.accum_pts {
            *v = 0.0;
        }
    }
}

// ─── Game / series simulation ───────────────────────────────────────────────

#[inline]
fn simulate_game(
    home_rating: f64,
    away_rating: f64,
    rng: &mut Rng,
    hca: f64,
    stdev: f64,
) -> (bool, i32, i32) {
    let spread = home_rating - away_rating + hca;
    let margin = rng.normal(spread, stdev);
    let home = ((TOTAL_PTS + margin) / 2.0).round() as i32;
    let away = ((TOTAL_PTS - margin) / 2.0).round() as i32;
    (margin > 0.0, home, away)
}

fn calc_lebron_rating(
    sim: &PreparedSim,
    roster: &[usize],
    pm: Option<&HashMap<String, f64>>,
    rng: &mut Rng,
    game_num: usize,
) -> f64 {
    // Filter to active players for this game.
    let mut active: Vec<usize> = Vec::with_capacity(roster.len());
    for &pi in roster {
        let p = &sim.players[pi];
        if p.mpg <= 0.0 {
            continue;
        }
        if let Some(injury) = sim.injuries_by_name.get(&p.name) {
            let avail = if injury.availability.is_empty() {
                1.0
            } else {
                let i = game_num.min(injury.availability.len() - 1);
                injury.availability[i]
            };
            if rng.random() >= avail {
                continue;
            }
        }
        active.push(pi);
    }
    if active.is_empty() {
        return -10.0;
    }

    if let Some(pm) = pm {
        // Collect base minutes and overrides.
        let mut base_total = 0.0f64;
        let mut overridden_total = 0.0f64;
        let mut base_mins: Vec<(usize, f64)> = Vec::with_capacity(active.len());
        let mut overrides: Vec<(usize, f64)> = Vec::new();

        for &pi in &active {
            let p = &sim.players[pi];
            let adj = sim.adjustments_by_id.get(&p.espn_id);
            let base = *pm.get(&p.nba_id).unwrap_or(&0.0);
            let override_min = adj.and_then(|a| a.minutes_override);
            if base <= 0.0 && override_min.is_none() {
                continue;
            }
            if let Some(o) = override_min {
                overrides.push((pi, o));
                overridden_total += o;
            } else {
                base_mins.push((pi, base));
                base_total += base;
            }
        }

        let remaining = (240.0 - overridden_total).max(0.0);
        let scale = if base_total > 0.0 {
            remaining / base_total
        } else {
            0.0
        };

        let mut rating = 0.0f64;
        for (pi, mins) in &overrides {
            let p = &sim.players[*pi];
            let adj = sim.adjustments_by_id.get(&p.espn_id);
            let lebron = p.lebron
                + adj.map(|a| a.o_lebron_delta).unwrap_or(0.0)
                + adj.map(|a| a.d_lebron_delta).unwrap_or(0.0);
            if *mins > 0.0 {
                rating += (lebron * mins) / 48.0;
            }
        }
        for (pi, base) in &base_mins {
            let p = &sim.players[*pi];
            let adj = sim.adjustments_by_id.get(&p.espn_id);
            let mins = base * scale;
            if mins <= 0.0 {
                continue;
            }
            let lebron = p.lebron
                + adj.map(|a| a.o_lebron_delta).unwrap_or(0.0)
                + adj.map(|a| a.d_lebron_delta).unwrap_or(0.0);
            rating += (lebron * mins) / 48.0;
        }
        return rating;
    }

    // Fallback path: top-5 by MPG, rest share remainder.
    let mut ranked: Vec<usize> = active.clone();
    ranked.sort_by(|&a, &b| {
        sim.players[b]
            .mpg
            .partial_cmp(&sim.players[a].mpg)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let top5_n = ranked.len().min(5);
    let top5 = &ranked[..top5_n];
    let rest = &ranked[top5_n..];
    let top5_mins: f64 = top5.iter().map(|&i| sim.players[i].mpg).sum();
    let remaining_mins = (240.0 - top5_mins).max(0.0);
    let rest_total: f64 = rest.iter().map(|&i| sim.players[i].mpg).sum();
    let mut rating = 0.0f64;
    for &pi in top5 {
        let p = &sim.players[pi];
        let adj = sim.adjustments_by_id.get(&p.espn_id);
        let mins = adj.and_then(|a| a.minutes_override).unwrap_or(p.mpg);
        let lebron = p.lebron
            + adj.map(|a| a.o_lebron_delta).unwrap_or(0.0)
            + adj.map(|a| a.d_lebron_delta).unwrap_or(0.0);
        rating += (lebron * mins) / 48.0;
    }
    for &pi in rest {
        let p = &sim.players[pi];
        let adj = sim.adjustments_by_id.get(&p.espn_id);
        let mins = adj
            .and_then(|a| a.minutes_override)
            .unwrap_or(if rest_total > 0.0 {
                p.mpg * (remaining_mins / rest_total)
            } else {
                0.0
            });
        let lebron = p.lebron
            + adj.map(|a| a.o_lebron_delta).unwrap_or(0.0)
            + adj.map(|a| a.d_lebron_delta).unwrap_or(0.0);
        rating += (lebron * mins) / 48.0;
    }
    rating
}

fn get_team_rating(sim: &PreparedSim, team: &str, rng: &mut Rng, game_num: usize) -> f64 {
    let net_key = resolve_team(team, &sim.net_ratings, &sim.aliases, &sim.aliases_rev);
    let nr_rating = *sim.net_ratings.get(&net_key).unwrap_or(&0.0);

    if matches!(sim.config.model, Model::Netrtg) {
        return nr_rating;
    }

    let roster_key = resolve_team(team, &sim.rosters_by_team, &sim.aliases, &sim.aliases_rev);
    let empty: Vec<usize> = Vec::new();
    let roster = sim.rosters_by_team.get(&roster_key).unwrap_or(&empty);
    let pm = sim
        .playoff_minutes
        .get(team)
        .or_else(|| sim.playoff_minutes.get(&roster_key));
    let lebron = calc_lebron_rating(sim, roster, pm, rng, game_num);

    if matches!(sim.config.model, Model::Lebron) {
        return lebron;
    }
    sim.config.blend_weight * lebron + (1.0 - sim.config.blend_weight) * nr_rating
}

#[inline]
fn track_team(
    sim: &PreparedSim,
    scratch: &mut SimScratch,
    rng: &mut Rng,
    team: &str,
    score: i32,
    round_idx: usize,
    game_num: usize,
) {
    let dist = match sim.team_dist_by_key.get(team) {
        Some(d) if d.count > 0 => d,
        _ => return,
    };
    let count = dist.count;
    rng.dirichlet_into(&dist.alphas[..count], &mut scratch.scratch_shares[..count]);
    let s = score as f64;
    let slot = round_idx * 7 + game_num;
    for i in 0..count {
        let pi = dist.player_idx[i] as usize;
        let offset = pi * NUM_GAME_SLOTS + slot;
        scratch.accum_games[offset] += 1.0;
        scratch.accum_pts[offset] += s * scratch.scratch_shares[i];
    }
}

fn simulate_series(
    sim: &PreparedSim,
    higher: &str,
    lower: &str,
    rng: &mut Rng,
    round_idx: usize,
    scratch: &mut SimScratch,
    game_offset: usize,
    series_key: &str,
) -> String {
    let h_rating = get_team_rating(sim, higher, rng, game_offset);
    let l_rating = get_team_rating(sim, lower, rng, game_offset);

    let mut h_wins = 0;
    let mut l_wins = 0;

    let live_games = sim.live_by_key.get(series_key);

    for game_num in 0..7usize {
        if h_wins == 4 || l_wins == 4 {
            break;
        }

        let live =
            live_games.and_then(|games| games.iter().find(|g| g.game_num as usize == game_num + 1));

        if let Some(live) = live {
            let live_higher_home = live.home_team.eq_ignore_ascii_case(higher);
            let higher_actual = if live_higher_home {
                live.home_score
            } else {
                live.away_score
            };
            let lower_actual = if live_higher_home {
                live.away_score
            } else {
                live.home_score
            };

            // Apply accrued actual player points.
            for (espn_id, pts) in &live.player_points {
                if !pts.is_finite() || *pts <= 0.0 {
                    continue;
                }
                if let Some(&idx) = sim.player_index.get(espn_id) {
                    let offset = idx * NUM_GAME_SLOTS + round_idx * 7 + game_num;
                    scratch.accum_pts[offset] += *pts;
                    scratch.accum_games[offset] += 1.0;
                }
            }

            if live.status == "post" {
                if higher_actual > lower_actual {
                    h_wins += 1;
                } else {
                    l_wins += 1;
                }
                continue;
            }

            if live.status == "in" {
                let frac = live.remaining_fraction.clamp(0.0, 1.0);
                if frac <= 0.01 {
                    if higher_actual >= lower_actual {
                        h_wins += 1;
                    } else {
                        l_wins += 1;
                    }
                    continue;
                }
                let scaled_std = sim.config.stdev * frac.sqrt();
                let spread = (h_rating - l_rating) * frac;
                let margin = rng.normal(spread, scaled_std);
                let remaining_total = TOTAL_PTS * frac;
                let rem_h = ((remaining_total + margin) / 2.0).round().max(0.0) as i32;
                let rem_l = ((remaining_total - margin) / 2.0).round().max(0.0) as i32;
                track_team(sim, scratch, rng, higher, rem_h, round_idx, game_num);
                track_team(sim, scratch, rng, lower, rem_l, round_idx, game_num);
                let final_h = higher_actual + rem_h;
                let final_l = lower_actual + rem_l;
                if final_h >= final_l {
                    h_wins += 1;
                } else {
                    l_wins += 1;
                }
                continue;
            }
            // status == "pre" → fall through to normal sim
        }

        let higher_home = sim.bracket.series_pattern[game_num];
        let (home_wins, home_score, away_score) = if higher_home {
            simulate_game(h_rating, l_rating, rng, sim.config.hca, sim.config.stdev)
        } else {
            simulate_game(l_rating, h_rating, rng, sim.config.hca, sim.config.stdev)
        };

        let higher_won = if higher_home { home_wins } else { !home_wins };
        if higher_won {
            h_wins += 1;
        } else {
            l_wins += 1;
        }

        if higher_home {
            track_team(sim, scratch, rng, higher, home_score, round_idx, game_num);
            track_team(sim, scratch, rng, lower, away_score, round_idx, game_num);
        } else {
            track_team(sim, scratch, rng, lower, home_score, round_idx, game_num);
            track_team(sim, scratch, rng, higher, away_score, round_idx, game_num);
        }
    }

    if h_wins == 4 {
        higher.to_string()
    } else {
        lower.to_string()
    }
}

fn simulate_play_in_game(
    sim: &PreparedSim,
    higher: &str,
    lower: &str,
    rng: &mut Rng,
    game_num: usize,
) -> (String, String) {
    let h_rating = get_team_rating(sim, higher, rng, game_num);
    let l_rating = get_team_rating(sim, lower, rng, game_num);
    let (home_wins, _, _) =
        simulate_game(h_rating, l_rating, rng, sim.config.hca, sim.config.stdev);
    if home_wins {
        (higher.to_string(), lower.to_string())
    } else {
        (lower.to_string(), higher.to_string())
    }
}

fn simulate_play_in(
    sim: &PreparedSim,
    seeds: &[(u32, String)],
    playin: &[(u32, String)],
    rng: &mut Rng,
) -> (String, String) {
    let s7 = seeds
        .iter()
        .find(|(s, _)| *s == 7)
        .map(|(_, t)| t.clone())
        .unwrap_or_default();
    let s8 = seeds
        .iter()
        .find(|(s, _)| *s == 8)
        .map(|(_, t)| t.clone())
        .unwrap_or_default();
    let s9 = playin
        .iter()
        .find(|(s, _)| *s == 9)
        .map(|(_, t)| t.clone())
        .unwrap_or_default();
    let s10 = playin
        .iter()
        .find(|(s, _)| *s == 10)
        .map(|(_, t)| t.clone())
        .unwrap_or_default();

    let (g1_w, g1_l) = simulate_play_in_game(sim, &s7, &s8, rng, 0);
    let seed7 = g1_w;

    let (g2_w, _g2_l) = simulate_play_in_game(sim, &s9, &s10, rng, 0);

    let (g3_w, _g3_l) = simulate_play_in_game(sim, &g1_l, &g2_w, rng, 1);
    let seed8 = g3_w;

    (seed7, seed8)
}

// ─── Public entry point ─────────────────────────────────────────────────────

/// Per-thread accumulators (used by both single- and multi-thread runners).
struct ShardOutput {
    sim_count: usize,
    sim_matrix: Vec<f32>,     // sim_count * num_players
    series_winners: Vec<u16>, // sim_count * SERIES_KEYS.len()
    playin_seeds: Vec<u16>,   // sim_count * 4
    team_round_reached: HashMap<String, Vec<u8>>,
    r1: HashMap<String, u32>,
    r2: HashMap<String, u32>,
    cf: HashMap<String, u32>,
    finals: HashMap<String, u32>,
    champ: HashMap<String, u32>,
    team_playoff_sims: HashMap<String, u32>,
    total_games: Vec<f64>, // num_players * NUM_GAME_SLOTS (= 28)
    total_pts: Vec<f64>,
}

fn run_shard(sim: &PreparedSim, sim_count: usize, seed: u64) -> ShardOutput {
    let num_players = sim.players.len();
    let mut rng = Rng::new(seed);
    let mut scratch = SimScratch::new(num_players, sim.max_team_count);

    let series_n = SERIES_KEYS.len();
    let mut sim_matrix = vec![0.0f32; sim_count * num_players];
    let mut series_winners = vec![u16::MAX; sim_count * series_n];
    let mut playin_seeds = vec![u16::MAX; sim_count * 4];

    let mut r1: HashMap<String, u32> = HashMap::new();
    let mut r2: HashMap<String, u32> = HashMap::new();
    let mut cf: HashMap<String, u32> = HashMap::new();
    let mut finals: HashMap<String, u32> = HashMap::new();
    let mut champ: HashMap<String, u32> = HashMap::new();
    let mut team_playoff_sims: HashMap<String, u32> = HashMap::new();
    let mut team_round_reached: HashMap<String, Vec<u8>> = HashMap::new();

    let mut total_games = vec![0.0f64; num_players * NUM_GAME_SLOTS];
    let mut total_pts = vec![0.0f64; num_players * NUM_GAME_SLOTS];

    let bracket = &sim.bracket;
    let all_seeds: Vec<(u32, String)> = bracket
        .east_seeds
        .iter()
        .chain(bracket.west_seeds.iter())
        .cloned()
        .collect();
    let all_playin: Vec<(u32, String)> = bracket
        .east_playin
        .iter()
        .chain(bracket.west_playin.iter())
        .cloned()
        .collect();

    let mark_reached = |team: &str,
                        level: u8,
                        sim_idx: usize,
                        team_round_reached: &mut HashMap<String, Vec<u8>>| {
        let arr = team_round_reached
            .entry(team.to_string())
            .or_insert_with(|| vec![0u8; sim_count]);
        if arr[sim_idx] < level {
            arr[sim_idx] = level;
        }
    };

    // Lock play-in seeds when the real-world play-in is complete. eastSeeds /
    // westSeeds already reflect the locked 7/8 seeds (PHI=7, ORL=8 etc) so we
    // just use them directly instead of re-running random play-in games.
    let east_playin_done = bracket
        .playin_r2
        .as_ref()
        .and_then(|p| p.east.as_ref())
        .is_some();
    let west_playin_done = bracket
        .playin_r2
        .as_ref()
        .and_then(|p| p.west.as_ref())
        .is_some();
    let locked_east7 = bracket
        .east_seeds
        .iter()
        .find(|(s, _)| *s == 7)
        .map(|(_, t)| t.clone())
        .unwrap_or_default();
    let locked_east8 = bracket
        .east_seeds
        .iter()
        .find(|(s, _)| *s == 8)
        .map(|(_, t)| t.clone())
        .unwrap_or_default();
    let locked_west7 = bracket
        .west_seeds
        .iter()
        .find(|(s, _)| *s == 7)
        .map(|(_, t)| t.clone())
        .unwrap_or_default();
    let locked_west8 = bracket
        .west_seeds
        .iter()
        .find(|(s, _)| *s == 8)
        .map(|(_, t)| t.clone())
        .unwrap_or_default();

    for sim_idx in 0..sim_count {
        scratch.reset();

        // Play-in
        let (east7, east8) = if east_playin_done {
            (locked_east7.clone(), locked_east8.clone())
        } else {
            simulate_play_in(sim, &bracket.east_seeds, &bracket.east_playin, &mut rng)
        };
        let (west7, west8) = if west_playin_done {
            (locked_west7.clone(), locked_west8.clone())
        } else {
            simulate_play_in(sim, &bracket.west_seeds, &bracket.west_playin, &mut rng)
        };

        for t in [&east7, &east8, &west7, &west8] {
            *team_playoff_sims.entry((*t).clone()).or_insert(0) += 1;
        }

        playin_seeds[sim_idx * 4 + 0] = *sim.team_index.get(&east7).unwrap_or(&u16::MAX);
        playin_seeds[sim_idx * 4 + 1] = *sim.team_index.get(&east8).unwrap_or(&u16::MAX);
        playin_seeds[sim_idx * 4 + 2] = *sim.team_index.get(&west7).unwrap_or(&u16::MAX);
        playin_seeds[sim_idx * 4 + 3] = *sim.team_index.get(&west8).unwrap_or(&u16::MAX);

        // Mark every team that entered the main bracket.
        for (s, t) in &all_seeds {
            if *s <= 6 {
                mark_reached(t, 1, sim_idx, &mut team_round_reached);
            }
        }
        for t in [&east7, &east8, &west7, &west8] {
            mark_reached(t, 1, sim_idx, &mut team_round_reached);
        }

        // R1 matchups
        let east_r1: [(String, String, &str); 4] = [
            (
                bracket.east_seeds[0].1.clone(),
                east8.clone(),
                "r1.east.1v8",
            ),
            (
                bracket.east_seeds[3].1.clone(),
                bracket.east_seeds[4].1.clone(),
                "r1.east.4v5",
            ),
            (
                bracket.east_seeds[2].1.clone(),
                bracket.east_seeds[5].1.clone(),
                "r1.east.3v6",
            ),
            (
                bracket.east_seeds[1].1.clone(),
                east7.clone(),
                "r1.east.2v7",
            ),
        ];
        let west_r1: [(String, String, &str); 4] = [
            (
                bracket.west_seeds[0].1.clone(),
                west8.clone(),
                "r1.west.1v8",
            ),
            (
                bracket.west_seeds[3].1.clone(),
                bracket.west_seeds[4].1.clone(),
                "r1.west.4v5",
            ),
            (
                bracket.west_seeds[2].1.clone(),
                bracket.west_seeds[5].1.clone(),
                "r1.west.3v6",
            ),
            (
                bracket.west_seeds[1].1.clone(),
                west7.clone(),
                "r1.west.2v7",
            ),
        ];

        let mut e1w: Vec<String> = Vec::with_capacity(4);
        for (h, l, key) in &east_r1 {
            let winner = simulate_series(sim, h, l, &mut rng, 0, &mut scratch, 2, key);
            *r1.entry(winner.clone()).or_insert(0) += 1;
            mark_reached(&winner, 2, sim_idx, &mut team_round_reached);
            series_winners[sim_idx * series_n + sim.series_index[*key]] =
                *sim.team_index.get(&winner).unwrap_or(&u16::MAX);
            e1w.push(winner);
        }
        let mut w1w: Vec<String> = Vec::with_capacity(4);
        for (h, l, key) in &west_r1 {
            let winner = simulate_series(sim, h, l, &mut rng, 0, &mut scratch, 2, key);
            *r1.entry(winner.clone()).or_insert(0) += 1;
            mark_reached(&winner, 2, sim_idx, &mut team_round_reached);
            series_winners[sim_idx * series_n + sim.series_index[*key]] =
                *sim.team_index.get(&winner).unwrap_or(&u16::MAX);
            w1w.push(winner);
        }

        // R2 — standard NBA bracket halves (top: 1v8 vs 4v5 — Half A; bot: 2v7 vs 3v6 — Half B).
        let (eth, etl) = order_matchup(e1w[0].clone(), e1w[1].clone(), &all_seeds, &all_playin);
        let (ebh, ebl) = order_matchup(e1w[3].clone(), e1w[2].clone(), &all_seeds, &all_playin);
        let (wth, wtl) = order_matchup(w1w[0].clone(), w1w[1].clone(), &all_seeds, &all_playin);
        let (wbh, wbl) = order_matchup(w1w[3].clone(), w1w[2].clone(), &all_seeds, &all_playin);

        let east_r2: [(String, String, &str); 2] =
            [(eth, etl, "r2.east.top"), (ebh, ebl, "r2.east.bot")];
        let west_r2: [(String, String, &str); 2] =
            [(wth, wtl, "r2.west.top"), (wbh, wbl, "r2.west.bot")];

        let mut e2w: Vec<String> = Vec::with_capacity(2);
        for (h, l, key) in &east_r2 {
            let winner = simulate_series(sim, h, l, &mut rng, 1, &mut scratch, 9, key);
            *r2.entry(winner.clone()).or_insert(0) += 1;
            mark_reached(&winner, 3, sim_idx, &mut team_round_reached);
            series_winners[sim_idx * series_n + sim.series_index[*key]] =
                *sim.team_index.get(&winner).unwrap_or(&u16::MAX);
            e2w.push(winner);
        }
        let mut w2w: Vec<String> = Vec::with_capacity(2);
        for (h, l, key) in &west_r2 {
            let winner = simulate_series(sim, h, l, &mut rng, 1, &mut scratch, 9, key);
            *r2.entry(winner.clone()).or_insert(0) += 1;
            mark_reached(&winner, 3, sim_idx, &mut team_round_reached);
            series_winners[sim_idx * series_n + sim.series_index[*key]] =
                *sim.team_index.get(&winner).unwrap_or(&u16::MAX);
            w2w.push(winner);
        }

        // CF
        let (ecf_h, ecf_l) = order_matchup(e2w[0].clone(), e2w[1].clone(), &all_seeds, &all_playin);
        let ecf_winner = simulate_series(
            sim,
            &ecf_h,
            &ecf_l,
            &mut rng,
            2,
            &mut scratch,
            16,
            "cf.east",
        );
        *cf.entry(ecf_winner.clone()).or_insert(0) += 1;
        mark_reached(&ecf_winner, 4, sim_idx, &mut team_round_reached);
        series_winners[sim_idx * series_n + sim.series_index["cf.east"]] =
            *sim.team_index.get(&ecf_winner).unwrap_or(&u16::MAX);

        let (wcf_h, wcf_l) = order_matchup(w2w[0].clone(), w2w[1].clone(), &all_seeds, &all_playin);
        let wcf_winner = simulate_series(
            sim,
            &wcf_h,
            &wcf_l,
            &mut rng,
            2,
            &mut scratch,
            16,
            "cf.west",
        );
        *cf.entry(wcf_winner.clone()).or_insert(0) += 1;
        mark_reached(&wcf_winner, 4, sim_idx, &mut team_round_reached);
        series_winners[sim_idx * series_n + sim.series_index["cf.west"]] =
            *sim.team_index.get(&wcf_winner).unwrap_or(&u16::MAX);

        // Finals
        let (fin_h, fin_l) = order_matchup(ecf_winner, wcf_winner, &all_seeds, &all_playin);
        let fin_winner =
            simulate_series(sim, &fin_h, &fin_l, &mut rng, 3, &mut scratch, 23, "finals");
        *finals.entry(fin_winner.clone()).or_insert(0) += 1;
        *champ.entry(fin_winner.clone()).or_insert(0) += 1;
        mark_reached(&fin_winner, 5, sim_idx, &mut team_round_reached);
        series_winners[sim_idx * series_n + sim.series_index["finals"]] =
            *sim.team_index.get(&fin_winner).unwrap_or(&u16::MAX);

        // Fold per-sim accums into global totals + write the sim matrix row.
        let sim_offset = sim_idx * num_players;
        for p in 0..num_players {
            let base = p * NUM_GAME_SLOTS;
            let mut total = 0.0f64;
            for i in 0..NUM_GAME_SLOTS {
                let pts = scratch.accum_pts[base + i];
                total += pts;
                total_games[base + i] += scratch.accum_games[base + i] as f64;
                total_pts[base + i] += pts;
            }
            if total != 0.0 {
                sim_matrix[sim_offset + p] = total as f32;
            }
        }
    }

    ShardOutput {
        sim_count,
        sim_matrix,
        series_winners,
        playin_seeds,
        team_round_reached,
        r1,
        r2,
        cf,
        finals,
        champ,
        team_playoff_sims,
        total_games,
        total_pts,
    }
}

fn merge_count_maps(a: &mut HashMap<String, u32>, b: HashMap<String, u32>) {
    for (k, v) in b {
        *a.entry(k).or_insert(0) += v;
    }
}

/// Run the full Monte Carlo. When `parallel` is true, work is sharded across
/// rayon's thread pool with `seed = config.seed + worker * sims_per_worker`.
pub fn run_tournament_sim(sim: &PreparedSim, parallel: bool) -> SimResults {
    let total_sims = sim.config.sims;
    let num_players = sim.players.len();
    let series_n = SERIES_KEYS.len();

    let shards: Vec<ShardOutput> = {
        #[cfg(target_arch = "wasm32")]
        {
            let _ = parallel;
            vec![run_shard(sim, total_sims, sim.config.seed)]
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            if !parallel || total_sims < 32 {
                vec![run_shard(sim, total_sims, sim.config.seed)]
            } else {
                let num_threads = rayon::current_num_threads().max(1);
                let per = (total_sims + num_threads - 1) / num_threads;
                let plan: Vec<(usize, usize)> = (0..num_threads)
                    .map(|i| {
                        let start = i * per;
                        let end = (start + per).min(total_sims);
                        (start, end - start)
                    })
                    .filter(|(_, n)| *n > 0)
                    .collect();
                plan.into_par_iter()
                    .map(|(start, count)| {
                        let seed = sim.config.seed.wrapping_add(start as u64);
                        run_shard(sim, count, seed)
                    })
                    .collect()
            }
        }
    };

    // Concatenate shards into the canonical row-major matrices.
    let mut sim_matrix = vec![0.0f32; total_sims * num_players];
    let mut series_winners = vec![u16::MAX; total_sims * series_n];
    let mut playin_seeds = vec![u16::MAX; total_sims * 4];
    let mut team_round_reached: HashMap<String, Vec<u8>> = HashMap::new();
    let mut r1: HashMap<String, u32> = HashMap::new();
    let mut r2: HashMap<String, u32> = HashMap::new();
    let mut cf_map: HashMap<String, u32> = HashMap::new();
    let mut finals_map: HashMap<String, u32> = HashMap::new();
    let mut champ_map: HashMap<String, u32> = HashMap::new();
    let mut team_playoff_sims: HashMap<String, u32> = HashMap::new();
    let mut total_games = vec![0.0f64; num_players * NUM_GAME_SLOTS];
    let mut total_pts = vec![0.0f64; num_players * NUM_GAME_SLOTS];

    let mut sim_cursor = 0usize;
    for shard in shards {
        let n = shard.sim_count;
        let dst_p = &mut sim_matrix[sim_cursor * num_players..(sim_cursor + n) * num_players];
        dst_p.copy_from_slice(&shard.sim_matrix);

        let dst_sw = &mut series_winners[sim_cursor * series_n..(sim_cursor + n) * series_n];
        dst_sw.copy_from_slice(&shard.series_winners);

        let dst_pi = &mut playin_seeds[sim_cursor * 4..(sim_cursor + n) * 4];
        dst_pi.copy_from_slice(&shard.playin_seeds);

        for (team, arr) in shard.team_round_reached {
            let entry = team_round_reached
                .entry(team)
                .or_insert_with(|| vec![0u8; total_sims]);
            entry[sim_cursor..sim_cursor + n].copy_from_slice(&arr);
        }

        merge_count_maps(&mut r1, shard.r1);
        merge_count_maps(&mut r2, shard.r2);
        merge_count_maps(&mut cf_map, shard.cf);
        merge_count_maps(&mut finals_map, shard.finals);
        merge_count_maps(&mut champ_map, shard.champ);
        merge_count_maps(&mut team_playoff_sims, shard.team_playoff_sims);

        for i in 0..total_games.len() {
            total_games[i] += shard.total_games[i];
            total_pts[i] += shard.total_pts[i];
        }

        sim_cursor += n;
    }

    // Seeds 1-6 always make the main bracket.
    for (s, t) in sim
        .bracket
        .east_seeds
        .iter()
        .chain(sim.bracket.west_seeds.iter())
    {
        if *s <= 6 {
            team_playoff_sims.insert(t.clone(), total_sims as u32);
        }
    }

    // Build team summaries.
    let n = total_sims as f64;
    let all_team_abbrs: Vec<String> = sim
        .bracket
        .east_seeds
        .iter()
        .chain(sim.bracket.east_playin.iter())
        .chain(sim.bracket.west_seeds.iter())
        .chain(sim.bracket.west_playin.iter())
        .map(|(_, t)| t.clone())
        .collect();

    // Use a fresh RNG just for rating calculations (matching TS, where a single
    // RNG is reused; we use a separate one to avoid mutating shard state).
    let mut tmp_rng = Rng::new(sim.config.seed.wrapping_add(0xdead_beef));

    let teams: Vec<TeamSimResult> = all_team_abbrs
        .iter()
        .map(|team| {
            let rating = get_team_rating(sim, team, &mut tmp_rng, 0);
            let east_seed = sim
                .bracket
                .east_seeds
                .iter()
                .find(|(_, t)| t == team)
                .map(|(s, _)| *s);
            let west_seed = sim
                .bracket
                .west_seeds
                .iter()
                .find(|(_, t)| t == team)
                .map(|(s, _)| *s);
            let conference = if east_seed.is_some() {
                Some("E".to_string())
            } else if west_seed.is_some() {
                Some("W".to_string())
            } else if sim.bracket.east_playin.iter().any(|(_, t)| t == team) {
                Some("E".to_string())
            } else if sim.bracket.west_playin.iter().any(|(_, t)| t == team) {
                Some("W".to_string())
            } else {
                None
            };
            TeamSimResult {
                team: team.clone(),
                full_name: sim
                    .bracket
                    .team_full_names
                    .get(team)
                    .cloned()
                    .unwrap_or_else(|| team.clone()),
                seed: east_seed.or(west_seed),
                conference,
                rating,
                r1: (*r1.get(team).unwrap_or(&0)) as f64 / n * 100.0,
                r2: (*r2.get(team).unwrap_or(&0)) as f64 / n * 100.0,
                cf: (*cf_map.get(team).unwrap_or(&0)) as f64 / n * 100.0,
                finals: (*finals_map.get(team).unwrap_or(&0)) as f64 / n * 100.0,
                champ: (*champ_map.get(team).unwrap_or(&0)) as f64 / n * 100.0,
            }
        })
        .collect();

    let mut teams_sorted = teams;
    teams_sorted.sort_by(|a, b| {
        b.champ
            .partial_cmp(&a.champ)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Build per-player projections (conditioned on team making the main bracket).
    let mut players_out: Vec<PlayerProjection> = Vec::new();
    let mut sorted_buf: Vec<f32> = vec![0.0; total_sims];

    for (col, p) in sim.players.iter().enumerate() {
        let base = col * NUM_GAME_SLOTS;
        // Per-(round,gameNum) raw totals, length 28.
        let mut games_by_game = vec![0.0f64; NUM_GAME_SLOTS];
        let mut pts_by_game = vec![0.0f64; NUM_GAME_SLOTS];
        let mut total_raw = 0.0f64;
        let mut any_games = 0.0f64;
        for i in 0..NUM_GAME_SLOTS {
            let g = total_games[base + i];
            let pt = total_pts[base + i];
            games_by_game[i] = g;
            pts_by_game[i] = pt;
            total_raw += pt;
            any_games += g;
        }
        if any_games == 0.0 {
            continue;
        }
        // Per-round rollup (length 4) for backward compat.
        let mut games = [0.0f64; 4];
        let mut pts = [0.0f64; 4];
        for r in 0..4 {
            for g in 0..7 {
                games[r] += games_by_game[r * 7 + g];
                pts[r] += pts_by_game[r * 7 + g];
            }
        }
        let divisor = (*team_playoff_sims
            .get(&p.team)
            .unwrap_or(&(total_sims as u32))) as f64;
        if divisor <= 0.0 {
            continue;
        }
        let mean_pts = total_raw / divisor;

        // Stddev + percentiles via sim matrix column.
        let mut sum_sq = 0.0;
        for sim_idx in 0..total_sims {
            let v = sim_matrix[sim_idx * num_players + col] as f64;
            sorted_buf[sim_idx] = sim_matrix[sim_idx * num_players + col];
            let diff = v - mean_pts;
            sum_sq += diff * diff;
        }
        let stddev = (sum_sq / total_sims as f64).sqrt();
        sorted_buf.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let p10 = sorted_buf[(0.1 * total_sims as f64).floor() as usize] as f64;
        let p90 = sorted_buf[(0.9 * total_sims as f64).floor() as usize] as f64;

        let projected_points_by_game: Vec<f64> = pts_by_game
            .iter()
            .map(|pt| pt / divisor)
            .collect();
        let projected_games_by_game: Vec<f64> = games_by_game
            .iter()
            .map(|g| g / divisor)
            .collect();
        players_out.push(PlayerProjection {
            espn_id: p.espn_id.clone(),
            name: p.name.clone(),
            team: p.team.clone(),
            ppg: p.ppg,
            mpg: p.mpg,
            projected_games: (games[0] + games[1] + games[2] + games[3]) / divisor,
            projected_points: mean_pts,
            projected_points_by_round: [
                pts[0] / divisor,
                pts[1] / divisor,
                pts[2] / divisor,
                pts[3] / divisor,
            ],
            projected_games_by_round: [
                games[0] / divisor,
                games[1] / divisor,
                games[2] / divisor,
                games[3] / divisor,
            ],
            projected_points_by_game,
            projected_games_by_game,
            stddev,
            p10,
            p90,
        });
    }

    players_out.sort_by(|a, b| {
        b.projected_points
            .partial_cmp(&a.projected_points)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    SimResults {
        teams: teams_sorted,
        players: players_out,
        sim_matrix,
        player_index: sim.player_index.clone(),
        player_ids: sim.player_ids.clone(),
        num_sims: total_sims,
        team_round_reached,
        series_winners,
        playin_seeds,
        team_names: sim.team_names.clone(),
        team_index: sim.team_index.clone(),
    }
}

/// Convenience: prepare + run.
pub fn run(data: SimData, config: SimConfig, parallel: bool) -> SimResults {
    let prepared = prepare(data, config);
    run_tournament_sim(&prepared, parallel)
}
