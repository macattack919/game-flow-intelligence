// Live total projection v1.
// Estimates possessions from team box-score totals, then projects remaining points
// using a shrunk points-per-possession estimate. This is a transparent baseline,
// not a calibrated probability model.

const LEAGUE_PRIORS = {
  nba: {
    pointsPerPossession: 1.143,
    possessionsPerGame: 99.0,
    gameMinutes: 48
  },
  ncaa: {
    pointsPerPossession: 1.09,
    possessionsPerGame: 67.5,
    gameMinutes: 40
  }
};

const PPP_PRIOR_POSSESSIONS = 18;
const PACE_PRIOR_MINUTES = 6;
const FREE_THROW_WEIGHT = 0.44;

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseMadeAttempted(value) {
  if (value && typeof value === "object") {
    const made = asNumber(value.made);
    const attempted = asNumber(value.attempted);
    if (made !== null && attempted !== null) return { made, attempted };
  }
  const match = String(value ?? "").match(/(\d+)\s*[-/]\s*(\d+)/);
  if (!match) return null;
  return { made: Number(match[1]), attempted: Number(match[2]) };
}

function findPair(stats, madeToken, attemptedToken) {
  for (const [key, value] of Object.entries(stats || {})) {
    const normalized = normalizeKey(key);
    if (normalized.includes(madeToken) && normalized.includes(attemptedToken)) {
      const pair = parseMadeAttempted(value);
      if (pair) return pair;
    }
  }
  // Some ESPN responses expose only the attempts field as a numeric stat.
  for (const [key, value] of Object.entries(stats || {})) {
    if (normalizeKey(key) === attemptedToken) {
      const attempted = asNumber(value);
      if (attempted !== null) return { made: null, attempted };
    }
  }
  return null;
}

function findNumericStat(stats, aliases) {
  const entries = Object.entries(stats || {});
  for (const alias of aliases) {
    const target = normalizeKey(alias);
    const found = entries.find(([key]) => normalizeKey(key) === target);
    if (found) {
      const value = asNumber(found[1]);
      if (value !== null) return value;
    }
  }
  for (const [key, rawValue] of entries) {
    const normalized = normalizeKey(key);
    if (aliases.some(alias => normalized === normalizeKey(alias) || normalized.endsWith(normalizeKey(alias)))) {
      const value = asNumber(rawValue);
      if (value !== null) return value;
    }
  }
  return null;
}

export function extractAdvancedBox(stats) {
  const fieldGoals = findPair(stats, "fieldgoalsmade", "fieldgoalsattempted");
  const freeThrows = findPair(stats, "freethrowsmade", "freethrowsattempted");

  const box = {
    fieldGoalAttempts: fieldGoals?.attempted ?? findNumericStat(stats, ["fieldGoalsAttempted", "fga"]),
    freeThrowAttempts: freeThrows?.attempted ?? findNumericStat(stats, ["freeThrowsAttempted", "fta"]),
    offensiveRebounds: findNumericStat(stats, ["offensiveRebounds", "rebounds-offensive", "offensiveBoards", "oreb"]),
    turnovers: findNumericStat(stats, ["totalTurnovers", "turnovers", "teamTurnovers", "tov"])
  };

  box.complete = Object.values(box).slice(0, 4).every(value => value !== null);
  return box;
}

export function estimatePossessions(box) {
  if (!box?.complete) return null;
  const estimate = box.fieldGoalAttempts +
    FREE_THROW_WEIGHT * box.freeThrowAttempts -
    box.offensiveRebounds +
    box.turnovers;
  return Number.isFinite(estimate) && estimate > 0 ? estimate : null;
}

