"use client";

import React, { useState, useMemo, useCallback, useRef } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import type { SimPlayer as Player, PlayerAdjustment } from "@/lib/sim";

// Bracket constants injected by the parent via setBracketConstants()
let EAST_SEEDS: [number, string][] = [];
let WEST_SEEDS: [number, string][] = [];
let EAST_PLAYIN: [number, string][] = [];
let WEST_PLAYIN: [number, string][] = [];
let TEAM_FULL_NAMES: Record<string, string> = {};

export function setBracketConstants(data: {
  eastSeeds: [number, string][];
  westSeeds: [number, string][];
  eastPlayin?: [number, string][];
  westPlayin?: [number, string][];
  teamFullNames: Record<string, string>;
}) {
  EAST_SEEDS = data.eastSeeds;
  WEST_SEEDS = data.westSeeds;
  EAST_PLAYIN = data.eastPlayin ?? [];
  WEST_PLAYIN = data.westPlayin ?? [];
  TEAM_FULL_NAMES = data.teamFullNames;
}

const ROUND_LABELS = ["Play-In", "R1", "R2", "CF", "Finals"];
const ROUND_GAMES = [2, 7, 7, 7, 7]; // play-in has 2 games, playoff rounds have 7

interface Props {
  teamPlayers: Record<string, Player[]>;
  adjustments: Record<string, PlayerAdjustment>;
  defaultAdjustments: Record<string, PlayerAdjustment>;
  playoffMinutes: Record<string, Record<string, number>>;
  playoffMpgByEspnId: Record<string, number>;
  onUpdateAdjustment: (
    espnId: string,
    update: Partial<PlayerAdjustment>,
  ) => void;
  onLoadAdjustments: (adjs: Record<string, PlayerAdjustment>) => void;
  onResetAdjustments: () => void;
}

const TEAM_ORDER = [
  ...WEST_SEEDS.map(([s, t]) => ({ seed: s, team: t, conf: "West" })),
  ...WEST_PLAYIN.map(([s, t]) => ({ seed: s, team: t, conf: "West Play-In" })),
  ...EAST_SEEDS.map(([s, t]) => ({ seed: s, team: t, conf: "East" })),
  ...EAST_PLAYIN.map(([s, t]) => ({ seed: s, team: t, conf: "East Play-In" })),
];

/* ── Stepper for the modal ── */
function Stepper({
  value,
  onChange,
  step = 0.5,
  min = -10,
  max = 10,
  placeholder = "0",
  defaultValue = 0,
  isActive = false,
}: {
  value: number | null;
  onChange: (val: number | null) => void;
  step?: number;
  min?: number;
  max?: number;
  placeholder?: string;
  defaultValue?: number;
  isActive?: boolean;
}) {
  const display =
    value === null || value === 0 ? "" : value > 0 ? `+${value}` : `${value}`;
  return (
    <div
      className={`inline-flex items-center rounded-md border ${isActive ? "border-amber-400 bg-amber-50/50 dark:bg-amber-900/20" : "border-border"}`}
    >
      <button
        className="px-2 py-1 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-l-md transition-colors"
        onClick={() => {
          const cur = value ?? defaultValue;
          const next = Math.max(min, cur - step);
          onChange(Math.round(next * 10) / 10);
        }}
      >
        -
      </button>
      <span
        className={`w-12 text-center text-sm tabular-nums ${isActive ? "font-medium" : "text-muted-foreground"}`}
      >
        {display || placeholder}
      </span>
      <button
        className="px-2 py-1 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-r-md transition-colors"
        onClick={() => {
          const cur = value ?? defaultValue;
          const next = Math.min(max, cur + step);
          onChange(Math.round(next * 10) / 10);
        }}
      >
        +
      </button>
    </div>
  );
}

