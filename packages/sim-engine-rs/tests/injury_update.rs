//! Integration test: injury_updates folded over the base injuries map are
//! reflected in the prepared per-team availability mask cache. Verifies the
//! Rust side of the new event type from the user's spec.

use std::collections::HashMap;

use sim_engine_rs::{prepare, InjuryEntry, InjuryUpdate, SimConfig, SimData};

fn empty_data() -> SimData {
    SimData {
        bracket: serde_json::from_str(
            r#"{
              "eastSeeds": [], "westSeeds": [],
              "eastPlayin": [], "westPlayin": [],
              "seriesPattern": [true, true, false, false, true, false, true],
              "teamAliases": {}, "teamFullNames": {}
            }"#,
        )
        .unwrap(),
        net_ratings: HashMap::new(),
        sim_players: vec![],
        playoff_minutes: HashMap::new(),
        adjustments: vec![],
        injuries: {
            let mut m = HashMap::new();
            // Pre-existing injury — Reaves at 0.1 in R1G5 (slot 6).
            m.insert(
                "Austin Reaves".to_string(),
                serde_json::json!({
                    "team": "LAL",
                    "status": "out",
                    "injury": "oblique",
                    "availability": [0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.2, 0.35,
                                     0.5, 0.65, 0.8, 0.9, 0.95, 1.0, 1.0, 1.0,
                                     1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
                                     1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
                }),
            );
            m
        },
        injury_updates: vec![],
        live_games: vec![],
        actuals_by_game: HashMap::new(),
    }
}

#[test]
fn injury_update_replaces_existing_entry() {
    // Apply a fresh update bumping Reaves's R1G5 from 0.1 to 0.75.
    let mut data = empty_data();
    let mut update_map = HashMap::new();
    update_map.insert(
        "Austin Reaves".to_string(),
        Some(InjuryEntry {
            team: "LAL".to_string(),
            status: "questionable".to_string(),
            injury: "oblique — likely returns G5".to_string(),
            availability: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.75, 0.9, 0.95, 1.0, 1.0, 1.0, 1.0,
                1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
                1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
            ],
        }),
    );
    data.injury_updates = vec![InjuryUpdate {
        id: "test-update".to_string(),
        wallclock: "2026-04-28T14:30:00Z".to_string(),
        game_id: None,
        updates: update_map,
        note: Some("Reaves bumped".to_string()),
    }];

    let prepared = prepare(data, SimConfig::default());
    let entry = prepared.injuries_by_name.get("Austin Reaves").unwrap();
    assert_eq!(
        entry.availability[5], 0.75,
        "post-update Reaves R1G5 should be 0.75, got {}",
        entry.availability[5]
    );
    assert_eq!(entry.status, "questionable");
}

#[test]
fn injury_update_with_none_clears_entry() {
    let mut data = empty_data();
    let mut update_map = HashMap::new();
    update_map.insert("Austin Reaves".to_string(), None);
    data.injury_updates = vec![InjuryUpdate {
        id: "clear-update".to_string(),
        wallclock: "2026-04-28T14:30:00Z".to_string(),
        game_id: None,
        updates: update_map,
        note: None,
    }];

    let prepared = prepare(data, SimConfig::default());
    assert!(
        !prepared.injuries_by_name.contains_key("Austin Reaves"),
        "None entry should clear pre-existing injury"
    );
}

#[test]
fn injury_update_last_write_wins() {
    let mut data = empty_data();
    let mut first = HashMap::new();
    first.insert(
        "Austin Reaves".to_string(),
        Some(InjuryEntry {
            team: "LAL".to_string(),
            status: "out".to_string(),
            injury: "first".to_string(),
            availability: vec![0.5; 30],
        }),
    );
    let mut second = HashMap::new();
    second.insert(
        "Austin Reaves".to_string(),
        Some(InjuryEntry {
            team: "LAL".to_string(),
            status: "questionable".to_string(),
            injury: "second".to_string(),
            availability: vec![0.9; 30],
        }),
    );
    data.injury_updates = vec![
        InjuryUpdate {
            id: "first".to_string(),
            wallclock: "2026-04-28T13:00:00Z".to_string(),
            game_id: None,
            updates: first,
            note: None,
        },
        InjuryUpdate {
            id: "second".to_string(),
            wallclock: "2026-04-28T15:00:00Z".to_string(),
            game_id: None,
            updates: second,
            note: None,
        },
    ];

    let prepared = prepare(data, SimConfig::default());
    let entry = prepared.injuries_by_name.get("Austin Reaves").unwrap();
    assert_eq!(entry.injury, "second", "last write should win");
    assert_eq!(entry.availability[0], 0.9);
}
