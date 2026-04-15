import { LeagueDetailView } from "@/components/league-detail-view";

export default async function LeaguePage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;

  return <LeagueDetailView leagueId={leagueId} />;
}
