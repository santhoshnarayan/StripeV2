# Batch Auction Simulator Architecture (Backend + Chrome)

## Goal
Design a simulation system that can:

1. Produce authoritative recommendations once per batch auction round on the backend.
2. Allow users to rerun the same logic locally in Chrome for what-if scenarios.
3. Handle variable number of players per round.
4. Explain strategy recommendations (stacking, blocking, upside vs. floor) rather than only outputting numeric values.

## Scope
This proposal focuses on architecture, data contracts, and runtime strategy. It does not include implementation details for every model parameter.

## Core Design Principles
- **One engine, two runtimes:** keep simulation and optimization logic in a shared core package and execute it in backend and browser wrappers.
- **Deterministic execution:** same state + model + seed should produce the same result envelope.
- **State-aware recommendations:** values are conditional on current rosters, budgets, and remaining players.
- **Portfolio optimization:** in batch auctions, optimize a vector of bids per round, not independent single-player bids.

---

## High-Level Architecture

### Shared Core (`packages/sim-core`)
Responsible for pure simulation logic:
- Auction state transitions.
- Bid vector evaluation.
- Correlated player outcome sampling.
- Bracket/game outcome sampling.
- Recommendation scoring and explanations.

The core should have no network or database calls.

### Backend Service (`apps/server`)
Authoritative recommendation engine:
- Loads current league state from DB.
- Loads calibrated model parameters.
- Runs fast recommendation pass synchronously.
- Optionally performs deeper async refinement.
- Persists recommendation metadata (`state_hash`, `model_version`, `seed`).

### Browser Worker (`apps/web`)
User rerun / what-if engine:
- Runs the same core in a Web Worker.
- Uses server-provided model bundle and current league snapshot.
- Displays local rerun as advisory and labels it clearly.

---

## Auction Round Model (Batch)
At round `t`, input includes variable-sized `batch_players` list.

Decision variable per team:

```text
b_t = [bid(p1), bid(p2), ..., bid(pk)]
```

where `k = len(batch_players)` for that round.

Optimization target:
- Maximize expected utility after resolving the round under uncertain opponent bids.
- Utility can be configured as title probability, EV, or a risk-adjusted blend.

Constraints:
- Remaining budget.
- Roster slots remaining.
- Optional exposure caps (e.g., max players from same real team).

---

## Data Contract

### Request: `SimRequest`
```json
{
  "league_state": {
    "teams": [],
    "budgets": {},
    "rosters": {},
    "slots_remaining": {}
  },
  "round": {
    "round_id": "r12",
    "batch_players": []
  },
  "model": {
    "player_params": {},
    "team_params": {},
    "covariance_factors": {}
  },
  "opponent_policy": {
    "team_policy_priors": {}
  },
  "config": {
    "sim_count": 3000,
    "seed": 1234,
    "risk_profile": "balanced"
  }
}
```

### Response: `SimResponse`
```json
{
  "state_hash": "...",
  "engine_version": "...",
  "model_version": "...",
  "recommendations": [
    {
      "label": "Balanced",
      "bid_vector": {},
      "expected_spend": 0,
      "win_probability_delta": 0,
      "risk": {
        "variance": 0,
        "p10": 0,
        "p90": 0
      },
      "explanations": [
        "Stack synergy with Team X core",
        "Low budget-lock risk"
      ]
    }
  ],
  "confidence": {
    "stability": 0,
    "notes": []
  }
}
```

---

## Simulation Pipeline

1. **Precompute factors**
   - Build latent team performance factors from ORtg/DRtg.
   - Build player means/variance and pairwise/team correlation factors.

2. **Generate candidate bid vectors**
   - Discretize per-player bids into levels: `[0, fair, aggressive, max]`.
   - Compose portfolio candidates using beam/stochastic search.

3. **Evaluate each candidate**
   - Simulate opponent bids and winner outcomes for the round.
   - For each outcome, roll forward remaining tournament/player outcomes.
   - Compute utility and risk metrics.

4. **Rank and explain**
   - Return top N bid vectors with concise rationale:
     - stack value,
     - denial value,
     - budget flexibility,
     - downside profile.

5. **Adaptive stopping**
   - Stop early when ranking confidence reaches threshold.

---

## Strategy Explanation Model
Each recommendation includes components:

```text
score = w1*title_odds_delta + w2*expected_value + w3*denial_value + w4*stack_synergy - w5*budget_lock_penalty
```

Expose components in UI so users understand *why* a recommendation appears.

---

## Opponent Advice / Transparency Modes
Support two league modes:

1. **Private mode**
   - Users see only their own recommendations.
2. **Open mode**
   - Users can view projected recommendation envelopes for other teams.

Open mode should still hide sensitive internals while exposing strategic shape (e.g., likely target set, likely price range).

---

## Backend vs Browser Responsibility Split

### Backend (required)
- Official recommendation used by league workflow.
- Canonical state and versioning.
- Audit logs and reproducibility.

### Browser (optional but useful)
- User-driven what-if reruns.
- Personal strategy exploration.
- Fast local experimentation without backend queue load.

Label browser output as `advisory_local` and include version mismatch warning when applicable.

---

## Performance Targets
- Synchronous backend pass: 0.5s–2s (1k–3k sims + cached factors).
- Async refinement: 3s–20s (10k+ sims).
- Browser worker rerun: 1s–5s depending device.

For very large batches, prefilter candidate player set per team to maintain latency.

---

## API Endpoints (Proposed)
- `POST /api/sim/recommend-batch`
- `POST /api/sim/what-if`
- `GET /api/sim/model-bundle?leagueId=...`

`model-bundle` returns a signed payload with model params and version for browser execution.

---

## Rollout Plan
1. **Phase 1**: backend-only recommendations for each batch close.
2. **Phase 2**: what-if endpoint + UI explanation cards.
3. **Phase 3**: browser worker reruns using model bundle.
4. **Phase 4**: optional open-opponent-advice mode with league setting.

---

## Testing Strategy
- Unit tests for deterministic simulation steps with fixed seeds.
- Property tests for constraint safety (budget/slots never violated).
- Golden tests for recommendation stability.
- Cross-runtime parity tests (backend vs browser on same seed/model/state).

---

## Risks and Mitigations
- **Model drift across runtimes:** strict versioning and parity tests.
- **Latency spikes with large batches:** candidate pruning + adaptive stopping.
- **User distrust of black box:** explanation components and scenario diffs.
- **Gaming concerns in open mode:** configurable visibility controls.

---

## Summary
A shared-core dual-runtime architecture gives:
- reproducible authoritative backend decisions,
- fast user-side strategy reruns,
- robust handling for variable-sized batch rounds,
- recommendations that are explainable and actionable.