/* ── LEBRON stepper for modal ── */
function LebronStepper({
  label,
  base,
  delta,
  onChange,
}: {
  label: string;
  base: number;
  delta: number;
  onChange: (delta: number) => void;
}) {
  const effective = base + delta;
  const isActive = delta !== 0;
  const display =
    effective > 0 ? `+${effective.toFixed(1)}` : effective.toFixed(1);
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
        {label}
      </div>
      <div
        className={`inline-flex items-center rounded-md border ${isActive ? "border-amber-400 bg-amber-50/50 dark:bg-amber-900/20" : "border-border"}`}
      >
        <button
          className="px-2 py-1 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-l-md transition-colors"
          onClick={() => onChange(Math.round((delta - 0.5) * 10) / 10)}
        >
          -
        </button>
        <span
          className={`w-14 text-center text-sm tabular-nums ${isActive ? "font-medium" : "text-muted-foreground"}`}
          title={`Base: ${base > 0 ? "+" : ""}${base.toFixed(2)}${delta !== 0 ? `, Adj: ${delta > 0 ? "+" : ""}${delta}` : ""}`}
        >
          {display}
        </span>
        <button
          className="px-2 py-1 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-r-md transition-colors"
          onClick={() => onChange(Math.round((delta + 0.5) * 10) / 10)}
        >
          +
        </button>
      </div>
      {isActive && (
        <div className="text-[10px] text-muted-foreground">
          Base: {base > 0 ? "+" : ""}
          {base.toFixed(2)}, Adj: {delta > 0 ? "+" : ""}
          {delta}
        </div>
      )}
    </div>
  );
}

/* ── Colored value display for availability ── */
function availPctClass(pct: number): string {
  if (pct === 100) return "text-muted-foreground/40";
  if (pct >= 80) return "text-emerald-600 dark:text-emerald-400";
  if (pct >= 50) return "text-yellow-600 dark:text-yellow-500";
  if (pct > 0) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400 font-medium";
}

function fmtLeb(v: number): string {
  return v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1);
}

