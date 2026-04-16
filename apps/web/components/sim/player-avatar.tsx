"use client";

import { useState } from "react";

const ESPN_TEAM_ABBR: Record<string, string> = {
  NY: "nyk",
  SA: "sa",
  GS: "gs",
  PHX: "phx",
};

function teamLogoUrl(team: string): string {
  const abbr = (ESPN_TEAM_ABBR[team] ?? team).toLowerCase();
  return `https://cdn.espn.com/combiner/i?img=/i/teamlogos/nba/500/${abbr}.png&h=80&w=80`;
}

function playerHeadshotUrl(espnId: string, size: number): string {
  return `https://cdn.espn.com/combiner/i?img=/i/headshots/nba/players/full/${espnId}.png&w=${size * 4}`;
}

/** Player headshot from ESPN CDN.
 *  ESPN images are landscape — we use object-cover + object-top to crop into a circle. */
export function PlayerHeadshot({
  espnId,
  size = 24,
  className,
}: {
  espnId: string;
  size?: number;
  className?: string;
}) {
  const [errored, setErrored] = useState(false);

  return (
    <div
      className={`shrink-0 rounded-full overflow-hidden bg-muted ${className ?? ""}`}
      style={{ width: size, height: size }}
    >
      {errored ? (
        <svg viewBox="0 0 24 24" className="w-full h-full text-muted-foreground/30">
          <circle cx="12" cy="9" r="4" fill="currentColor" />
          <path d="M4 22c0-4.4 3.6-8 8-8s8 3.6 8 8" fill="currentColor" />
        </svg>
      ) : (
        <img
          src={playerHeadshotUrl(espnId, size)}
          alt=""
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover object-top"
          onError={() => setErrored(true)}
        />
      )}
    </div>
  );
}

/** Team logo from ESPN CDN. */
export function TeamLogo({
  team,
  size = 16,
  className,
}: {
  team: string;
  size?: number;
  className?: string;
}) {
  const [errored, setErrored] = useState(false);

  if (errored) {
    return (
      <div
        className={`shrink-0 rounded-sm bg-muted/60 flex items-center justify-center text-muted-foreground font-bold ${className ?? ""}`}
        style={{ width: size, height: size, fontSize: Math.max(Math.round(size * 0.45), 9) }}
      >
        {team.charAt(0)}
      </div>
    );
  }

  return (
    <img
      src={teamLogoUrl(team)}
      alt={team}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={`shrink-0 ${className ?? ""}`}
      style={{ width: size, height: size }}
      onError={() => setErrored(true)}
    />
  );
}

/** Composite avatar: player headshot with team logo badge in bottom-right. */
export function PlayerAvatar({
  espnId,
  team,
  size = 28,
}: {
  espnId: string;
  team: string;
  size?: number;
}) {
  const logoSize = Math.round(size * 0.55);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <PlayerHeadshot espnId={espnId} size={size} />
      <div className="absolute -bottom-0.5 -right-0.5">
        <TeamLogo team={team} size={logoSize} />
      </div>
    </div>
  );
}
