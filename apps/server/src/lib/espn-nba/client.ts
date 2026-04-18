import { espnFetch } from "./http.js";

const CORE_V2 = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba";
const SITE_V2 = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const CDN = "https://cdn.espn.com/core/nba";

export interface EspnRef {
  $ref: string;
}

export interface EspnPaginated<T> {
  count: number;
  pageIndex: number;
  pageSize: number;
  pageCount: number;
  items: T[];
}

export async function getScoreboard(dates: string): Promise<ScoreboardResponse> {
  return espnFetch<ScoreboardResponse>(`${SITE_V2}/scoreboard?dates=${dates}`);
}

export async function getGameSummary(eventId: string | number): Promise<GameSummary> {
  return espnFetch<GameSummary>(`${SITE_V2}/summary?event=${eventId}`);
}

export async function getGamePlayByPlay(
  eventId: string | number,
  limit = 1000,
): Promise<EspnPaginated<PlayItem>> {
  return espnFetch<EspnPaginated<PlayItem>>(
    `${CORE_V2}/events/${eventId}/competitions/${eventId}/plays?limit=${limit}`,
  );
}

export async function getWinProbability(
  eventId: string | number,
  limit = 1000,
): Promise<EspnPaginated<WinProbItem>> {
  return espnFetch<EspnPaginated<WinProbItem>>(
    `${CORE_V2}/events/${eventId}/competitions/${eventId}/probabilities?limit=${limit}`,
  );
}

export async function getGameSituation(eventId: string | number): Promise<GameSituation> {
  return espnFetch<GameSituation>(
    `${CORE_V2}/events/${eventId}/competitions/${eventId}/situation`,
  );
}

export async function getGameBoxscore(eventId: string | number): Promise<GameBoxscore> {
  return espnFetch<GameBoxscore>(`${CDN}/boxscore?xhr=1&gameId=${eventId}`);
}

export async function getAllAthletes(limit = 1000): Promise<EspnPaginated<EspnRef>> {
  return espnFetch<EspnPaginated<EspnRef>>(`${CORE_V2}/athletes?limit=${limit}`);
}

export async function getAthleteByRef<T>(ref: string): Promise<T> {
  return espnFetch<T>(ref);
}

// ─── Lightweight response shapes — enough for our ingest + UI ────────────────
// We lean on the real ESPN shape but type only the fields we read.

export interface TeamShape {
  id: string;
  abbreviation: string;
  displayName: string;
  shortDisplayName?: string;
  logo?: string;
  color?: string;
  alternateColor?: string;
  name?: string;
  location?: string;
}

export interface LinescoreEntry {
  value?: number;
  displayValue?: string;
}

export interface CompetitorShape {
  id: string;
  homeAway: "home" | "away";
  score?: string;
  team: TeamShape;
  linescores?: LinescoreEntry[];
  statistics?: { name: string; displayValue?: string; value?: number }[];
  records?: { name?: string; summary?: string; type?: string }[];
}

export interface StatusShape {
  displayClock?: string;
  period?: number;
  clock?: number;
  type?: {
    id?: string;
    name?: string;
    state?: "pre" | "in" | "post";
    completed?: boolean;
    detail?: string;
    shortDetail?: string;
  };
}

export interface CompetitionShape {
  id: string;
  date: string;
  venue?: { id?: string; fullName?: string; address?: { city?: string; state?: string } };
  status?: StatusShape;
  competitors: CompetitorShape[];
  broadcasts?: { names?: string[]; market?: string; type?: { shortName?: string } }[];
}

export interface ScoreboardEvent {
  id: string;
  date: string;
  name?: string;
  shortName?: string;
  competitions: CompetitionShape[];
  status?: StatusShape;
}

export interface ScoreboardResponse {
  events: ScoreboardEvent[];
  leagues?: unknown[];
  day?: { date: string };
}

export interface GameSummaryHeader {
  id: string;
  competitions: CompetitionShape[];
}

export interface BoxscorePlayer {
  athlete: { id: string; displayName: string; shortName?: string; jersey?: string; headshot?: { href?: string } };
  starter?: boolean;
  didNotPlay?: boolean;
  active?: boolean;
  ejected?: boolean;
  stats?: string[]; // MIN,FG,3PT,FT,OREB,DREB,REB,AST,STL,BLK,TO,PF,+/-,PTS
}

export interface BoxscoreTeamStatsEntry {
  name: string;
  displayValue?: string;
  label?: string;
}

export interface BoxscoreTeamSection {
  team: TeamShape;
  statistics?: { labels: string[]; names: string[]; keys: string[]; athletes: BoxscorePlayer[] }[];
}

export interface GameSummary {
  header?: { id: string; competitions: CompetitionShape[] };
  boxscore?: {
    teams?: { team: TeamShape; statistics?: BoxscoreTeamStatsEntry[] }[];
    players?: BoxscoreTeamSection[];
  };
  leaders?: unknown;
  news?: unknown;
  gameInfo?: unknown;
  situation?: unknown;
}

export interface GameBoxscore {
  gamepackageJSON?: GameSummary;
}

export interface PlayItem {
  id: string;
  sequenceNumber: string;
  period?: { number?: number };
  clock?: { displayValue?: string };
  scoringPlay?: boolean;
  scoreValue?: number;
  text?: string;
  shortText?: string;
  homeScore?: number;
  awayScore?: number;
  team?: EspnRef;
  participants?: { athlete?: EspnRef; type?: string }[];
}

export interface WinProbItem {
  sequenceNumber: string;
  period?: { number?: number };
  homeWinPercentage?: number;
  tiePercentage?: number;
  secondsLeft?: number;
  play?: EspnRef;
}

export interface GameSituation {
  homeTimeouts?: number;
  awayTimeouts?: number;
  homeFouls?: number;
  awayFouls?: number;
  lastPlay?: { id?: string; text?: string };
}
