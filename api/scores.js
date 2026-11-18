import { projectLiveTotal } from "./total-model.js";

const LEAGUES = {
  nba: {
    label: "NBA",
    sitePath: "nba",
    corePath: "nba",
    regulationPeriods: 4,
    periodLengthSeconds: 12 * 60,
    groups: null
  },
  ncaa: {
    label: "NCAA Men's",
    sitePath: "mens-college-basketball",
    corePath: "mens-college-basketball",
    regulationPeriods: 2,
    periodLengthSeconds: 20 * 60,
    groups: null
  }
};

export default async function handler(req, res) {
  const leagueKey = String(req.query?.league || "nba").toLowerCase();
  const league = LEAGUES[leagueKey];

  if (!league) {
    return res.status(400).json({ error: "Unsupported league. Use league=nba or league=ncaa." });
  }

  const SITE_BASE = `https://site.api.espn.com/apis/site/v2/sports/basketball/${league.sitePath}`;
  const CORE_BASE = `https://sports.core.api.espn.com/v2/sports/basketball/leagues/${league.corePath}`;

  async function getJson(url) {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`ESPN request failed (${response.status})`);
    return response.json();
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function mapPlay(play) {
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

  async function getGameDetails(event) {
    const id = encodeURIComponent(event.id);
    const summaryUrl = `${SITE_BASE}/summary?event=${id}`;
    const situationUrl = `${CORE_BASE}/events/${id}/competitions/${id}/situation?lang=en&region=us`;
    const oddsUrl = `${CORE_BASE}/events/${id}/competitions/${id}/odds?limit=50`;
    const [summaryResult, situationResult, oddsResult] = await Promise.allSettled([
      getJson(summaryUrl),
      getJson(situationUrl),
      getJson(oddsUrl)
    ]);
    return {
      summary: summaryResult.status === "fulfilled" ? summaryResult.value : null,
      situation: situationResult.status === "fulfilled" ? situationResult.value : null,
      odds: oddsResult.status === "fulfilled" ? oddsResult.value : null
    };
  }

  async function mapWithConcurrency(items, concurrency, mapper) {
    const output = new Array(items.length);
    let next = 0;
    async function worker() {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        try { output[index] = await mapper(items[index], index); }
        catch { output[index] = null; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return output;
  }

  function getTeamStats(summary, teamId) {
    const teams = summary?.boxscore?.teams || [];
    const team = teams.find(item => String(item.team?.id) === String(teamId));
    if (!team) return {};
    const stats = {};
    (team.statistics || []).forEach(stat => {
      const value = stat.displayValue ?? stat.value ?? null;
      const keys = [stat.name, stat.label, stat.abbreviation, stat.displayName].filter(Boolean);
      keys.forEach(rawKey => {
        const key = String(rawKey).toLowerCase();
        stats[key] = value;
      });
    });
    return stats;
  }

  function mapLiveTotal(oddsPayload) {
    const items = Array.isArray(oddsPayload?.items) ? oddsPayload.items : [];
    // ESPN can retain opening/closing/current pregame lines after tipoff.
    // Only accept a provider entry explicitly labeled as in-game/live.
    const liveItem = items.find(item => {
      const providerName = String(item.provider?.name || "").toLowerCase();
      const typeName = String(item.type?.name || item.type || "").toLowerCase();
      const details = String(item.details || "").toLowerCase();
      return providerName.includes("live odds") ||
        typeName.includes("live odds") ||
        details.includes("live odds");
    });
    if (!liveItem) return null;

    const total = numberOrNull(liveItem.overUnder ?? liveItem.current?.overUnder ?? liveItem.total);
    if (total === null) return null;

    return {
      total,
      isExplicitLive: true,
      updated: liveItem.lastUpdated || liveItem.last_update || liveItem.date || null
    };
  }

  function mapGame(event, details) {
    const competition = event.competitions?.[0];
    const competitors = competition?.competitors || [];
    const home = competitors.find(team => team.homeAway === "home");
    const away = competitors.find(team => team.homeAway === "away");
    const summary = details?.summary || null;
    const plays = (summary?.plays || []).map(mapPlay);
    const homeScore = Number(home?.score || 0);
    const awayScore = Number(away?.score || 0);

    const team = item => ({
      id: item?.team?.id || null,
      name: item?.team?.displayName || "Team",
      abbreviation: item?.team?.abbreviation || "",
      score: Number(item?.score || 0),
      color: item?.team?.color || null,
      alternateColor: item?.team?.alternateColor || null,
      records: item?.records || [],
      stats: getTeamStats(summary, item?.team?.id)
    });

    const homeTeam = team(home);
    const awayTeam = team(away);
    const totalProjection = projectLiveTotal({
      league: leagueKey,
      state: event.status?.type?.state || "",
      period: event.status?.period || 0,
      clock: event.status?.displayClock || "",
      periodLengthSeconds: league.periodLengthSeconds,
      regulationPeriods: league.regulationPeriods,
      home: homeTeam,
      away: awayTeam
    });

    return {
      id: event.id,
      name: event.name,
      shortName: event.shortName || event.name,
      date: event.date,
      status: event.status?.type?.description || "",
      state: event.status?.type?.state || "",
      period: event.status?.period || 0,
      clock: event.status?.displayClock || "",
      periodLengthSeconds: league.periodLengthSeconds,
      regulationPeriods: league.regulationPeriods,
      home: homeTeam,
      away: awayTeam,
      totalProjection,
      scoringEvents: plays.filter(play => play.scoringPlay).slice(-120),
      playEvents: plays.slice(-300),
      liveTotal: mapLiveTotal(details?.odds),
      statsAvailable: !!summary,
      situationAvailable: !!details?.situation
    };
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
    const scoreboard = await getJson(`${SITE_BASE}/scoreboard?${params.toString()}`);
    const events = scoreboard.events || [];
    const liveEvents = events.filter(event => event.status?.type?.state === "in");
    const detailResults = await mapWithConcurrency(liveEvents, 4, getGameDetails);
    const detailsById = {};
    liveEvents.forEach((event, index) => { detailsById[event.id] = detailResults[index]; });
    const games = events.map(event => mapGame(event, detailsById[event.id] || null));

    res.setHeader("Cache-Control", "s-maxage=8, stale-while-revalidate=10");
    return res.status(200).json({
      source: "ESPN",
      league: leagueKey,
      sport: league.label,
      updated: new Date().toISOString(),
      date: requestedDate,
      count: games.length,
      liveCount: liveEvents.length,
      analysisVersion: 1,
      games
    });
  } catch (error) {
    return res.status(502).json({ error: "Score data request failed", league: leagueKey, details: error.message });
  }
}
