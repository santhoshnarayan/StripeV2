# Live Chart + Simulator Follow-ups

Handoff spec for the remaining chart + simulator redesign work on the `live-nba-scoring` branch.

**What's done:**
- NCAAM-inspired chart at `apps/web/components/league/league-chart-panel.tsx` with 3 modes x 3 resolutions + round filter, scoreboard row rendered beneath.
- Sim hook `apps/web/lib/use-auto-sim.ts` has a debounced event queue exposing `pendingEvents`.
- New gradient leaderboard at `apps/web/components/league/simulator-leaderboard.tsx`.
- Timeseries endpoint `GET /leagues/:leagueId/timeseries` in `apps/server/src/routes/app.ts` returns `{managers, checkpoints[]}`; checkpoints now carry `eventText`, `homeScore`, `awayScore` and are filtered to games on/after `R1_FLOOR_DATE` (2026-04-19) to exclude play-in plays.

**What's left (in recommended work order):** the six tasks below. The first two are blocking for correctness; 3 and 4 are visual parity with the NCAAM reference; 5 and 6 are small polish items.

**Global constraints (apply to every task):**
- Do NOT `railway up` or trigger any Railway deploy without explicit user approval. All backend changes stay local until the user says otherwise.
- Drizzle migrations only. If any task requires a schema change, use `pnpm --filter @stripev2/db db:generate` + `db:migrate` — never hand-edit SQL.
- Backward-compat: all backend additions must be additive. The currently deployed frontend must continue to work against an updated backend (do not rename/remove fields, only add new ones).
- Reference implementation for chart + scoreboard interactions: `/Users/santhoshnarayan/Developer/explore/misc/sports/espn/mens-college-basketball/playground_web/` (especially `src/app/chart/page.tsx`).

---

## Task 1: Fix projection mode math for best-of-7 series

### Problem
In `LeagueChartPanel`, the projection line currently splits a round's projected points evenly across every scheduled game slot for that round:

```
perSlot = rounds[roundIdx[r]] / gs.length
```

In best-of-7 this is wrong: not every scheduled slot is actually played. A series can end in 4, 5, 6, or 7 games — expected length is roughly ~5.2 games. Dividing by `gs.length` (which is whatever max game slots were pre-scheduled, typically 7 per series) understates per-game contribution and makes the projection curve sag below the actuals even when the sim is tracking correctly.

### Acceptance criteria
- Projection line for completed games matches actuals to within rounding once the per-series game count is known.
- For in-progress rounds, each remaining game's projected delta is weighted by the probability that game will actually be played (i.e. the series has not yet ended at that game index).
- Works across all four series keys: `r1`, `r2`, `cf`, `finals`.
- Degrades gracefully when sim data is missing — fall back to the current even-split behavior.

### Implementation notes
Two viable approaches; pick one:

**Option A (preferred): backend precomputes per-game projection.**
Extend the `/leagues/:leagueId/timeseries` response with:
```
projectedByGame: Record<gameId, Record<userId, number>>
```
Compute on the server from the sim's per-series game count distribution (the sim already enumerates outcomes to produce `projectedPointsByRound`). For each scheduled game in a series, the per-user contribution is the expected points that user earns in that specific game slot, which is `sum over outcomes where series reaches game N of (points_user_earns_in_game_N * prob(outcome))`.

This keeps the client simple and is additive (old clients just ignore the new key).

**Option B: send the distribution, compute on the client.**
Add `seriesOutcomeDistribution: Record<seriesKey, Array<{gamesPlayed: number, prob: number, ...}>>` to the response; client multiplies per-slot by `P(series reaches this game)`. More flexible but more client math and more payload.

Either way, replace the `rounds[roundIdx[r]] / gs.length` line in `LeagueChartPanel` with a lookup keyed by `game.id` + `userId`.

### Files
- `apps/web/components/league/league-chart-panel.tsx` — projection-line math.
- `apps/web/lib/use-auto-sim.ts` — may need to surface additional sim fields.
- `apps/server/src/routes/app.ts` — `/leagues/:leagueId/timeseries` handler (Option A).
- `apps/server/src/` simulator module (wherever `ManagerProjection` / per-series outcome enumeration lives) — needed to derive per-game expected points.

---

## Task 2: Chart <-> scoreboard card hover sync

