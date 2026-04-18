# Simulator Plan

State-aware batch auction simulator with correlated outcomes, live strategy recommendations, and dual backend/browser execution.

## 1) Build a Probabilistic Outcome Model

Instead of using point projections (for example, `Player X = 42`), model each player as a distribution:

- Mean from WAR / ORtg / DRtg plus minutes and usage assumptions
- Variance from injury risk, role volatility, and playoff volatility
- Correlation with teammates, opponents, and team performance

Correlations are critical:

- Same-team players are often positively correlated through team success shocks
- Some pairs are negatively correlated (shared usage caps, substitution effects)

Use a latent team-factor model:

`S_i = mu_i + beta_i * T_team(i) + epsilon_i`

Where:

- `S_i`: player fantasy output (or utility)
- `T_team(i)`: latent team performance shock
- `epsilon_i`: player-specific noise

This naturally creates stacking effects.

## 2) Simulate Bracket + Player Outcomes Jointly

Given bracket structure plus team ORtg/DRtg:

1. Convert ORtg/DRtg into team strength (for example logistic/Elo-like win probabilities)
2. Simulate bracket games many times
3. Conditional on advancement, sample player outcomes from the model above

Outputs:

- Distribution of each team's final fantasy score
- Distribution of each manager's finish probability (1st/top-k)

## 3) Make Player Valuations State-Dependent

At any auction state (current rosters, budgets, remaining pool), define marginal value:

`DeltaWP_m,p = P(win | manager m gets player p) - P(win | manager m gets replacement)`

Then convert to dollars:

`MaxBid_m,p ~= lambda_m * DeltaWP_m,p`

Where `lambda_m` is the manager's marginal value of money/roster flexibility, learned from continuation simulations.

In auction formats (unlike snake), value depends on:

- Price path and budget opportunity cost
- Which opponents can still buy the player
- Remaining player pool

## 4) Estimate Opponent Valuations

Run the same marginal win-probability valuation for every opponent:

- "Team A should value Player X at $17"
- "Team B only at $6 because of existing same-team exposure"
- "Team C at $21 due to fit/hedge needs"

Use this to surface:

- Expected bidding wars
- Likely overpay spots
- Strategic nomination opportunities

## 5) Strategy Layer on Top of Valuation

Add a policy engine that converts value into action:

- Who to target now
- How much to bid
- Why (stack leverage, denial value, floor/ceiling balance, budget pressure)
- What to do if target is lost (fallback tree)

Example recommendation:

> Primary: Bid up to $18 on Player A.  
> If lost above $18, pivot to Player B ($13) or Player C ($11).  
> Reason: +2.4% title odds, mostly from Team X stack correlation.

## 6) Pre-Draft (Iteration 0) Strategy Packs

Generate strategy archetypes before any picks:

- High-upside stack strategy
- Balanced EV strategy
- Anti-fragile diversification strategy
- Block/deny strategy

For each team, show:

- Top 10 targets with fair/aggressive/walk-away prices
- Preferred stack combos (2-man, 3-man)
- "Don't pair" combos (negative correlation, role conflicts)
- Budget curve by phase (early/mid/late)

## 7) Live Updates After Each Auction Event

After every event, run fast updates:

- Team win probabilities
- Per-player max bids
- Opportunity score (value vs market)
- Urgency score (chance target disappears)
- Leverage score (impact on standings dispersion)

Performance pattern:

- Full re-sim every 3-5 events
- Incremental approximations between full runs

## 8) Transparency Modes and What-If Lab

### Advice Visibility

- Private mode: each team sees only own advice
- Open intel mode: projected advice for all teams

Open intel enables strategic nomination and bid blocking.

### Scenario Sandbox

Allow user-triggered reruns:

- "What if I buy Player A at $19?"
- "What if Team B gets both Team X stars?"
- "What if I switch from stack to diversify now?"

Return:

- Updated title odds
- Percentile finish distributions
- Risk profile (variance/downside tail)
- Sensitivity to bracket outcomes

## 9) Batch Auction Modeling (Core Difference)

In batch auctions, the decision variable is a **bid vector**, not independent bids:

`b = (b_1, b_2, ..., b_k)` over all players in the current batch.

### Objective

Choose `b` to maximize expected post-round win probability:

`maximize_b E[WP(after round)]`

Subject to:

- Worst-case spend <= remaining budget
- Feasible roster slot outcomes
- Position/exposure constraints (if any)

### Uncertain Round Outcomes

For each bid vector, simulate opponent bids and evaluate possible outcomes:

- Win none / one / several players
- Resulting budget + roster state
- Downstream title odds from each resulting state

Expected value:

`EV(b) = sum_over_outcomes_o P(o | b) * WP(o)`

### Interaction Terms (Non-Additivity)

Value is not additive in batch settings:

`V(A, B) != V(A) + V(B)`

Need pairwise (or limited higher-order) synergy terms for:

- Positive stack upside
- Over-concentration risk
- Flexibility cost of winning both

## 10) Practical Solver for Live Use

Avoid brute force:

1. **Candidate generation**: 3-5 bid levels per player (`0`, fair, aggressive, max)
2. **Portfolio search**: beam search or stochastic local search over bid vectors
3. **Monte Carlo scoring**: simulate opponent responses and downstream outcomes
4. **Output top N portfolios**: conservative / balanced / upside

