"use client";

import type { SimResults, SimData } from "@/lib/sim";

const BOX_W = 160;
const CELL_H = 24;
const CONN_W = 16;
const SLOT_H = 72;

const ESPN_ABBR: Record<string, string> = {
  NY: "nyk",
  SA: "sa",
  GS: "gs",
  PHX: "phx",
};

function teamLogoUrl(team: string): string {
  const abbr = (ESPN_ABBR[team] ?? team).toLowerCase();
  return `https://cdn.espn.com/combiner/i?img=/i/teamlogos/nba/500/${abbr}.png&h=40&w=40`;
}

function CompetitorRow({
  seed,
  team,
  fullNames,
  advPct,
}: {
  seed: number;
  team: string;
  fullNames: Record<string, string>;
  advPct?: number | null;
}) {
  const isTBD = team === "TBD" || team === "Play-In" || seed === 0;
  return (
    <div className="flex items-center gap-1.5 px-2" style={{ height: CELL_H }}>
      {seed > 0 && (
        <span className="w-4 shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {seed}
        </span>
      )}
      {!isTBD && (
        <img
          src={teamLogoUrl(team)}
          alt={team}
          width={16}
          height={16}
          className="shrink-0"
        />
      )}
      <span className="truncate text-xs font-medium text-foreground">{team}</span>
      {!isTBD && (
        <span className="ml-auto truncate text-[10px] text-muted-foreground">
          {advPct != null
            ? `${advPct.toFixed(0)}%`
            : fullNames[team] ?? ""}
        </span>
      )}
    </div>
  );
}

function MatchupBox({
  higher,
  lower,
  fullNames,
  simResults,
}: {
  higher: { seed: number; team: string };
  lower: { seed: number; team: string };
  fullNames: Record<string, string>;
  simResults?: SimResults | null;
}) {
  const hAdv = simResults?.teams.find((t) => t.team === higher.team);
  const lAdv = simResults?.teams.find((t) => t.team === lower.team);
  return (
    <div
      className="overflow-hidden rounded-md border border-border bg-card"
      style={{ width: BOX_W }}
    >
      <CompetitorRow
        seed={higher.seed}
        team={higher.team}
        fullNames={fullNames}
        advPct={hAdv?.r1}
      />
      <div className="border-t border-border" />
      <CompetitorRow
        seed={lower.seed}
        team={lower.team}
        fullNames={fullNames}
        advPct={lAdv?.r1}
      />
    </div>
  );
}

function Connectors({
  count,
  slotH,
  flip,
}: {
  count: number;
  slotH: number;
  flip?: boolean;
}) {
  const h = count * slotH;
  const pairs = count / 2;
  const paths: string[] = [];

  for (let i = 0; i < pairs; i++) {
    const topY = (i * 2 + 0.5) * slotH;
    const botY = (i * 2 + 1.5) * slotH;
    const midY = (topY + botY) / 2;
    const hw = CONN_W / 2;

    if (flip) {
      paths.push(`M ${CONN_W} ${topY} H ${hw} V ${midY} H 0`);
      paths.push(`M ${CONN_W} ${botY} H ${hw} V ${midY}`);
    } else {
      paths.push(`M 0 ${topY} H ${hw} V ${midY} H ${CONN_W}`);
      paths.push(`M 0 ${botY} H ${hw} V ${midY}`);
    }
  }

  return (
    <svg width={CONN_W} height={h} className="shrink-0">
      {paths.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke="currentColor"
          className="text-border"
          strokeWidth={1.5}
        />
      ))}
    </svg>
  );
}

/* ── Play-In bracket (double-elimination) ── */