### Problem
The chart and the scoreboard row below it are visually adjacent but don't cross-communicate on hover. Users can't see "which game does this tooltip correspond to?" or "what did the chart look like when this game tipped?".

### Acceptance criteria
- Hovering a point on the chart highlights the matching `ScoreboardCard` (ring + subtle scale-up).
- Hovering a `ScoreboardCard` drives the chart's tooltip/active index to that game's `t`.
- Works for both past and in-progress games.
- No flicker when moving between chart and cards (use a shared state source).

### Implementation notes
Lift hover state up into `LeagueChartPanel`:
```ts
const [hoveredGameId, setHoveredGameId] = useState<string | null>(null);
```
- Chart side: Recharts `<LineChart onMouseMove={(state) => {...}}>` exposes `activeLabel` and `activeTooltipIndex`. Map `activeLabel` (the checkpoint `t`) -> `gameId` via the checkpoint array, then `setHoveredGameId`.
- Card side: pass `hoveredGameId` + `setHoveredGameId` down to each `ScoreboardCard`. On card `onMouseEnter`, set the id; also compute the chart index for that game and set Recharts' active tooltip (either by controlling `<Tooltip active={...}>` or by passing `activeIndex` into the `<Line>` component).
- Reference pattern is in `playground_web/src/app/chart/page.tsx` — it does exactly this lift-state-up dance.

### Files
- `apps/web/components/league/league-chart-panel.tsx` — own the shared state, wire `onMouseMove` and prop-drill into scoreboard row.
- `ScoreboardCard` component (inside `league-chart-panel.tsx` or a sibling file) — accept `isHovered` + `onHover` props; add ring/scale styles.

---

## Task 3: Redesign ScoreboardCard with NCAAM formatting

### Problem
Current scoreboard cards are ~92px wide and show only team abbreviations + scores. The NCAAM reference has richer, wider cards (~140-160px) showing seeds, team logos, win% badges, and a latest-event footer line. The `eventText` field is now available on every checkpoint but isn't surfaced visually.

### Acceptance criteria
- Card width grows to ~140-160px (responsive: allow shrinking but target this on desktop).
- Shows seed prefix (e.g. "1" / "8"), team logo, abbrev, score, for each team.
- Shows a win% badge if the sim exposes a per-game win probability (otherwise omit cleanly).
- New bottom row renders the most recent `eventText` for that game, truncated with ellipsis if needed.
- Visual language matches the NCAAM `playground_web` game-card (gradients, border treatment, typography scale).
- Completed games render with final-state styling distinct from in-progress.

### Implementation notes
- The latest `eventText` per game = the last checkpoint for that `gameId`. Build a `latestEventByGame: Map<gameId, string>` once from the checkpoints array.
- Per-game win% would need the sim to expose it; if Task 1 (Option A) already ships a `projectedByGame`, consider piggybacking `winProbByGame` on the same response. Otherwise render without the badge for now and leave a TODO.
- Keep the card a pure-presentational component so Task 2's hover prop slots in cleanly.
- Seeds and logos are already available on the game/team records — check the same source `LeagueChartPanel` uses to list scheduled games.

### Files
- `apps/web/components/league/league-chart-panel.tsx` — `ScoreboardCard` subcomponent (or extract to its own file if it grows).
- `/Users/santhoshnarayan/Developer/explore/misc/sports/espn/mens-college-basketball/playground_web/src/app/chart/page.tsx` — reference for the exact visual treatment.

---

## Task 4: Include future games in scoreboard (scrollable)

### Problem
Only past + in-progress games appear. Future scheduled games are missing, so the scoreboard row doesn't represent the full round's game slate. The NCAAM reference shows every slot, with upcoming ones styled as muted/dashed, and auto-scrolls to the current live game on mount.

### Acceptance criteria
- Every scheduled game slot in the active round/filter is rendered, in chronological order.
- Future games render with muted text + dashed border (clearly "not yet played").
- Row is horizontally scrollable when it overflows.
- On mount (and on round-filter change), the row auto-scrolls so the first live-or-upcoming game is visible.
- Past games on the left, live in middle, future on the right (natural chronology).

