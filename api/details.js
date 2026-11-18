const LEAGUES = {
  nba: { sitePath: "nba" },
  ncaa: { sitePath: "mens-college-basketball" }
};

export default async function handler(req, res) {
  const leagueKey = String(req.query?.league || "nba").toLowerCase();
  const league = LEAGUES[leagueKey];
  if (!league) {
    return res.status(400).json({ error: "Unsupported league. Use league=nba or league=ncaa." });
  }

  const eventIds = [...new Set(String(req.query?.events || "")
    .split(",")
    .map(value => value.trim())
    .filter(value => /^\d{1,20}$/.test(value)))].slice(0, 80);

  if (!eventIds.length) {
    res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
    return res.status(200).json({ source: "ESPN", league: leagueKey, details: {} });
  }

  const SITE_BASE = `https://site.api.espn.com/apis/site/v2/sports/basketball/${league.sitePath}`;

  async function getJson(url) {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" }
    });
    if (!response.ok) throw new Error(`ESPN request failed (${response.status})`);
    return response.json();
  }

  function getTeamStats(summary, teamId) {
    const team = (summary?.boxscore?.teams || [])
      .find(item => String(item.team?.id) === String(teamId));
    if (!team) return {};
    const stats = {};
    (team.statistics || []).forEach(stat => {
      const value = stat.displayValue ?? stat.value ?? null;
      [stat.name, stat.label, stat.abbreviation, stat.displayName]
        .filter(Boolean)
        .forEach(key => { stats[String(key).toLowerCase()] = value; });
    });
    return stats;
  }

  function mapPlay(play) {
    const numberOrNull = value => {
      if (value === null || value === undefined || value === "") return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    };
    return {
      sequence: numberOrNull(play.sequenceNumber ?? play.sequence),
      period: numberOrNull(play.period?.number) || 0,
      clock: play.clock?.displayValue || "",
      homeScore: numberOrNull(play.homeScore),
      awayScore: numberOrNull(play.awayScore),
      teamId: play.team?.id || null,
      teamName: play.team?.displayName || null,
      scoringPlay: !!play.scoringPlay,
      points: numberOrNull(play.scoreValue),
      type: play.type?.text || play.type?.name || null,
      description: play.text || ""
    };
  }

  async function mapWithConcurrency(items, concurrency, mapper) {
    const output = new Array(items.length);
    let next = 0;
    async function worker() {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        try { output[index] = await mapper(items[index]); }
        catch { output[index] = null; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return output;
  }

  try {
    const summaries = await mapWithConcurrency(eventIds, 6, eventId =>
      getJson(`${SITE_BASE}/summary?event=${encodeURIComponent(eventId)}`)
    );
    const details = {};
    eventIds.forEach((eventId, index) => {
      const summary = summaries[index];
      if (!summary) return;
      const competitors = summary.header?.competitions?.[0]?.competitors ||
        summary.boxscore?.teams?.map(team => ({
          id: team.team?.id,
          homeAway: team.homeAway
        })) || [];
      const home = competitors.find(team => team.homeAway === "home");
      const away = competitors.find(team => team.homeAway === "away");
      const plays = (summary.plays || []).map(mapPlay);

      details[eventId] = {
        homeStats: getTeamStats(summary, home?.id),
        awayStats: getTeamStats(summary, away?.id),
        scoringEvents: plays.filter(play => play.scoringPlay).slice(-500),
        playEvents: plays.slice(-300),
        updated: new Date().toISOString()
      };
    });

    res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
    return res.status(200).json({
      source: "ESPN",
      league: leagueKey,
      updated: new Date().toISOString(),
      details
    });
  } catch (error) {
    return res.status(502).json({
      error: "Game detail request failed",
      league: leagueKey,
      details: error.message
    });
  }
}