function PlayInBracket({
  conf,
  seeds,
  playin,
  fullNames,
  r1Results,
}: {
  conf: string;
  seeds: [number, string][];
  playin: [number, string][];
  fullNames: Record<string, string>;
  r1Results?: {
    game7v8: { winner: string; loser: string };
    game9v10: { winner: string; loser: string };
  };
}) {
  const s7 = seeds.find(([s]) => s === 7)?.[1] ?? "?";
  const s8 = seeds.find(([s]) => s === 8)?.[1] ?? "?";
  const s9 = playin.find(([s]) => s === 9)?.[1] ?? "?";
  const s10 = playin.find(([s]) => s === 10)?.[1] ?? "?";

  // If R1 results exist, show the R2 matchup with actual teams
  const r2Higher = r1Results ? r1Results.game7v8.loser : `L(${s7}/${s8})`;
  const r2Lower = r1Results ? r1Results.game9v10.winner : `W(${s9}/${s10})`;

  const BOX_H = CELL_H * 2;
  const CAPTION_H = 16;
  const GAP = 16;
  const ITEM_H = BOX_H + CAPTION_H;
  const TOTAL_H = ITEM_H * 2 + GAP;

  const box1CenterY = BOX_H / 2;
  const box2CenterY = ITEM_H + GAP + BOX_H / 2;
  const midY = (box1CenterY + box2CenterY) / 2;

  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {conf} Play-In
      </div>
      <div className="flex items-start">
        <div
          className="flex shrink-0 flex-col"
          style={{ height: TOTAL_H, gap: GAP }}
        >
          <div>
            <MatchupBox
              higher={{ seed: 7, team: s7 }}
              lower={{ seed: 8, team: s8 }}
              fullNames={fullNames}
            />
            <div
              className="text-center text-[9px] text-muted-foreground"
              style={{ height: CAPTION_H, lineHeight: `${CAPTION_H}px` }}
            >
              {r1Results
                ? `✓ ${r1Results.game7v8.winner} → 7 seed`
                : "W → 7 seed"}
            </div>
          </div>
          <div>
            <MatchupBox
              higher={{ seed: 9, team: s9 }}
              lower={{ seed: 10, team: s10 }}
              fullNames={fullNames}
            />
            <div
              className="text-center text-[9px] text-muted-foreground"
              style={{ height: CAPTION_H, lineHeight: `${CAPTION_H}px` }}
            >
              {r1Results
                ? `✓ ${r1Results.game9v10.loser} eliminated`
                : "L eliminated"}
            </div>
          </div>
        </div>

        <svg width={CONN_W * 2} height={TOTAL_H} className="shrink-0">
          <path
            d={`M 0 ${box1CenterY} H ${CONN_W} V ${midY} H ${CONN_W * 2}`}
            fill="none"
            stroke="currentColor"
            className="text-border"
            strokeWidth={1.5}
          />
          <path
            d={`M 0 ${box2CenterY} H ${CONN_W} V ${midY}`}
            fill="none"
            stroke="currentColor"
            className="text-border"
            strokeWidth={1.5}
          />
        </svg>

        <div style={{ paddingTop: midY - BOX_H / 2 }}>
          <MatchupBox
            higher={{ seed: 0, team: r2Higher }}
            lower={{ seed: 0, team: r2Lower }}
            fullNames={fullNames}
          />
          <div
            className="text-center text-[9px] text-muted-foreground"
            style={{ height: CAPTION_H, lineHeight: `${CAPTION_H}px` }}
          >
            W → 8 seed
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Conference bracket ── */

function ConferenceBracket({
  conf,
  seeds,
  simResults,
  fullNames,
  flip,
}: {
  conf: string;
  seeds: [number, string][];
  simResults: SimResults | null;
  fullNames: Record<string, string>;
  flip?: boolean;
}) {
  // 7-seed is confirmed from play-in R1; 8-seed is TBD until play-in R2
  const seed7: [number, string] = [7, seeds.find(([s]) => s === 7)?.[1] ?? "Play-In"];
  const seed8: [number, string] = [8, "Play-In"];

  const r1 = [
    { higher: seeds[0], lower: seed8 },
    { higher: seeds[3], lower: seeds[4] },
    { higher: seeds[2], lower: seeds[5] },
    { higher: seeds[1], lower: seed7 },
  ];

  const r2 = [
    { higher: [0, "TBD"] as [number, string], lower: [0, "TBD"] as [number, string] },
    { higher: [0, "TBD"] as [number, string], lower: [0, "TBD"] as [number, string] },
  ];

  const cf = [
    { higher: [0, "TBD"] as [number, string], lower: [0, "TBD"] as [number, string] },
  ];

  const totalH = r1.length * SLOT_H;

  const rounds = [
    { matchups: r1, slotH: SLOT_H },
    { matchups: r2, slotH: SLOT_H * 2 },
    { matchups: cf, slotH: SLOT_H * 4 },
  ];

  const content = rounds.map((round, ri) => {
    const matchupCol = (
      <div
        key="m"
        className="flex flex-col justify-around"
        style={{ height: totalH }}
      >
        {round.matchups.map((m, mi) => (
          <div
            key={mi}
            className="flex items-center"
            style={{ height: round.slotH }}
          >
            <MatchupBox
              higher={{ seed: m.higher[0], team: m.higher[1] }}
              lower={{ seed: m.lower[0], team: m.lower[1] }}
              fullNames={fullNames}
              simResults={simResults}
            />
          </div>
        ))}
      </div>
    );

    const connectorCol =
      ri > 0 ? (
        <Connectors
          key="c"
          count={round.matchups.length * 2}
          slotH={round.slotH / 2}
          flip={flip}
        />
      ) : null;

    return (
      <div key={ri} className="flex items-stretch">
        {flip ? (
          <>
            {matchupCol}
            {connectorCol}
          </>
        ) : (
          <>
            {connectorCol}
            {matchupCol}
          </>
        )}
      </div>
    );
  });

  return (
    <div>
      <div className="mb-2 text-sm font-semibold text-foreground">{conf}ern Conference</div>
      <div className={`flex ${flip ? "flex-row-reverse" : ""}`}>{content}</div>
    </div>
  );
}

export function BracketView({
  simData,
  simResults,
}: {
  simData: SimData;
  simResults: SimResults | null;
}) {
  const fullNames = simData.bracket.teamFullNames;
  const champion = simResults?.teams[0];

  return (
    <div className="space-y-8">
      <div>
        <p className="mb-3 text-base font-semibold text-foreground">
          Playoff Bracket
          {!simResults && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              Run a simulation to see advancement probabilities
            </span>
          )}
        </p>
        <div className="overflow-x-auto pb-4">
          <div className="flex min-w-[900px] items-start justify-center gap-8">
            <ConferenceBracket
              conf="West"
              seeds={simData.bracket.westSeeds}
              simResults={simResults}
              fullNames={fullNames}
            />
            <div
              className="flex flex-col items-center justify-center"
              style={{ height: SLOT_H * 4, paddingTop: SLOT_H * 1.5 }}
            >
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Finals
              </div>
              <MatchupBox
                higher={{ seed: 0, team: "TBD" }}
                lower={{ seed: 0, team: "TBD" }}
                fullNames={fullNames}
                simResults={simResults}
              />
              <div className="mt-3 text-center">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Champion
                </div>
                <div
                  className="rounded-md border-2 border-amber-400 bg-amber-50 px-4 py-2 text-sm font-bold text-foreground dark:bg-amber-900/20"
                  style={{ width: BOX_W }}
                >
                  {champion
                    ? `${champion.team} (${champion.champ.toFixed(1)}%)`
                    : "TBD"}
                </div>
              </div>
            </div>
            <ConferenceBracket
              conf="East"
              seeds={simData.bracket.eastSeeds}
              simResults={simResults}
              fullNames={fullNames}
              flip
            />
          </div>
        </div>
      </div>

      {/* Play-In Tournament */}
      {(simData.bracket.eastPlayin?.length || simData.bracket.westPlayin?.length) ? (
        <div>
          <p className="mb-3 text-base font-semibold text-foreground">
            Play-In Tournament
          </p>
          <div className="flex flex-col gap-12 md:flex-row">
            {simData.bracket.westPlayin?.length ? (
              <PlayInBracket
                conf="West"
                seeds={simData.bracket.westSeeds}
                playin={simData.bracket.westPlayin}
                fullNames={fullNames}
                r1Results={simData.bracket.playinR1?.west}
              />
            ) : null}
            {simData.bracket.eastPlayin?.length ? (
              <PlayInBracket
                conf="East"
                seeds={simData.bracket.eastSeeds}
                playin={simData.bracket.eastPlayin}
                fullNames={fullNames}
                r1Results={simData.bracket.playinR1?.east}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
