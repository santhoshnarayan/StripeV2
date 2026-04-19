//! Wasm bindings for the NBA simulator. Compiled only on `wasm32-*` targets.
//!
//! The JS side hands us a JSON blob that matches `SimData` (same shape served
//! by `/api/app/sim-data` plus a `liveGames` field). We return a `WasmSimResults`
//! handle that exposes typed-array getters so the worker can post the heavy
//! buffers (sim_matrix, series_winners, etc.) back to the main thread without
//! a per-element JS conversion.
//!
//! Single-threaded only — no Rayon. Run inside a Web Worker.

use wasm_bindgen::prelude::*;

use crate::{run, SimConfig, SimData, SimResults, SERIES_KEYS};

const PLAYIN_KEYS: [&str; 4] = ["east7", "east8", "west7", "west8"];

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct WasmSimResults {
    inner: SimResults,
}

#[wasm_bindgen]
impl WasmSimResults {
    #[wasm_bindgen(getter, js_name = numSims)]
    pub fn num_sims(&self) -> u32 {
        self.inner.num_sims as u32
    }

    /// JSON-shaped array of `TeamSimResult`.
    #[wasm_bindgen(getter)]
    pub fn teams(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.teams).map_err(Into::into)
    }

    /// JSON-shaped array of `PlayerProjection`.
    #[wasm_bindgen(getter)]
    pub fn players(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.players).map_err(Into::into)
    }

    /// Stable list of team abbreviations indexed by the `*_winners` arrays.
    #[wasm_bindgen(getter, js_name = teamNames)]
    pub fn team_names(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.team_names).map_err(Into::into)
    }

    /// `{ alias: idx }` lookup into `team_names`.
    #[wasm_bindgen(getter, js_name = teamIndex)]
    pub fn team_index(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.team_index).map_err(Into::into)
    }

    /// Espn ID → column index in `simMatrix`.
    #[wasm_bindgen(getter, js_name = playerIndex)]
    pub fn player_index(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.player_index).map_err(Into::into)
    }

    /// Float32 [sims × players] matrix of fantasy points.
    #[wasm_bindgen(getter, js_name = simMatrix)]
    pub fn sim_matrix(&self) -> js_sys::Float32Array {
        let arr = js_sys::Float32Array::new_with_length(self.inner.sim_matrix.len() as u32);
        arr.copy_from(&self.inner.sim_matrix);
        arr
    }

    /// Per-series winner indices, row-major `[sim, series]` packed into a single
    /// Uint8Array. JS slices it into per-series Uint8Arrays using `seriesKeys()`.
    #[wasm_bindgen(getter, js_name = seriesWinnersFlat)]
    pub fn series_winners_flat(&self) -> js_sys::Uint8Array {
        let src = &self.inner.series_winners;
        let arr = js_sys::Uint8Array::new_with_length(src.len() as u32);
        let buf: Vec<u8> = src.iter().map(|&v| if v == u16::MAX { 255 } else { v as u8 }).collect();
        arr.copy_from(&buf);
        arr
    }

    /// Per-sim play-in seed assignment, row-major `[sim, slot]` packed Uint8Array
    /// (4 slots per sim: east7, east8, west7, west8 — see `playinKeys()`).
    #[wasm_bindgen(getter, js_name = playinSeedsFlat)]
    pub fn playin_seeds_flat(&self) -> js_sys::Uint8Array {
        let src = &self.inner.playin_seeds;
        let arr = js_sys::Uint8Array::new_with_length(src.len() as u32);
        let buf: Vec<u8> = src.iter().map(|&v| if v == u16::MAX { 255 } else { v as u8 }).collect();
        arr.copy_from(&buf);
        arr
    }

    /// `{ team: Uint8Array(numSims) }` — round reached per sim per team (0..=5).
    #[wasm_bindgen(getter, js_name = teamRoundReached)]
    pub fn team_round_reached(&self) -> Result<JsValue, JsValue> {
        let obj = js_sys::Object::new();
        for (team, vec) in &self.inner.team_round_reached {
            let arr = js_sys::Uint8Array::new_with_length(vec.len() as u32);
            arr.copy_from(vec);
            js_sys::Reflect::set(&obj, &JsValue::from_str(team), &arr.into())?;
        }
        Ok(obj.into())
    }

    /// Series-key labels in the order `seriesWinnersFlat` uses.
    #[wasm_bindgen(js_name = seriesKeys)]
    pub fn series_keys() -> Vec<JsValue> {
        SERIES_KEYS.iter().map(|k| JsValue::from_str(k)).collect()
    }

    /// Play-in slot labels in the order `playinSeedsFlat` uses.
    #[wasm_bindgen(js_name = playinKeys)]
    pub fn playin_keys() -> Vec<JsValue> {
        PLAYIN_KEYS.iter().map(|k| JsValue::from_str(k)).collect()
    }
}

/// Run a sim from a JSON-encoded `SimData` blob. `sims_override` lets the
/// caller dial the Monte Carlo count without re-encoding the config.
#[wasm_bindgen(js_name = runSim)]
pub fn run_sim(data_json: &str, sims_override: Option<u32>) -> Result<WasmSimResults, JsValue> {
    let data: SimData = serde_json::from_str(data_json)
        .map_err(|e| JsValue::from_str(&format!("invalid SimData JSON: {e}")))?;
    let mut config = SimConfig::default();
    if let Some(s) = sims_override {
        config.sims = s as usize;
    }
    let inner = run(data, config, false);
    Ok(WasmSimResults { inner })
}
