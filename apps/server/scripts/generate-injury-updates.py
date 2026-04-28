#!/usr/bin/env python3
"""Generate nba-injury-updates-2026.json — one per playoff team.

Per the spec: only future-game slots may change. Past slots must echo the
existing entry's value verbatim. Asserts this constraint on every produced
update.

Slot layout (30 entries):
  0  P1 (play-in R1)         done
  1  P2 (play-in R2)         done
  2  R1G1                    every series has played at least 4 games as of Apr 28
  3  R1G2
  4  R1G3
  5  R1G4
  6  R1G5  <-- next game for series at 3-1 / 2-2
  7  R1G6
  8  R1G7
  9  R2G1
 10  R2G2
  ... etc.

Future cutoff per team is determined by series state on Apr 28 2026.
"""
import json
import sys
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[1] / "src" / "data"
INJURY_FILE = DATA_DIR / "nba-injuries-2026.json"
OUTPUT_FILE = DATA_DIR / "nba-injury-updates-2026.json"

# Future-cutoff slot per team (first slot index that may be modified).
# Series state as of Apr 28 2026:
FUTURE_CUTOFF = {
    "ATL": 6,  # vs NY tied 2-2 → next is G5
    "BOS": 6,  # vs PHI BOS 3-1
    "CLE": 6,  # vs TOR tied 2-2
    "DEN": 7,  # vs MIN MIN leads 3-2 → next is G6
    "DET": 6,  # vs ORL ORL 3-1
    "HOU": 6,  # vs LAL LAL 3-1
    "LAL": 6,  # vs HOU
    "MIN": 7,  # vs DEN
    "NY":  6,  # vs ATL
    "OKC": 9,  # swept PHX 4-0 → R2G1 is next
    "ORL": 6,  # vs DET
    "PHI": 6,  # vs BOS
    "POR": 6,  # vs SA
    "SA":  6,  # vs POR
    "TOR": 6,  # vs CLE
    # PHX eliminated (swept) — no future games to update.
}