/* ── Player edit modal ── */
function PlayerModal({
  player,
  adj,
  projMpg,
  onUpdate,
  onClose,
}: {
  player: Player;
  adj: PlayerAdjustment;
  projMpg: number;
  onUpdate: (update: Partial<PlayerAdjustment>) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-background border rounded-lg shadow-lg max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div>
            <div className="font-semibold text-base">
              {player.name}
              {player.autofill && (
                <Badge
                  variant="secondary"
                  className="ml-2 text-[9px] px-1.5 py-0 rounded-sm"
                >
                  est
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {player.team} &middot; {player.pos} &middot;{" "}
              {player.ppg.toFixed(1)} PPG &middot; {player.mpg.toFixed(1)} MPG
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-lg px-2"
          >
            &times;
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* LEBRON + Minutes row */}
          <div className="flex gap-6 flex-wrap">
            <LebronStepper
              label="O-LEBRON"
              base={player.o_lebron}
              delta={adj.o_lebron_delta}
              onChange={(d) => onUpdate({ o_lebron_delta: d })}
            />
            <LebronStepper
              label="D-LEBRON"
              base={player.d_lebron}
              delta={adj.d_lebron_delta}
              onChange={(d) => onUpdate({ d_lebron_delta: d })}
            />
            <div className="space-y-1">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Minutes
              </div>
              <Stepper
                value={adj.minutes_override}
                onChange={(v) => onUpdate({ minutes_override: v })}
                step={1}
                min={0}
                max={48}
                defaultValue={Math.round(projMpg)}
                placeholder={projMpg.toFixed(0)}
                isActive={adj.minutes_override != null}
              />
              <div className="text-[10px] text-muted-foreground">
                Projected: {projMpg.toFixed(1)}
              </div>
            </div>
          </div>

          {/* Per-game availability — table layout with round rows */}
          <div>
            <div className="flex items-center gap-3 mb-2">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Per-Game Availability
              </div>
              <div className="flex gap-1">
                <span className="text-[10px] text-muted-foreground self-center">
                  Set all:
                </span>
                {[0, 0.25, 0.5, 0.75, 1.0].map((val) => (
                  <button
                    key={val}
                    className="px-1.5 py-0.5 text-[10px] rounded border hover:bg-accent transition-colors"
                    onClick={() =>
                      onUpdate({ availability: new Array(30).fill(val) })
                    }
                  >
                    {Math.round(val * 100)}%
                  </button>
                ))}
              </div>
            </div>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="text-left text-[10px] text-muted-foreground font-semibold w-16 pb-1">
                    Round
                  </th>
                  {Array.from({ length: 7 }, (_, gi) => (
                    <th
                      key={gi}
                      className="text-center text-[10px] text-muted-foreground font-normal pb-1 w-12"
                    >
                      G{gi + 1}
                    </th>
                  ))}
                  <th className="text-center text-[10px] text-muted-foreground font-normal pb-1 w-16" />
                </tr>
              </thead>
              <tbody>
                {ROUND_LABELS.map((label, ri) => {
                  const roundStart = ROUND_GAMES.slice(0, ri).reduce(
                    (s, n) => s + n,
                    0,
                  );
                  const numGames = ROUND_GAMES[ri];
                  return (
                    <tr key={ri}>
                      <td className="text-xs font-medium py-1 pr-2">{label}</td>
                      {Array.from({ length: 7 }, (_, gi) => {
                        if (gi >= numGames) {
                          return <td key={gi} />;
                        }
                        const idx = roundStart + gi;
                        const val = adj.availability[idx] ?? 1;
                        return (
                          <td key={gi} className="text-center py-1 px-0.5">
                            <input
                              type="text"
                              inputMode="decimal"
                              value={val}
                              onChange={(e) => {
                                const parsed = parseFloat(e.target.value);
                                if (e.target.value === "" || isNaN(parsed))
                                  return;
                                const newAvail = [...adj.availability];
                                newAvail[idx] = Math.min(
                                  1,
                                  Math.max(0, parsed),
                                );
                                onUpdate({ availability: newAvail });
                              }}
                              className={`h-7 w-full text-center text-xs tabular-nums px-0 rounded-md border ${
                                val < 1.0
                                  ? "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-300"
                                  : "border-input bg-background"
                              }`}
                            />
                          </td>
                        );
                      })}
                      <td className="text-center py-1 pl-1">
                        <div className="flex gap-0.5 justify-center">
                          <button
                            className="text-[10px] px-1.5 py-0.5 rounded border hover:bg-accent"
                            onClick={() => {
                              const newAvail = [...adj.availability];
                              for (
                                let g = roundStart;
                                g < roundStart + numGames;
                                g++
                              )
                                newAvail[g] = 1.0;
                              onUpdate({ availability: newAvail });
                            }}
                          >
                            100%
                          </button>
                          <button
                            className="text-[10px] px-1.5 py-0.5 rounded border hover:bg-accent"
                            onClick={() => {
                              const newAvail = [...adj.availability];
                              for (
                                let g = roundStart;
                                g < roundStart + numGames;
                                g++
                              )
                                newAvail[g] = 0;
                              onUpdate({ availability: newAvail });
                            }}
                          >
                            0%
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AdjustmentsTab({
  teamPlayers,
  adjustments,
  defaultAdjustments,
  playoffMinutes,
  playoffMpgByEspnId,
  onUpdateAdjustment,
  onLoadAdjustments,
  onResetAdjustments,
}: Props) {
  // Compare current adjustment against default (injury-loaded) to detect user changes
  const hasUserChange = useCallback(
    (espnId: string, adj: PlayerAdjustment) => {
      if (
        adj.o_lebron_delta !== 0 ||
        adj.d_lebron_delta !== 0 ||
        adj.minutes_override !== null
      )
        return true;
      const def = defaultAdjustments[espnId];
      if (!def) return adj.availability.some((v) => v !== 1.0);
      return adj.availability.some((v, i) => v !== def.availability[i]);
    },
    [defaultAdjustments],
  );

  const [collapsedTeams, setCollapsedTeams] = useState<Set<string>>(new Set());
  const [showActiveAdj, setShowActiveAdj] = useState(false);
  const [showZeroMin, setShowZeroMin] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [modalPlayer, setModalPlayer] = useState<{
    player: Player;
    team: string;
  } | null>(null);
  const teamRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const toggleTeam = (team: string) => {
    setCollapsedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(team)) next.delete(team);
      else next.add(team);
      return next;
    });
  };

  const getEffectiveMinutes = useCallback(
    (p: Player, adj: PlayerAdjustment | undefined) => {
      if (adj?.minutes_override != null) return adj.minutes_override;
      return playoffMpgByEspnId[p.espn_id] ?? 0;
    },
    [playoffMpgByEspnId],
  );

  const teamMinTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const [team, players] of Object.entries(teamPlayers)) {
      let total = 0;
      for (const p of players) {
        total += getEffectiveMinutes(p, adjustments[p.espn_id]);
      }
      totals[team] = total;
    }
    return totals;
  }, [teamPlayers, adjustments, getEffectiveMinutes]);

  const teamRatings = useMemo(() => {
    const ratings: {
      team: string;
      oLeb: number;
      dLeb: number;
      leb: number;
    }[] = [];
    for (const { team } of TEAM_ORDER) {
      const players = teamPlayers[team];
      if (!players) continue;
      const pm = playoffMinutes[team] ?? {};

      // Compute effective minutes with override scaling (match simulator logic)
      let overriddenTotal = 0;
      let baseTotal = 0;
      const playerMins: { p: Player; mins: number; isOverride: boolean }[] = [];

      for (const p of players) {
        const adj = adjustments[p.espn_id];
        const key = p.nba_id || p.espn_id;
        const base = pm[key] ?? 0;
        if (adj?.minutes_override != null) {
          playerMins.push({ p, mins: adj.minutes_override, isOverride: true });
          overriddenTotal += adj.minutes_override;
        } else if (base > 0) {
          playerMins.push({ p, mins: base, isOverride: false });
          baseTotal += base;
        }
      }

      const remaining = Math.max(0, 240 - overriddenTotal);
      const scale = baseTotal > 0 ? remaining / baseTotal : 0;

      let oLeb = 0;
      let dLeb = 0;
      for (const { p, mins, isOverride } of playerMins) {
        const adj = adjustments[p.espn_id];
        const effMins = isOverride ? mins : mins * scale;
        const o = p.o_lebron + (adj?.o_lebron_delta ?? 0);
        const d = p.d_lebron + (adj?.d_lebron_delta ?? 0);
        oLeb += (o * effMins) / 48;
        dLeb += (d * effMins) / 48;
      }
      ratings.push({ team, oLeb, dLeb, leb: oLeb + dLeb });
    }
    ratings.sort((a, b) => b.leb - a.leb);
    return ratings;
  }, [teamPlayers, adjustments, playoffMinutes]);

  const adjustedPlayers = useMemo(() => {
    const result: {
      name: string;
      team: string;
      oAdj: number;
      dAdj: number;
      minOverride: number | null;
      projMpg: number;
      hasAvailChange: boolean;
    }[] = [];
    for (const [team, players] of Object.entries(teamPlayers)) {
      for (const p of players) {
        const a = adjustments[p.espn_id];
        if (!a) continue;
        if (!hasUserChange(p.espn_id, a)) continue;
        const def = defaultAdjustments[p.espn_id];
        result.push({
          name: p.name,
          team,
          oAdj: a.o_lebron_delta,
          dAdj: a.d_lebron_delta,
          minOverride: a.minutes_override,
          projMpg: playoffMpgByEspnId[p.espn_id] ?? 0,
          hasAvailChange: def
            ? a.availability.some((v, i) => v !== def.availability[i])
            : a.availability.some((v) => v !== 1.0),
        });
      }
    }
    return result;
  }, [teamPlayers, adjustments, playoffMpgByEspnId]);

  const handleScaleAll = useCallback(
    (team: string) => {
      const players = teamPlayers[team];
      if (!players) return;
      const currentTotal = players.reduce(
        (sum, p) => sum + getEffectiveMinutes(p, adjustments[p.espn_id]),
        0,
      );
      if (currentTotal <= 0) return;
      const factor = 240 / currentTotal;
      for (const p of players) {
        const curr = getEffectiveMinutes(p, adjustments[p.espn_id]);
        onUpdateAdjustment(p.espn_id, {
          minutes_override: Math.round(curr * factor * 10) / 10,
        });
      }
      toast.success(`${team}: scaled all minutes to 240`);
    },
    [teamPlayers, adjustments, getEffectiveMinutes, onUpdateAdjustment],
  );

  const handleScaleRemainder = useCallback(
    (team: string) => {
      const players = teamPlayers[team];
      if (!players) return;
      let overrideTotal = 0;
      const nonOverride: Player[] = [];
      for (const p of players) {
        const adj = adjustments[p.espn_id];
        if (adj?.minutes_override != null) {
          overrideTotal += adj.minutes_override;
        } else {
          nonOverride.push(p);
        }
      }
      const remaining = 240 - overrideTotal;
      if (remaining <= 0 || nonOverride.length === 0) {
        toast.error("No remaining minutes to distribute");
        return;
      }
      const nonOverrideTotal = nonOverride.reduce(
        (sum, p) => sum + (playoffMpgByEspnId[p.espn_id] ?? p.mpg),
        0,
      );
      if (nonOverrideTotal <= 0) return;
      const factor = remaining / nonOverrideTotal;
      for (const p of nonOverride) {
        const base = playoffMpgByEspnId[p.espn_id] ?? p.mpg;
        onUpdateAdjustment(p.espn_id, {
          minutes_override: Math.round(base * factor * 10) / 10,
        });
      }
      toast.success(`${team}: scaled remainder to fill 240`);
    },
    [teamPlayers, adjustments, playoffMpgByEspnId, onUpdateAdjustment],
  );

  const handleSave = useCallback(() => {
    if (!saveName.trim()) {
      toast.error("Enter a name for this adjustment set");
      return;
    }
    const lines = [
      "espn_id,name,team,o_lebron_delta,d_lebron_delta,minutes_override," +
        Array.from({ length: 30 }, (_, i) => `g${i + 1}_avail`).join(","),
    ];
    for (const [team, players] of Object.entries(teamPlayers)) {
      for (const p of players) {
        const adj = adjustments[p.espn_id];
        if (!adj) continue;
        if (!hasUserChange(p.espn_id, adj)) continue;
        lines.push(
          `${p.espn_id},${p.name},${team},${adj.o_lebron_delta},${adj.d_lebron_delta},${adj.minutes_override ?? ""},${adj.availability.join(",")}`,
        );
      }
    }
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${saveName.trim().replace(/\s+/g, "_")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Saved as ${a.download}`);
  }, [saveName, adjustments, teamPlayers]);

  const handleSaveDefaultJson = useCallback(() => {
    const entries: {
      espn_id: string;
      name: string;
      team: string;
      o_lebron_delta: number;
      d_lebron_delta: number;
      minutes_override: number | null;
    }[] = [];
    for (const [team, players] of Object.entries(teamPlayers)) {
      for (const p of players) {
        const adj = adjustments[p.espn_id];
        if (!adj) continue;
        if (!hasUserChange(p.espn_id, adj)) continue;
        entries.push({
          espn_id: p.espn_id,
          name: p.name,
          team,
          o_lebron_delta: adj.o_lebron_delta,
          d_lebron_delta: adj.d_lebron_delta,
          minutes_override: adj.minutes_override,
        });
      }
    }
    const json = JSON.stringify(entries, null, 2) + "\n";
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "default-adjustments.json";
    a.click();
    URL.revokeObjectURL(url);
    toast.success(
      "Saved default-adjustments.json — replace src/data/default-adjustments.json to persist",
    );
  }, [adjustments, teamPlayers]);

  const handleLoadCsv = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        const lines = text.trim().split("\n");
        const newAdj = { ...adjustments };
        const header = lines[0].split(",");
        const hasPerGame = header.length > 10;
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split(",");
          const espnId = parts[0];
          if (!newAdj[espnId]) continue;
          if (hasPerGame) {
            const avail = parts.slice(6, 36).map((v) => parseFloat(v) || 1.0);
            while (avail.length < 30) avail.push(1.0);
            newAdj[espnId] = {
              ...newAdj[espnId],
              o_lebron_delta: parseFloat(parts[3]) || 0,
              d_lebron_delta: parseFloat(parts[4]) || 0,
              minutes_override: parts[5] ? parseFloat(parts[5]) : null,
              availability: avail,
            };
          } else {
            newAdj[espnId] = {
              ...newAdj[espnId],
              o_lebron_delta: parseFloat(parts[3]) || 0,
              d_lebron_delta: parseFloat(parts[4]) || 0,
              minutes_override: parts[5] ? parseFloat(parts[5]) : null,
              availability: buildAvailFromRounds(
                parseFloat(parts[6]) ?? 1,
                parseFloat(parts[7]) ?? 1,
                parseFloat(parts[8]) ?? 1,
                parseFloat(parts[9]) ?? 1,
              ),
            };
          }
        }
        onLoadAdjustments(newAdj);
        toast.success("Loaded adjustments from CSV");
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    [adjustments, onLoadAdjustments],
  );

  const hasAnyChanges = adjustedPlayers.length > 0;

  const scrollToTeam = (team: string) => {
    const el = teamRefs.current[team];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      setCollapsedTeams((prev) => {
        const next = new Set(prev);
        next.delete(team);
        return next;
      });
    }
  };

  return (
    <div className="space-y-4 mt-4">
      {/* Modal */}
      {modalPlayer && adjustments[modalPlayer.player.espn_id] && (
        <PlayerModal
          player={modalPlayer.player}
          adj={adjustments[modalPlayer.player.espn_id]}
          projMpg={playoffMpgByEspnId[modalPlayer.player.espn_id] ?? 0}
          onUpdate={(update) =>
            onUpdateAdjustment(modalPlayer.player.espn_id, update)
          }
          onClose={() => setModalPlayer(null)}
        />
      )}

      {/* Controls bar */}
      <div className="flex gap-2 items-center flex-wrap">
        <Input
          placeholder="Adjustment set name..."
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          className="max-w-[200px]"
        />
        <Button
          onClick={handleSave}
          variant="outline"
          size="sm"
          className="w-24"
        >
          Save CSV
        </Button>
        <label className="cursor-pointer inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground h-8 w-24">
          Load CSV
          <input
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleLoadCsv}
          />
        </label>
        <Button
          onClick={handleSaveDefaultJson}
          variant="outline"
          size="sm"
          disabled={!hasAnyChanges}
        >
          Save Default
        </Button>
        <Button
          onClick={onResetAdjustments}
          variant="ghost"
          size="sm"
          disabled={!hasAnyChanges}
        >
          Reset All
        </Button>
      </div>

      {/* Summary of adjustments */}
      {hasAnyChanges && (
        <Card>
          <CardHeader
            className="pb-2 cursor-pointer hover:bg-muted/30"
            onClick={() => setShowActiveAdj(!showActiveAdj)}
          >
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm">
                Active Adjustments
                <Badge
                  variant="secondary"
                  className="ml-2 text-[10px] rounded-sm"
                >
                  {adjustedPlayers.length}
                </Badge>
              </CardTitle>
              <span className="text-muted-foreground text-sm ml-auto">
                {showActiveAdj ? "▼" : "▶"}
              </span>
            </div>
          </CardHeader>
          {showActiveAdj && (
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Player</TableHead>
                      <TableHead className="text-xs">Team</TableHead>
                      <TableHead className="text-xs text-right">
                        O-LEB Adj
                      </TableHead>
                      <TableHead className="text-xs text-right">
                        D-LEB Adj
                      </TableHead>
                      <TableHead className="text-xs text-right">
                        Min Override
                      </TableHead>
                      <TableHead className="text-xs text-center">
                        Avail
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {adjustedPlayers.map((ap) => (
                      <TableRow key={`${ap.team}-${ap.name}`}>
                        <TableCell className="text-sm font-medium whitespace-nowrap py-1">
                          {ap.name}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground py-1">
                          {ap.team}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm py-1">
                          {ap.oAdj !== 0 ? (
                            <span
                              className={
                                ap.oAdj > 0 ? "text-green-600" : "text-red-500"
                              }
                            >
                              {ap.oAdj > 0 ? "+" : ""}
                              {ap.oAdj}
                            </span>
                          ) : (
                            "-"
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm py-1">
                          {ap.dAdj !== 0 ? (
                            <span
                              className={
                                ap.dAdj > 0 ? "text-green-600" : "text-red-500"
                              }
                            >
                              {ap.dAdj > 0 ? "+" : ""}
                              {ap.dAdj}
                            </span>
                          ) : (
                            "-"
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm py-1">
                          {ap.minOverride != null
                            ? `${ap.minOverride} (was ${ap.projMpg.toFixed(1)})`
                            : "-"}
                        </TableCell>
                        <TableCell className="text-center py-1">
                          {ap.hasAvailChange ? (
                            <Badge className="bg-orange-100 text-orange-700 dark:bg-orange-900/60 dark:text-orange-400 rounded-sm text-[10px]">
                              Modified
                            </Badge>
                          ) : (
                            "-"
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          )}
        </Card>
      )}

      {/* Team Ratings Summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Team Ratings (Adjusted)</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs w-8">#</TableHead>
                  <TableHead className="text-xs">Team</TableHead>
                  <TableHead className="text-xs text-right">O-LEB</TableHead>
                  <TableHead className="text-xs text-right">D-LEB</TableHead>
                  <TableHead className="text-xs text-right">
                    Total LEB
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {teamRatings.map((tr, i) => (
                  <TableRow key={tr.team}>
                    <TableCell className="text-muted-foreground text-xs tabular-nums py-1">
                      {i + 1}
                    </TableCell>
                    <TableCell className="text-sm font-medium py-1">
                      {tr.team}{" "}
                      <span className="text-muted-foreground text-xs">
                        {TEAM_FULL_NAMES[tr.team] ?? ""}
                      </span>
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums text-sm py-1 ${tr.oLeb > 0 ? "text-green-600" : "text-red-500"}`}
                    >
                      {tr.oLeb > 0 ? "+" : ""}
                      {tr.oLeb.toFixed(2)}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums text-sm py-1 ${tr.dLeb > 0 ? "text-green-600" : "text-red-500"}`}
                    >
                      {tr.dLeb > 0 ? "+" : ""}
                      {tr.dLeb.toFixed(2)}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums text-sm font-medium py-1 ${tr.leb > 0 ? "text-green-600" : "text-red-500"}`}
                    >
                      {tr.leb > 0 ? "+" : ""}
                      {tr.leb.toFixed(2)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Quick nav + toggle */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1 flex-wrap">
          {TEAM_ORDER.map(({ team }) => {
            if (!teamPlayers[team]) return null;
            return (
              <button
                key={team}
                onClick={() => scrollToTeam(team)}
                className="px-2 py-0.5 text-xs rounded border hover:bg-accent transition-colors"
              >
                {team}
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer ml-auto shrink-0">
          <input
            type="checkbox"
            checked={showZeroMin}
            onChange={(e) => setShowZeroMin(e.target.checked)}
            className="rounded"
          />
          Show 0-min players
        </label>
      </div>

      {/* Team sections */}
      {TEAM_ORDER.map(({ seed, team, conf }) => {
        const players = teamPlayers[team];
        if (!players) return null;
        const isCollapsed = collapsedTeams.has(team);
        const totalMins = teamMinTotals[team] ?? 0;
        const minsOk = Math.abs(totalMins - 240) < 1;
        const teamChanges = players.filter((p) => {
          const a = adjustments[p.espn_id];
          return a && hasUserChange(p.espn_id, a);
        }).length;

        return (
          <div
            key={team}
            ref={(el) => {
              teamRefs.current[team] = el;
            }}
          >
            <Card>
              <CardHeader
                className="cursor-pointer py-3 hover:bg-muted/30"
                onClick={() => toggleTeam(team)}
              >
                <div className="flex items-center gap-3">
                  <CardTitle className="text-base">
                    {conf} #{seed} {team}{" "}
                    <span className="text-muted-foreground font-normal">
                      {TEAM_FULL_NAMES[team] ?? ""}
                    </span>
                  </CardTitle>
                  <span
                    className={`text-xs tabular-nums ${minsOk ? "text-muted-foreground" : "text-red-500 font-medium"}`}
                  >
                    {totalMins.toFixed(0)}/240 min
                  </span>
                  {teamChanges > 0 && (
                    <Badge
                      variant="secondary"
                      className="text-[10px] rounded-sm"
                    >
                      {teamChanges} adj
                    </Badge>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-[10px] px-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleScaleAll(team);
                      }}
                    >
                      Scale All
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-[10px] px-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleScaleRemainder(team);
                      }}
                    >
                      Scale Rest
                    </Button>
                    <span className="text-muted-foreground text-sm ml-2">
                      {isCollapsed ? "▶" : "▼"}
                    </span>
                  </div>
                </div>
              </CardHeader>

              {!isCollapsed && (
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent border-b-0">
                          <TableHead
                            rowSpan={2}
                            className="min-w-[130px] sticky left-0 bg-background z-10"
                          >
                            Player
                          </TableHead>
                          <TableHead rowSpan={2} className="text-right w-12">
                            O-LEB
                          </TableHead>
                          <TableHead rowSpan={2} className="text-right w-12">
                            D-LEB
                          </TableHead>
                          <TableHead rowSpan={2} className="text-right w-12">
                            Min
                          </TableHead>
                          {ROUND_LABELS.map((r, ri) => (
                            <TableHead
                              key={r}
                              colSpan={ROUND_GAMES[ri]}
                              className="text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider border-l border-border/50"
                            >
                              {r}
                            </TableHead>
                          ))}
                        </TableRow>
                        <TableRow>
                          {ROUND_LABELS.map((_, ri) =>
                            Array.from(
                              { length: ROUND_GAMES[ri] },
                              (__, gi) => (
                                <TableHead
                                  key={`${ri}-${gi}`}
                                  className={`text-center text-[10px] px-0.5 w-7 ${gi === 0 ? "border-l border-border/50" : ""}`}
                                >
                                  {ri === 0 ? `P${gi + 1}` : `G${gi + 1}`}
                                </TableHead>
                              ),
                            ),
                          )}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {[...players]
                          .sort((a, b) => {
                            const aMin =
                              adjustments[a.espn_id]?.minutes_override ??
                              playoffMpgByEspnId[a.espn_id] ??
                              0;
                            const bMin =
                              adjustments[b.espn_id]?.minutes_override ??
                              playoffMpgByEspnId[b.espn_id] ??
                              0;
                            // Players with minutes first, then by minutes desc
                            if (aMin > 0 && bMin === 0) return -1;
                            if (aMin === 0 && bMin > 0) return 1;
                            return bMin - aMin;
                          })
                          .filter((p) => {
                            if (showZeroMin) return true;
                            const effMin =
                              adjustments[p.espn_id]?.minutes_override ??
                              playoffMpgByEspnId[p.espn_id] ??
                              0;
                            return effMin > 0;
                          })
                          .map((p) => {
                            const adj = adjustments[p.espn_id];
                            if (!adj) return null;
                            const projMpg = playoffMpgByEspnId[p.espn_id] ?? 0;
                            const hasChange = hasUserChange(p.espn_id, adj);

                            const effO = p.o_lebron + adj.o_lebron_delta;
                            const effD = p.d_lebron + adj.d_lebron_delta;
                            const effMin = adj.minutes_override ?? projMpg;

                            return (
                              <TableRow
                                key={p.espn_id}
                                className={`cursor-pointer hover:bg-muted/50 ${hasChange ? "bg-amber-50/50 dark:bg-amber-900/10" : ""}`}
                                onClick={() =>
                                  setModalPlayer({ player: p, team })
                                }
                              >
                                <TableCell className="font-medium whitespace-nowrap text-sm sticky left-0 bg-background z-10">
                                  <span className="flex items-center gap-1">
                                    {p.name}
                                    {p.autofill && (
                                      <Badge
                                        variant="secondary"
                                        className="text-[9px] px-1.5 py-0 rounded-sm"
                                      >
                                        est
                                      </Badge>
                                    )}
                                  </span>
                                </TableCell>
                                <TableCell
                                  className={`text-right tabular-nums text-xs ${adj.o_lebron_delta !== 0 ? "font-medium text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}
                                >
                                  {fmtLeb(effO)}
                                </TableCell>
                                <TableCell
                                  className={`text-right tabular-nums text-xs ${adj.d_lebron_delta !== 0 ? "font-medium text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}
                                >
                                  {fmtLeb(effD)}
                                </TableCell>
                                <TableCell
                                  className={`text-right tabular-nums text-xs ${adj.minutes_override != null ? "font-medium text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}
                                >
                                  {effMin.toFixed(1)}
                                </TableCell>
                                {ROUND_LABELS.map((_, ri) => {
                                  const start = ROUND_GAMES.slice(0, ri).reduce(
                                    (s, n) => s + n,
                                    0,
                                  );
                                  return Array.from(
                                    { length: ROUND_GAMES[ri] },
                                    (__, gi) => {
                                      const idx = start + gi;
                                      const pct = Math.round(
                                        (adj.availability[idx] ?? 1) * 100,
                                      );
                                      return (
                                        <TableCell
                                          key={idx}
                                          className={`text-center px-0.5 ${gi === 0 ? "border-l border-border/50" : ""}`}
                                        >
                                          <span
                                            className={`tabular-nums text-[10px] ${availPctClass(pct)}`}
                                          >
                                            {pct}
                                          </span>
                                        </TableCell>
                                      );
                                    },
                                  );
                                })}
                              </TableRow>
                            );
                          })}
                      </TableBody>
                    </Table>
                  </div>

                  {!minsOk && (
                    <div className="px-4 py-2 text-sm text-red-500 bg-red-50 dark:bg-red-900/10">
                      Total minutes: {totalMins.toFixed(1)} (should be 240)
                    </div>
                  )}
                </CardContent>
              )}
            </Card>
          </div>
        );
      })}
    </div>
  );
}

function buildAvailFromRounds(
  r1: number,
  r2: number,
  cf: number,
  fin: number,
): number[] {
  return [
    ...new Array(2).fill(r1), // play-in (use R1 value)
    ...new Array(7).fill(r1),
    ...new Array(7).fill(r2),
    ...new Array(7).fill(cf),
    ...new Array(7).fill(fin),
  ];
}
