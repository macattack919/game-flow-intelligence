const LEAGUES = {
  nba: {
    label: "NBA",
    sitePath: "nba",
    regulationPeriods: 4,
    periodLengthSeconds: 12 * 60,
    groups: null
  },
  ncaa: {
    label: "NCAA Men's",
    sitePath: "mens-college-basketball",
    regulationPeriods: 2,
    periodLengthSeconds: 20 * 60,
    groups: "50"
  }
};

export default async function handler(req, res) {
  const leagueKey = String(req.query?.league || "nba").toLowerCase();
  const league = LEAGUES[leagueKey];

  if (!league) {
    return res.status(400).json({ error: "Unsupported league. Use league=nba or league=ncaa." });
  }

  const SITE_BASE = `https://site.api.espn.com/apis/site/v2/sports/basketball/${league.sitePath}`;

  async function getJson(url) {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" }
    });
    if (!response.ok) throw new Error(`ESPN request failed (${response.status})`);
    return response.json();
  }

  function easternDateYYYYMMDD() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date());
    const part = type => parts.find(item => item.type === type)?.value || "";
    return `${part("year")}${part("month")}${part("day")}`;
  }

  try {
    const requestedDate = String(req.query?.date || easternDateYYYYMMDD()).replace(/[^0-9]/g, "");
    if (!/^\d{8}$/.test(requestedDate)) {
      return res.status(400).json({ error: "Invalid date. Use YYYYMMDD." });
    }

    const params = new URLSearchParams({ limit: "500", dates: requestedDate });
    if (league.groups) params.set("groups", league.groups);

    // This endpoint deliberately returns scoreboard data only. It does not wait
    // for play-by-play or box-score lookups, so score and clock can refresh quickly.
    const scoreboard = await getJson(`${SITE_BASE}/scoreboard?${params.toString()}`);
    const games = (scoreboard.events || []).map(event => {
      const competitors = event.competitions?.[0]?.competitors || [];
      const home = competitors.find(team => team.homeAway === "home");
      const away = competitors.find(team => team.homeAway === "away");
      const mapTeam = item => ({
        id: item?.team?.id || null,
        name: item?.team?.location || item?.team?.shortDisplayName || item?.team?.displayName || "Team",
        abbreviation: item?.team?.abbreviation || "",
        score: Number(item?.score || 0),
        color: item?.team?.color || null,
        alternateColor: item?.team?.alternateColor || null,
        records: item?.records || [],
        stats: {}
      });

      return {
        id: event.id,
        name: event.name,
        shortName: `${away?.team?.location || away?.team?.shortDisplayName || away?.team?.displayName || "Away"} at ${home?.team?.location || home?.team?.shortDisplayName || home?.team?.displayName || "Home"}`,
        date: event.date,
        status: event.status?.type?.description || "",
        state: event.status?.type?.state || "",
        period: event.status?.period || 0,
        clock: event.status?.displayClock || "",
        periodLengthSeconds: league.periodLengthSeconds,
        regulationPeriods: league.regulationPeriods,
        home: mapTeam(home),
        away: mapTeam(away)
      };
    });

    res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
    return res.status(200).json({
      source: "ESPN",
      league: leagueKey,
      sport: league.label,
      updated: new Date().toISOString(),
      date: requestedDate,
      count: games.length,
      liveCount: games.filter(game => game.state === "in").length,
      games
    });
  } catch (error) {
    return res.status(502).json({
      error: "Score data request failed",
      league: leagueKey,
      details: error.message
    });
  }
}