function parseClockSeconds(clock) {
  const match = String(clock || "").trim().match(/^(\d+):(\d{1,2})$/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (seconds > 59) return null;
  return minutes * 60 + seconds;
}

function gameClockState(period, clock, periodLengthSeconds, regulationPeriods) {
  const remainingInPeriod = parseClockSeconds(clock);
  if (!period || remainingInPeriod === null) return null;

  const periodLength = period > regulationPeriods ? 5 * 60 : periodLengthSeconds;
  const clampedRemaining = Math.max(0, Math.min(periodLength, remainingInPeriod));
  const elapsed = period <= regulationPeriods
    ? (period - 1) * periodLengthSeconds + (periodLengthSeconds - clampedRemaining)
    : regulationPeriods * periodLengthSeconds +
      (period - regulationPeriods - 1) * 5 * 60 +
      (5 * 60 - clampedRemaining);
  const window = regulationPeriods * periodLengthSeconds +
    Math.max(0, period - regulationPeriods) * 5 * 60;

  return {
    elapsedSeconds: Math.max(0, elapsed),
    remainingSeconds: Math.max(0, window - elapsed),
    windowSeconds: window
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

export function projectLiveTotal({
  league,
  state,
  period,
  clock,
  periodLengthSeconds,
  regulationPeriods,
  home,
  away
}) {
  if (state !== "in") return null;

  const prior = LEAGUE_PRIORS[league] || LEAGUE_PRIORS.nba;
  const clockState = gameClockState(period, clock, periodLengthSeconds, regulationPeriods);
  if (!clockState || clockState.elapsedSeconds < 60) {
    return {
      total: null,
      method: "warming_up",
      sample: "EARLY SAMPLE",
      possessionsPerTeam: null,
      homePPP: null,
      awayPPP: null,
      note: "Waiting for enough game time to establish a projection."
    };
  }

  const homeScore = asNumber(home?.score) ?? 0;
  const awayScore = asNumber(away?.score) ?? 0;
  const currentTotal = homeScore + awayScore;
  const elapsedMinutes = clockState.elapsedSeconds / 60;
  const remainingMinutes = clockState.remainingSeconds / 60;
  const homeBox = extractAdvancedBox(home?.stats);
  const awayBox = extractAdvancedBox(away?.stats);
  const homePossessions = estimatePossessions(homeBox);
  const awayPossessions = estimatePossessions(awayBox);

  if (homePossessions !== null && awayPossessions !== null && elapsedMinutes >= 2) {
    const gamePossessions = (homePossessions + awayPossessions) / 2;
    const priorPossessionsPerMinute = prior.possessionsPerGame / prior.gameMinutes;
    const possessionsPerMinute = (
      gamePossessions + priorPossessionsPerMinute * PACE_PRIOR_MINUTES
    ) / (elapsedMinutes + PACE_PRIOR_MINUTES);
    const remainingPossessions = possessionsPerMinute * remainingMinutes;

    const observedHomePPP = homeScore / Math.max(1, homePossessions);
    const observedAwayPPP = awayScore / Math.max(1, awayPossessions);
    const homePPP = (
      clamp(observedHomePPP, 0.55, 1.85) * homePossessions +
      prior.pointsPerPossession * PPP_PRIOR_POSSESSIONS
    ) / (homePossessions + PPP_PRIOR_POSSESSIONS);
    const awayPPP = (
      clamp(observedAwayPPP, 0.55, 1.85) * awayPossessions +
      prior.pointsPerPossession * PPP_PRIOR_POSSESSIONS
    ) / (awayPossessions + PPP_PRIOR_POSSESSIONS);

    const projectedRemainingPoints = remainingPossessions * (homePPP + awayPPP);
    const projectedTotal = currentTotal + projectedRemainingPoints;
    const sample = gamePossessions < 12
      ? "EARLY SAMPLE"
      : gamePossessions < 30
        ? "DEVELOPING SAMPLE"
        : "LARGER SAMPLE";

    return {
      total: round1(projectedTotal),
      method: "possessions_efficiency",
      sample,
      elapsedMinutes: round1(elapsedMinutes),
      remainingMinutes: round1(remainingMinutes),
      possessionsPerTeam: round1(gamePossessions),
      possessionsPerMinute: round1(possessionsPerMinute),
      projectedRemainingPossessions: round1(remainingPossessions),
      homePPP: round1(homePPP),
      awayPPP: round1(awayPPP),
      combinedPPP: round1(homePPP + awayPPP),
      currentTotal,
      note: "Possession and scoring-efficiency projection with early-game regression toward league averages."
    };
  }

  const elapsedFraction = clockState.elapsedSeconds / clockState.windowSeconds;
  const scorePaceTotal = elapsedFraction > 0
    ? currentTotal / elapsedFraction
    : null;

  return {
    total: scorePaceTotal === null ? null : round1(scorePaceTotal),
    method: "score_pace_fallback",
    sample: "LIMITED DATA",
    elapsedMinutes: round1(elapsedMinutes),
    remainingMinutes: round1(remainingMinutes),
    possessionsPerTeam: null,
    homePPP: null,
    awayPPP: null,
    combinedPPP: null,
    currentTotal,
    note: "Box-score possession inputs are incomplete; using a simple score-and-clock fallback."
  };
}