Example output format:

- **Portfolio A (Balanced)**  
  `P1: $14, P2: $9, P3: $0, P4: $6`  
  Win probs: `42% / 35% / 18%`  
  Expected spend: `$11.8`  
  Title odds delta: `+2.1%`

- **Portfolio B (Stack Upside)**  
  `P1: $17, P2: $14, others: $0`  
  Chance win both: `19%`  
  Title odds delta: `+3.0%`  
  Downside: high variance, budget lock

- **Portfolio C (Deny Rival)**  
  Lower direct synergy, high suppression effect  
  Title odds delta: `+1.6% direct, +1.1% rival suppression`

## 11) Backend vs Frontend Responsibilities

### Backend (Authoritative)

- Auction state machine
- Opponent bid models
- Monte Carlo engine
- Batch portfolio optimizer
- Caching / precomputation
- Recommendation APIs

Why: deterministic source of truth, heavy compute, auditability.

### Frontend (Thin Intelligence)

- Render recommendations/explanations
- Risk preference controls (safe/balanced/upside)
- Trigger what-if requests
- Visualize confidence and scenarios

Do not make frontend the authoritative simulator.

## 12) Simulation Counts and Latency

You do not need massive simulation counts at all times.

Suggested ranges:

- Live default: `1,000-5,000` sims/decision
- High-confidence async refresh: `10,000-25,000`
- Pre-draft overnight prep: `50,000+`

Use adaptive stopping:

- Stop when ranking of top portfolios stabilizes
- Stop early when confidence bands separate clearly

## 13) Variable Players Per Round

Batch size can vary (`2`, `7`, `20`, ...). Model each round as variable-size batch `k_t`.

At round `t`:

- Input current state + player set `P_t`
- Generate bid vectors only over `P_t`
- Enforce worst-case spend constraints

For large `k_t`:

- Pre-filter to top `M` relevant players per team (`M = 8-12`)
- Add token bids for longshots
- Optimize only on reduced set for stable latency

## 14) Recommended Runtime Pattern

- **Sync API path (fast)**: return in `< 1-2s` using cache + incremental `1k-3k` sims
- **Async worker path (refine)**: run deeper sims in background and push updates
- **State versioning**: tie every recommendation to auction-state hash

## 15) Dual-Runtime Architecture (Backend + Chrome)

Design one shared core with two execution targets.

### Core Principle: One Engine, Two Runtimes

Shared `auction-sim-core` should be:

- Pure function based
- Deterministic (seeded)
- JSON schema input/output
- Variable batch-size capable

Wrapped by:

- `sim-service` (backend API)
- `sim-web` (Web Worker/WASM in Chrome)

### Shared Data Contract

Input:

- `league_state`: teams, budgets, roster slots, drafted players
- `batch_players`: current batch
- `player_model`: means/variance/covariance factors
- `opponent_model`: bid priors
- `sim_config`: sim count, risk profile, seed

Output:

- `recommendations`: top bid portfolios
- `explanations`: EV, delta win prob, stack/deny/flexibility components
- `confidence`: uncertainty bands
- `debug`: state hash, seed, runtime metadata

### Backend Implementation

Components:

- State loader (DB)
- Precompute cache (covariance, bracket priors)
- Portfolio generator
- Monte Carlo evaluator
- Ranker/explainer
- Redis cache by state hash

Execution:

- Trigger once per batch open/close
- Return quick initial answer (`1k-3k` sims)
- Async refine (`10k+`) via websocket update

### Chrome Local Rerun Implementation

Options:

- **Best performance**: Rust core -> WASM
- **Best velocity**: TypeScript core shared in Node/browser

Browser execution:

- Run in Web Workers
- Use worker parallelism and optional WebGPU acceleration
- Keep seeded determinism

### Consistency Controls

To keep backend and local reruns aligned:

- Same core version + model version
- Same seed/config -> same result (within float tolerance)
- Include `engine_version`, `model_version`, `state_hash`
- Label outputs clearly:
  - Official (backend)
  - Local rerun (browser)

### Performance Targets

- Backend initial: `0.5-2.0s`
- Browser rerun: `1-5s` device-dependent
- Modes: `quick (1k)`, `normal (3k-5k)`, `deep (10k+)`

## 16) Suggested Repo Structure

```txt
/packages
  /sim-core            # shared engine + schemas + tests
  /sim-models          # calibration, priors, covariance builder
/services
  /sim-api             # backend endpoints, cache, queue
/apps
  /web                 # UI + worker orchestration
  /web-sim-worker      # browser execution wrapper
```

## 17) Suggested API Endpoints

- `POST /sim/recommend` - authoritative backend recommendation for current batch
- `POST /sim/whatif` - evaluate a user-proposed bid portfolio
- `POST /sim/local-config` - return signed/versioned model package for browser reruns

## 18) Security / Integrity

If league integrity matters:

- Backend outputs are official
- Browser outputs are advisory
- Sign model payloads
- Restrict exposure of private opponent priors
- Rate-limit what-if calls

## Next Deliverables

Potential next artifacts:

1. TypeScript interface file for shared input/output schema
2. `recommend_batch()` pseudocode that runs identically in Node and Chrome Worker