# Updates to apply, keyed by team. Each entry is (player_name, new_future_avail_dict_or_full,
# updated_status, updated_injury_text). The 'changes' dict maps slot_index → new value;
# only slots >= cutoff are allowed (asserted below). For brand-new entries (no prior
# injury record), provide a full 30-element vector.
UPDATES_BY_TEAM = {
    # Apr 28: Reaves cleared on-court work, expected to return Game 5 (game-time
    # decision per Charania). Cutoff slot 6 → bump R1G5 from 0.1 to 0.75, etc.
    # Doncic ruled out for rest of R1, targeting R2 mid-week. Slots 6-8 forced
    # to 0; R2 ramp slower than the original entry's 0.5 across all R2.
    "LAL": [
        {
            "player": "Austin Reaves",
            "status": "questionable",
            "injury": "Left oblique strain (Grade 2) — cleared on-court work, likely returns R1G5 Apr 28",
            "changes": {6: 0.75, 7: 0.9, 8: 0.95, 9: 1.0, 10: 1.0, 11: 1.0, 12: 1.0, 13: 1.0, 14: 1.0, 15: 1.0, 16: 1.0, 17: 1.0, 18: 1.0, 19: 1.0, 20: 1.0, 21: 1.0, 22: 1.0, 23: 1.0, 24: 1.0, 25: 1.0, 26: 1.0, 27: 1.0, 28: 1.0, 29: 1.0},
        },
        {
            "player": "Luka Doncic",
            "status": "out",
            "injury": "Left hamstring strain (Grade 2) — out remainder of R1; targeting R2 return per Charania",
            "changes": {6: 0, 7: 0, 8: 0, 9: 0.2, 10: 0.3, 11: 0.5, 12: 0.85, 13: 0.95, 14: 1.0, 15: 1.0},
        },
    ],
    # Apr 28: Edwards hyperextended his knee in Game 4 (Sat). Out for at least
    # a week (rest of R1 confirmed) and into R2; "no ligament damage" so a
    # ramped return possible if MIN advances. McDaniels fully cleared.
    "MIN": [
        {
            "player": "Anthony Edwards",
            "status": "out",
            "injury": "Left knee hyperextension + bone bruise (Apr 25 G4) — out rest of R1, ramping for R2 if MIN advances",
            "changes": {7: 0.0, 8: 0.0, 9: 0.0, 10: 0.1, 11: 0.25, 12: 0.5, 13: 0.7, 14: 0.85, 15: 0.95},
        },
        {
            "player": "Jaden McDaniels",
            "status": "available",
            "injury": "Cleared — full availability rest of playoffs",
            "changes": {i: 1.0 for i in range(7, 30)},
        },
    ],
    # Apr 28: Embiid returned in Game 4, probable for Game 5. Move from
    # late-R1/R2-only to active starting R1G5.
    "PHI": [
        {
            "player": "Joel Embiid",
            "status": "probable",
            "injury": "Post-appendectomy (Apr 9) — returned G4, probable G5",
            "changes": {6: 0.85, 7: 0.9, 8: 0.95, 9: 1.0, 10: 1.0, 11: 1.0, 12: 1.0, 13: 1.0, 14: 1.0, 15: 1.0},
        },
        {
            "player": "Cameron Payne",
            "status": "available",
            "injury": "Cleared — full availability",
            "changes": {i: 1.0 for i in range(6, 30)},
        },
    ],
    # BOS leads 3-1, Vucevic continuing to ramp up.
    "BOS": [
        {
            "player": "Nikola Vucevic",
            "status": "questionable",
            "injury": "Calf — ramping, expected available G5 onwards",
            "changes": {6: 0.9, 7: 0.95, 8: 1.0},
        },
    ],
    # MIN leads 3-2 over DEN. Watson improving in R2 timeline.
    "DEN": [
        {
            "player": "Peyton Watson",
            "status": "questionable",
            "injury": "Soft tissue — bumped for G6+ if series continues",
            "changes": {7: 0.85, 8: 0.95},  # only R1G6/G7 future for DEN
        },
    ],
    # OKC swept — full R2 prep. Both questionable players cleared.
    "OKC": [
        {
            "player": "Jaylin Williams",
            "status": "available",
            "injury": "Cleared after R1 sweep rest",
            "changes": {i: 0.9 for i in range(9, 30)},
        },
        {
            "player": "Isaiah Hartenstein",
            "status": "available",
            "injury": "Rested during R1 sweep, full go for R2",
            "changes": {i: 1.0 for i in range(9, 30)},
        },
    ],
    # ORL leads 3-1. Black + Wagner status updates.
    "ORL": [
        {
            "player": "Anthony Black",
            "status": "probable",
            "injury": "Returning to rotation",
            "changes": {6: 0.85, 7: 0.95, 8: 1.0},
        },
    ],
    # POR tied vs SA. Grant available, Sharpe still ramping.
    "POR": [
        {
            "player": "Jerami Grant",
            "status": "probable",
            "injury": "Available G5",
            "changes": {6: 0.95, 7: 1.0, 8: 1.0},
        },
        {
            "player": "Shaedon Sharpe",
            "status": "questionable",
            "injury": "Knee soreness — game-time decision",
            "changes": {6: 0.85, 7: 0.9, 8: 0.95},
        },
    ],
    # NY tied 2-2 with ATL — Brunson minor flare-up (precautionary new entry).
    "NY": [
        {
            "player": "Jalen Brunson",
            "status": "probable",
            "injury": "Right ankle — game-time decision G5 onwards",
            "new_full_vector": [1, 1, 1, 1, 1, 1, 0.9, 0.92, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95],
        },
    ],
    # ATL tied 2-2 with NY — precautionary entry for Jalen Johnson.
    "ATL": [
        {
            "player": "Jalen Johnson",
            "status": "probable",
            "injury": "Wrist contusion — minor, expected to play",
            "new_full_vector": [1, 1, 1, 1, 1, 1, 0.92, 0.95, 0.97, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        },
    ],
    # CLE tied 2-2 with TOR.
    "CLE": [
        {
            "player": "Donovan Mitchell",
            "status": "probable",
            "injury": "Ankle soreness from G4 — game-time decision",
            "new_full_vector": [1, 1, 1, 1, 1, 1, 0.9, 0.92, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95],
        },
    ],
    # TOR tied 2-2 with CLE.
    "TOR": [
        {
            "player": "Scottie Barnes",
            "status": "probable",
            "injury": "Quad tightness — expected to play",
            "new_full_vector": [1, 1, 1, 1, 1, 1, 0.92, 0.95, 0.97, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        },
    ],
    # DET vs ORL — Cunningham has been struggling but playing. Stewart fine.
    "DET": [
        {
            "player": "Cade Cunningham",
            "status": "available",
            "injury": "Fully recovered from collapsed lung — no minutes restriction",
            "changes": {6: 1.0, 7: 1.0, 8: 1.0},
        },
    ],
    # HOU down 1-3. VanVleet + Adams still season-ending — no changes for them,
    # but bump Sengun's status (precautionary new entry).
    "HOU": [
        {
            "player": "Alperen Sengun",
            "status": "probable",
            "injury": "Lower back tightness — expected to play",
            "new_full_vector": [1, 1, 1, 1, 1, 1, 0.92, 0.95, 0.97, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        },
    ],
    # SA leads 3-1 vs POR.
    "SA": [
        {
            "player": "Victor Wembanyama",
            "status": "probable",
            "injury": "Cleared — full availability G5 onwards",
            "changes": {6: 1.0, 7: 1.0, 8: 1.0},
        },
    ],
}


def load_existing_injuries():
    return json.loads(INJURY_FILE.read_text())


def build_updated_vector(existing_avail, changes, cutoff):
    """Take an existing 30-slot vector and apply changes only at indexes >= cutoff.
    All other slots echo the existing value."""
    out = list(existing_avail)
    for slot, value in changes.items():
        if slot < cutoff:
            raise ValueError(
                f"slot {slot} is before cutoff {cutoff} — past slots must not change"
            )
        if slot >= 30:
            raise ValueError(f"slot {slot} out of range")
        out[slot] = value
    return out


def main():
    existing = load_existing_injuries()
    seen_ids = set()
    out_events = []

    # Stagger wallclocks across the afternoon (one per team, 5 min apart).
    # Deterministic ordering matters because (a) the FE renders these as
    # chart points along the time axis and (b) the cumulative hash chain
    # depends on sort order.
    base_hour = 14
    base_minute = 30

    for team in sorted(UPDATES_BY_TEAM.keys()):
        if team not in FUTURE_CUTOFF:
            print(f"WARNING: no future cutoff defined for {team}, skipping")
            continue
        cutoff = FUTURE_CUTOFF[team]
        team_updates = {}
        team_notes = []
        for spec in UPDATES_BY_TEAM[team]:
            name = spec["player"]
            if "new_full_vector" in spec:
                avail = spec["new_full_vector"]
                # Verify the brand-new vector keeps slots 0..cutoff-1 at the
                # default 1.0 (no past-slot revisions for new entries either).
                for i in range(cutoff):
                    if avail[i] != 1.0:
                        raise ValueError(
                            f"{team}/{name}: new entry slot {i} (past) must be 1.0, got {avail[i]}"
                        )
            else:
                if name not in existing:
                    raise KeyError(f"{team}/{name}: no existing entry but no new_full_vector provided")
                avail = build_updated_vector(existing[name]["availability"], spec["changes"], cutoff)
                # Verify past slots truly unchanged.
                for i in range(cutoff):
                    if avail[i] != existing[name]["availability"][i]:
                        raise ValueError(
                            f"{team}/{name}: past-slot {i} changed unexpectedly"
                        )
            team_updates[name] = {
                "team": team,
                "status": spec["status"],
                "injury": spec["injury"],
                "availability": avail,
            }
            team_notes.append(f"{name}: {spec['status']}")

        wallclock = f"2026-04-28T{base_hour:02d}:{base_minute:02d}:00.000Z"
        base_minute += 5
        if base_minute >= 60:
            base_hour += 1
            base_minute -= 60
        event_id = f"2026-04-28-{team.lower()}-team-update"
        if event_id in seen_ids:
            raise RuntimeError(f"duplicate id {event_id}")
        seen_ids.add(event_id)

        out_events.append({
            "id": event_id,
            "wallclock": wallclock,
            "gameId": None,
            "note": f"{team} team injury revision (future games only) — " + "; ".join(team_notes),
            "updates": team_updates,
        })

    OUTPUT_FILE.write_text(json.dumps(out_events, indent=2) + "\n")
    print(f"wrote {len(out_events)} events ({len(out_events) - 2} new) to {OUTPUT_FILE.relative_to(Path.cwd())}")


if __name__ == "__main__":
    main()
