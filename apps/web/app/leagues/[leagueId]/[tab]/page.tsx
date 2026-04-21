import { notFound } from "next/navigation";
import { LeagueDetailView } from "@/components/league-detail-view";

const VALID_TABS = new Set([
  "overview",
  "managers",
  "players",
  "draft",
  "reveal",
  "standings",
  "simulator",
  "chart",
  "commissioner",
]);

type LeagueTab =
  | "overview"
  | "managers"
  | "players"
  | "draft"
  | "reveal"
  | "standings"
  | "simulator"
  | "chart"
  | "commissioner";

export default async function LeagueTabPage({
  params,
}: {
  params: Promise<{ leagueId: string; tab: string }>;
}) {
  const { leagueId, tab } = await params;
  if (!VALID_TABS.has(tab)) {
    notFound();
  }
  return <LeagueDetailView leagueId={leagueId} initialTab={tab as LeagueTab} />;
}
