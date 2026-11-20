const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function clockSeconds(clock) {
  const match = String(clock || "").trim().match(/^(\d+):(\d{1,2})$/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  return seconds <= 59 ? minutes * 60 + seconds : null;
}

function kindText(play) {
  return `${play?.type || ""} ${play?.typeText || ""} ${play?.description || ""}`.toLowerCase();
}

function isTimeout(play) {
  return /\btime\s*out\b|\btimeout\b/.test(kindText(play));
}

function isSubstitution(play) {
  return /\bsubstitution\b|\bsub\s*in\b|\bsub\s*out\b|\benters? the game\b|\bchecks? in\b|\breplaces?\b/.test(kindText(play));
}

function participantName(participant) {
  return participant?.name ||
    participant?.athlete?.displayName ||
    participant?.athlete?.shortName ||
    participant?.displayName ||
    null;
}

function participantRole(participant) {
  const value = participant?.role || participant?.type?.text ||
    participant?.type?.name || participant?.type || "";
  return String(value).toLowerCase();
}

function parseSubstitution(play) {
  const participants = Array.isArray(play?.participants) ? play.participants : [];
  let playerIn = null;
  let playerOut = null;

  for (const participant of participants) {
    const name = participantName(participant);
    const role = participantRole(participant);
    if (!name) continue;
    if (/\bin\b|enter|check.?in|substitut(e|ion) in/.test(role)) playerIn ||= name;
    if (/\bout\b|exit|check.?out|substitut(e|ion) out/.test(role)) playerOut ||= name;
  }

  const description = String(play?.description || "");
  if (!playerIn || !playerOut) {
    const patterns = [
      /(?:substitution|sub)\s*:\s*(.+?)\s+for\s+(.+?)(?:[.!]|$)/i,
      /(.+?)\s+enters?\s+(?:the game\s+)?for\s+(.+?)(?:[.!]|$)/i,
      /(.+?)\s+checks?\s+in\s+for\s+(.+?)(?:[.!]|$)/i,
      /(.+?)\s+replaces\s+(.+?)(?:[.!]|$)/i
    ];
    for (const pattern of patterns) {
      const match = description.match(pattern);
      if (!match) continue;
      playerIn ||= match[1].trim();
      playerOut ||= match[2].trim();
      break;
    }
  }

  return { playerIn, playerOut };
}

function opposingTeam(teamId, homeTeamId, awayTeamId) {
  if (teamId === null || teamId === undefined) return null;
  if (String(teamId) === String(homeTeamId)) return awayTeamId ?? null;
  if (String(teamId) === String(awayTeamId)) return homeTeamId ?? null;
  return null;
}

function inferPossession(plays, homeTeamId, awayTeamId) {
  for (let index = plays.length - 1; index >= 0; index -= 1) {
    const play = plays[index];
    const direct = play?.possessionTeamId ??
      play?.possession?.team?.id ??
      play?.possession?.teamId ??
      null;
    if (direct !== null && direct !== undefined) {
      return { teamId: String(direct), source: "ESPN play data", confidence: "high" };
    }

    const text = kindText(play);
    const teamId = play?.teamId ?? null;
    if (teamId === null || teamId === undefined) continue;

    if (/\bturnover\b|\blost the ball\b/.test(text)) {
      const other = opposingTeam(teamId, homeTeamId, awayTeamId);
      if (other !== null) return { teamId: String(other), source: "turnover", confidence: "medium" };
    }
    if (/\bsteal\b/.test(text)) {
      return { teamId: String(teamId), source: "steal", confidence: "medium" };
    }
    if (/\brebound\b/.test(text)) {
      return { teamId: String(teamId), source: "rebound", confidence: "medium" };
    }
    if (/jump ball/.test(text) && /wins|controlled by/.test(text)) {
      return { teamId: String(teamId), source: "jump ball", confidence: "medium" };
    }

    const freeThrow = /free throw|\bfree-throw\b/.test(text);
    if (play?.scoringPlay && number(play?.points) >= 2 && !freeThrow) {
      const other = opposingTeam(teamId, homeTeamId, awayTeamId);
      if (other !== null) return { teamId: String(other), source: "made basket", confidence: "medium" };
    }
  }
  return { teamId: null, source: null, confidence: "unknown" };
}

function regulationRemainingMinutes(league, period, clock) {
  const p = number(period);
  const seconds = clockSeconds(clock);
  if (p === null || seconds === null) return null;
  const periodSeconds = league === "nba" ? 12 * 60 : 20 * 60;
  const regulationPeriods = league === "nba" ? 4 : 2;
  if (p > regulationPeriods) return seconds / 60;
  return ((regulationPeriods - p) * periodSeconds + seconds) / 60;
}

export function buildLiveContext({
  plays = [],
  homeTeamId = null,
  awayTeamId = null,
  homeScore = 0,
  awayScore = 0,
  period = null,
  clock = "",
  league = "ncaa"
} = {}) {
  const ordered = (Array.isArray(plays) ? plays : [])
    .map((play, index) => ({ ...play, _order: index }))
    .sort((a, b) => {
      const left = number(a.sequence);
      const right = number(b.sequence);
      if (left !== null && right !== null && left !== right) return left - right;
      return a._order - b._order;
    });

  const timeoutIndex = ordered.findLastIndex(play =>
    isTimeout(play) && (number(play.period) === null || number(play.period) === number(period))
  );
  const laterPlays = timeoutIndex >= 0 ? ordered.slice(timeoutIndex + 1) : [];
  const resumedAfterTimeout = laterPlays.some(play => {
    const text = kindText(play);
    return play.scoringPlay ||
      /shot|turnover|rebound|steal|foul|violation|jump ball|free throw|blocks?|inbound|ball in|play resumes|period start/.test(text);
  });
  const timeoutPlay = timeoutIndex >= 0 ? ordered[timeoutIndex] : null;
  const timeoutActive = !!timeoutPlay && !resumedAfterTimeout;

  const currentSeconds = clockSeconds(clock);
  const recentSubstitutions = ordered
    .filter(play => isSubstitution(play) &&
      (number(play.period) === null || number(play.period) === number(period)))
    .filter(play => {
      const subSeconds = clockSeconds(play.clock);
      if (subSeconds === null || currentSeconds === null) return true;
      return subSeconds >= currentSeconds && subSeconds - currentSeconds <= 180;
    })
    .slice(-8)
    .map(play => ({
      teamId: play.teamId === null || play.teamId === undefined ? null : String(play.teamId),
      teamName: play.teamName || null,
      clock: play.clock || "",
      description: play.description || play.typeText || "Substitution",
      ...parseSubstitution(play)
    }));

  const substitutionPlayers = new Map();
  for (const substitution of recentSubstitutions) {
    if (!substitution.playerIn || !substitution.teamId) continue;
    if (!substitutionPlayers.has(substitution.teamId)) {
      substitutionPlayers.set(substitution.teamId, new Set());
    }
    substitutionPlayers.get(substitution.teamId).add(substitution.playerIn.toLowerCase());
  }
  const substitutionCounts = new Map(
    [...substitutionPlayers].map(([teamId, names]) => [teamId, names.size])
  );

  const homeId = homeTeamId === null ? null : String(homeTeamId);
  const awayId = awayTeamId === null ? null : String(awayTeamId);
  const home = { teamId: homeId, score: number(homeScore) ?? 0 };
  const away = { teamId: awayId, score: number(awayScore) ?? 0 };
  const leader = home.score === away.score ? null : home.score > away.score ? home : away;
  const margin = Math.abs(home.score - away.score);
  const remainingMinutes = regulationRemainingMinutes(league, period, clock);
  const lateGame = remainingMinutes !== null && remainingMinutes <= 5;
  const leadingTeamSubstitutions = leader?.teamId
    ? substitutionCounts.get(leader.teamId) || 0
    : 0;
  const benchRotationLikely = !!leader && margin >= 10 && lateGame &&
    leadingTeamSubstitutions >= 3;

  const possession = inferPossession(ordered, homeId, awayId);
  const isLiveActionAfterTimeout = timeoutActive ? null : true;

  return {
    timeoutActive,
    timeoutTeamName: timeoutPlay?.teamName || null,
    timeoutClock: timeoutPlay?.clock || "",
    possession,
    recentSubstitutions,
    substitutionCounts: Object.fromEntries(substitutionCounts),
    leadingTeamId: leader?.teamId || null,
    leadingTeamMargin: margin,
    remainingMinutes,
    benchRotationLikely,
    benchRotationTeamId: benchRotationLikely ? leader.teamId : null,
    liveActionAfterTimeout: isLiveActionAfterTimeout
  };
}