### Implementation notes
- Game slate lives in the bracket `schedule` section — pull from there rather than inferring from checkpoints (checkpoints only cover played games).
- For future games, skip the `eventText` footer (no events yet) or show placeholder text like "Tips {date}".
- Auto-scroll: after render, `ref.current.scrollTo({ left: firstLiveOrUpcomingOffset, behavior: "smooth" })`. Find the offset by measuring the matching card's `offsetLeft`.
- Make sure Task 2 hover sync still works for future cards (they just won't map to any chart index — hovering them is a no-op on the chart side).

### Files
- `apps/web/components/league/league-chart-panel.tsx` — scoreboard row rendering + scroll logic.
- Bracket schedule source (follow the existing import in `league-chart-panel.tsx` or trace from `useAutoSim`).

---

## Task 5: Ticker hover panel shows ALL drafted players

### Problem
In the live ticker's hover panel, the drafted-players list for each team caps at 3 via `.slice(0, 3)`. User wants every drafted player visible even if more than 3 per team. Non-rostered scorers should still be excluded.

### Acceptance criteria
- Remove the 3-player cap for drafted players in `LeadersTeamSection`.
- Drafted-only filter remains (non-rostered players are still hidden).
- Panel stays readable at tall heights — allow it to grow, or scroll internally if it exceeds a reasonable max.

### Implementation notes
- Find the `.slice(0, 3)` call inside `LeadersTeamSection` and remove it.
- If the panel risks overflowing viewport, wrap the list in a `max-h-[60vh] overflow-y-auto` container.
- Double-check there isn't a similar cap in a sibling "non-drafted top scorers" section — the requirement is only to uncap drafted.

### Files
- `apps/web/components/nba/live-games-ticker.tsx` — `LeadersTeamSection`.

---

## Task 6: Chart tooltip surfaces queued live updates

### Problem
`useAutoSim` exposes `pendingEvents` (count of events queued behind the debounce). There's currently a badge outside the chart showing this, but it's easy to miss. When a user is hovering the chart and the sim is about to refresh, they should see that context inline in the tooltip.

### Acceptance criteria
- When `pendingEvents > 0`, the chart tooltip shows a small footer line: `N live updates queued — sim will refresh after debounce` (phrasing flexible).
- Footer disappears when `pendingEvents === 0`.
- Existing badge stays; tooltip footer is additive.
- Tooltip content remains tight — footer is a single muted line at the bottom, not a separate section.

### Implementation notes
- Pass `pendingEvents` from the parent (which already consumes `useAutoSim`) into `LeagueChartPanel`.
- Inside the `<Tooltip content={...}>` custom renderer, append a conditional `<div className="text-muted-foreground text-xs">` when `pendingEvents > 0`.
- Pluralize correctly (`1 live update queued` vs `N live updates queued`).

### Files
- `apps/web/components/league/league-chart-panel.tsx` — tooltip content renderer.
- `apps/web/lib/use-auto-sim.ts` — already exposes `pendingEvents`, no change expected.
- Wherever `LeagueChartPanel` is mounted — thread the `pendingEvents` prop through.

---

## Appendix: Shared references

- **Branch**: `live-nba-scoring`
- **Repo**: `/Users/santhoshnarayan/Developer/StripeV2` (pnpm monorepo: `apps/web`, `apps/server`, `packages/db`)
- **NCAAM visual reference**: `/Users/santhoshnarayan/Developer/explore/misc/sports/espn/mens-college-basketball/playground_web/`
- **Chart**: `apps/web/components/league/league-chart-panel.tsx`
- **Sim hook**: `apps/web/lib/use-auto-sim.ts`
- **Leaderboard**: `apps/web/components/league/simulator-leaderboard.tsx`
- **Timeseries API**: `GET /leagues/:leagueId/timeseries` in `apps/server/src/routes/app.ts`
- **Ticker**: `apps/web/components/nba/live-games-ticker.tsx`

**Series key conventions (best-of-7):**
- `r1.{east|west}.{1v8|2v7|3v6|4v5}`
- `r2.{east|west}.{top|bot}`
- `cf.{east|west}`
- `finals`

**Sim projection shape:**
```ts
type ManagerProjection = {
  // ...
  projectedPointsByRound: Record<"r1" | "r2" | "cf" | "finals", number>;
};
```

**R1 floor date:** `2026-04-19` — anything before this is play-in and is filtered out of the timeseries response.
