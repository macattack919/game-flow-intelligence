// Live total projection v1.
// Estimates possessions from team box-score totals, then projects remaining points
// using a shrunk points-per-possession estimate. This is a transparent baseline,
// not a calibrated probability model.

const LEAGUE_PRIORS = {
  // Shooting priors are anchored to the most recently completed season
  // available in the source data, rather than partial current-season averages.
  nba: {
    pointsPerPossession: 1.143,
    possessionsPerGame: 99.4,
    gameMinutes: 48,
    twoPointPct: 0.550,
    threePointPct: 0.360,
    freeThrowPct: 0.783,
    twoPointAttemptsPerPossession: 0.524,
    threePointAttemptsPerPossession: 0.372,
    freeThrowAttemptsPerPossession: 0.236
  },
  ncaa: {
    pointsPerPossession: 1.09,
    possessionsPerGame: 67.5,
    gameMinutes: 40,
    twoPointPct: 0.524,
    threePointPct: 0.341,
    freeThrowPct: 0.724,
    twoPointAttemptsPerPossession: 0.526,
    threePointAttemptsPerPossession: 0.345,
    freeThrowAttemptsPerPossession: 0.304
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
  const threePointGoals = findPair(stats, "threepointfieldgoalsmade", "threepointfieldgoalsattempted");
  const freeThrows = findPair(stats, "freethrowsmade", "freethrowsattempted");

  const box = {
    fieldGoalsMade: fieldGoals?.made ?? findNumericStat(stats, ["fieldGoalsMade", "fgm"]),
    fieldGoalAttempts: fieldGoals?.attempted ?? findNumericStat(stats, ["fieldGoalsAttempted", "fga"]),
    threePointFieldGoalsMade: threePointGoals?.made ?? findNumericStat(stats, ["threePointFieldGoalsMade", "threePointersMade", "3pm"]),
    threePointFieldGoalAttempts: threePointGoals?.attempted ?? findNumericStat(stats, ["threePointFieldGoalsAttempted", "threePointAttempts", "3pa"]),
    freeThrowsMade: freeThrows?.made ?? findNumericStat(stats, ["freeThrowsMade", "ftm"]),
    freeThrowAttempts: freeThrows?.attempted ?? findNumericStat(stats, ["freeThrowsAttempted", "fta"]),
    offensiveRebounds: findNumericStat(stats, ["offensiveRebounds", "rebounds-offensive", "offensiveBoards", "oreb"]),
    turnovers: findNumericStat(stats, ["totalTurnovers", "turnovers", "teamTurnovers", "tov"])
  };

  box.complete = [
    box.fieldGoalAttempts,
    box.freeThrowAttempts,
    box.offensiveRebounds,
    box.turnovers
  ].every(value => value !== null);

  const twoPointAttempts = box.fieldGoalAttempts - box.threePointFieldGoalAttempts;
  const twoPointMakes = box.fieldGoalsMade - box.threePointFieldGoalsMade;
  box.shootingComplete = [
    box.fieldGoalsMade,
    box.fieldGoalAttempts,
    box.threePointFieldGoalsMade,
    box.threePointFieldGoalAttempts,
    box.freeThrowsMade,
    box.freeThrowAttempts
  ].every(value => value !== null) &&
    twoPointAttempts >= 0 &&
    twoPointMakes >= 0 &&
    box.threePointFieldGoalAttempts >= 0 &&
    box.freeThrowAttempts >= 0;
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

function round2(value) {
  return Math.round(value * 100) / 100;
}

function buildShootingProfile(box) {
  if (!box?.shootingComplete) return null;
  const fga = box.fieldGoalAttempts;
  const threePA = box.threePointFieldGoalAttempts;
  const twoPA = fga - threePA;
  const twoPM = box.fieldGoalsMade - box.threePointFieldGoalsMade;
  const eFG = fga > 0 ? (box.fieldGoalsMade + 0.5 * box.threePointFieldGoalsMade) / fga : null;
  return {
    fieldGoalPct: fga > 0 ? round1(100 * box.fieldGoalsMade / fga) : null,
    effectiveFieldGoalPct: fga > 0 ? round1(100 * eFG) : null,
    twoPointPct: twoPA > 0 ? round1(100 * twoPM / twoPA) : null,
    threePointPct: threePA > 0 ? round1(100 * box.threePointFieldGoalsMade / threePA) : null,
    freeThrowPct: box.freeThrowAttempts > 0 ? round1(100 * box.freeThrowsMade / box.freeThrowAttempts) : null,
    threePointAttemptRate: fga > 0 ? round1(100 * threePA / fga) : null,
    freeThrowAttemptRate: fga > 0 ? round1(100 * box.freeThrowAttempts / fga) : null
  };
}

// Build an expected PPP from the team's live shot mix and conversion rates.
// Attempt rates and percentages are regressed toward league priors so a short
// hot/cold stretch does not dominate the projection.
function profilePointsPerPossession(box, possessions, prior) {
  if (!box?.shootingComplete || !Number.isFinite(possessions) || possessions <= 0) return null;
  const twoPA = box.fieldGoalAttempts - box.threePointFieldGoalAttempts;
  const twoPM = box.fieldGoalsMade - box.threePointFieldGoalsMade;
  const threePA = box.threePointFieldGoalAttempts;
  const threePM = box.threePointFieldGoalsMade;
  const fta = box.freeThrowAttempts;
  const ftm = box.freeThrowsMade;

  const ratePriorPossessions = 18;
  const rateDenominator = possessions + ratePriorPossessions;
  const twoPAperPoss = (twoPA + prior.twoPointAttemptsPerPossession * ratePriorPossessions) / rateDenominator;
  const threePAperPoss = (threePA + prior.threePointAttemptsPerPossession * ratePriorPossessions) / rateDenominator;
  const ftaPerPoss = (fta + prior.freeThrowAttemptsPerPossession * ratePriorPossessions) / rateDenominator;

  const twoPct = (twoPM + prior.twoPointPct * 14) / (twoPA + 14);
  const threePct = (threePM + prior.threePointPct * 12) / (threePA + 12);
  const freeThrowPct = (ftm + prior.freeThrowPct * 10) / (fta + 10);

  return {
    pointsPerPossession: 2 * twoPAperPoss * twoPct +
      3 * threePAperPoss * threePct +
      ftaPerPoss * freeThrowPct,
    profile: buildShootingProfile(box)
  };
}

// Compares the model projection with a manually entered, current sportsbook total.
// Thresholds are intentionally conservative placeholders pending historical calibration.
export function evaluateLiveTotalSignal({
  projection,
  liveLine,
  remainingMinutes,
  scoreMargin,
  recentScoringSurge = false,
  marketLabel = "game total"
}) {
  const marketName = marketLabel === "team total" ? "live team total" : "live game total";
  const isFiniteValue = value =>
    value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  const noSignal = (status, label, reason) => ({
    status, label, direction: null, edge: null, reason,
    liveLine: isFiniteValue(liveLine) ? Number(liveLine) : null,
    projectedTotal: isFiniteValue(projection?.total) ? Number(projection.total) : null
  });

  if (!projection || !isFiniteValue(projection.total)) {
    return noSignal("WAIT", "WAIT FOR DATA", "The live projection is not available yet.");
  }
  if (projection.method !== "possessions_efficiency" ||
      !isFiniteValue(projection.elapsedMinutes) ||
      Number(projection.elapsedMinutes) < 8) {
    return noSignal("NO_BET", "NO BET", "Waiting for a usable possession and efficiency sample.");
  }
  if (!isFiniteValue(liveLine) || Number(liveLine) <= 0) {
    return noSignal("NEEDS_LINE", "ADD LIVE LINE", `Enter the current ${marketName} from your sportsbook. The app does not fetch or scrape sportsbook lines.`);
  }
  if (recentScoringSurge) {
    return noSignal("VOLATILE", "SCORING SURGE · WAIT", "Recent scoring has accelerated. Let the projection catch up before considering an entry.");
  }
  if (isFiniteValue(remainingMinutes) && Number(remainingMinutes) <= 4 &&
      isFiniteValue(scoreMargin) && Math.abs(Number(scoreMargin)) <= 8) {
    return noSignal("LATE_GAME", "LATE-GAME RISK · WAIT", "A close finish can produce intentional fouls and a sudden burst of free throws.");
  }

  const edge = round1(Number(projection.total) - Number(liveLine));
  const common = {
    edge,
    liveLine: Number(liveLine),
    projectedTotal: round1(Number(projection.total)),
    reason: edge > 0
      ? `Model is ${Math.abs(edge).toFixed(1)} points above the ${marketName}.`
      : `Model is ${Math.abs(edge).toFixed(1)} points below the ${marketName}.`
  };

  if (edge >= 7.5) return { ...common, status: "OVER_WINDOW", label: "OVER WINDOW", direction: "OVER" };
  if (edge <= -7.5) return { ...common, status: "UNDER_WINDOW", label: "UNDER WINDOW", direction: "UNDER" };
  if (edge >= 4) return { ...common, status: "WATCH_OVER", label: "WATCH OVER", direction: "OVER" };
  if (edge <= -4) return { ...common, status: "WATCH_UNDER", label: "WATCH UNDER", direction: "UNDER" };
  return { ...common, status: "NO_BET", label: "NO BET", direction: null,
    reason: `The model and ${marketName} are too close to show a meaningful gap.` };
}

// Projects team scoring by regulation half. These are pace-based estimates and
// league-baseline comparisons, not sportsbook-line recommendations.

export function evaluateTripleDipperSignal({
  league,
  state,
  period,
  regulationPeriods = 2,
  elapsedMinutes,
  remainingMinutes,
  homeScore,
  awayScore,
  liveLine
}) {
  const numeric = value => value !== null && value !== undefined &&
    value !== "" && Number.isFinite(Number(value));
  const result = (status, label, reason, extra = {}) => ({
    status, label, reason, direction: status === "TRIPLE_DIPPER_UNDER" ? "UNDER" : null,
    liveLine: numeric(liveLine) ? Number(liveLine) : null,
    ...extra
  });

  if (league !== "ncaa") return result("UNSUPPORTED", "NCAA ONLY", "Triple Dipper is defined for NCAA men's basketball only.");
  if (state !== "in") return result("WAIT", "WAIT FOR LIVE GAME", "The game must be live.");
  if (numeric(period) && numeric(regulationPeriods) && Number(period) > Number(regulationPeriods)) {
    return result("OVERTIME", "NO SIGNAL · OVERTIME", "Triple Dipper does not fire in overtime.");
  }
  if (!numeric(elapsedMinutes) || !numeric(remainingMinutes) || Number(remainingMinutes) <= 0) {
    return result("WAIT_CLOCK", "WAIT FOR CLOCK", "A valid regulation game clock is required.");
  }

  const elapsed = Number(elapsedMinutes);
  const remaining = Number(remainingMinutes);
  if (elapsed < 20 || elapsed > 32) {
    return result("OUTSIDE_WINDOW", "OUTSIDE 20–32 MIN WINDOW", "The signal is only evaluated from game minute 20 through 32.", {
      elapsedMinutes: round2(elapsed)
    });
  }
  if (!numeric(liveLine)) {
    return result("NEEDS_LINE", "ADD LIVE TOTAL", "Enter the current live game total above to evaluate Triple Dipper.", {
      elapsedMinutes: round2(elapsed)
    });
  }
  if (!numeric(homeScore) || !numeric(awayScore)) return result("WAIT_SCORE", "WAIT FOR SCORE", "Current team scores are not available.");

  const home = Number(homeScore);
  const away = Number(awayScore);
  const currentTotal = home + away;
  const scoreMargin = Math.abs(home - away);
  if (scoreMargin <= 8) {
    return result("CLOSE_GAME", "SKIP · CLOSE GAME", "The lead must be greater than 8 points to avoid late-game foul risk.", {
      currentTotal, scoreMargin, elapsedMinutes: round2(elapsed)
    });
  }

  const neededPpm = (Number(liveLine) - currentTotal) / remaining;
  const actualPpm = currentTotal / elapsed;
  const gapPpm = neededPpm - actualPpm;
  const extra = {
    currentTotal, scoreMargin,
    elapsedMinutes: round2(elapsed),
    remainingMinutes: round2(remaining),
    neededPpm: round2(neededPpm),
    actualPpm: round2(actualPpm),
    gapPpm: round2(gapPpm)
  };

  if (neededPpm < 4.7) return result("NO_SIGNAL", "NO TRIPLE DIPPER", "The live total needs less than 4.7 points per minute to reach the line.", extra);
  if (gapPpm < 1.3) return result("NO_SIGNAL", "NO TRIPLE DIPPER", "The game is not yet at least 1.3 points per minute below the pace needed.", extra);
  return result("TRIPLE_DIPPER_UNDER", "TRIPLE DIPPER UNDER", "All published Triple Dipper conditions are met.", extra);
}

export function projectHalfTeamTotals({
  league,
  state,
  period,
  clock,
  periodLengthSeconds,
  regulationPeriods,
  home,
  away,
  scoringEvents = [],
  model = null
}) {
  if (state !== "in") return null;

  const prior = LEAGUE_PRIORS[league] || LEAGUE_PRIORS.nba;
  const periodCount = Number(regulationPeriods);
  const periodLength = Number(periodLengthSeconds);
  const halfPeriods = league === "nba" ? periodCount / 2 : 1;
  if (!Number.isInteger(halfPeriods) || halfPeriods < 1 ||
      !Number.isFinite(periodLength) || periodLength <= 0) return null;

  const clockState = gameClockState(period, clock, periodLength, periodCount);
  if (!clockState) return null;

  const halfSeconds = periodLength * halfPeriods;
  const regulationSeconds = periodLength * periodCount;
  const elapsedRegulation = Math.min(clockState.elapsedSeconds, regulationSeconds);
  const currentHalf = elapsedRegulation < halfSeconds
    ? 1
    : elapsedRegulation < regulationSeconds ? 2 : 3;
  const elapsedInCurrentHalf = currentHalf === 1
    ? elapsedRegulation
    : currentHalf === 2 ? elapsedRegulation - halfSeconds : halfSeconds;
  const remainingInCurrentHalf = currentHalf === 1
    ? halfSeconds - elapsedInCurrentHalf
    : currentHalf === 2 ? regulationSeconds - elapsedRegulation : 0;
  const halfLengthMinutes = halfSeconds / 60;

  const timeline = (scoringEvents || [])
    .filter(event =>
      Number.isFinite(Number(event.period)) &&
      event.homeScore !== null && event.homeScore !== undefined &&
      event.awayScore !== null && event.awayScore !== undefined &&
      Number(event.period) <= periodCount
    )
    .map(event => ({
      period: Number(event.period),
      sequence: asNumber(event.sequence) ?? 0,
      home: asNumber(event.homeScore),
      away: asNumber(event.awayScore)
    }))
    .filter(event => event.home !== null && event.away !== null)
    .sort((a, b) => a.period - b.period || a.sequence - b.sequence);

  const lastAtOrBefore = maxPeriod =>
    timeline.filter(event => event.period <= maxPeriod).at(-1) || null;

  let firstHalfScore;
  if (currentHalf === 1) {
    firstHalfScore = {
      home: asNumber(home?.score) ?? 0,
      away: asNumber(away?.score) ?? 0
    };
  } else {
    const firstHalfEvent = lastAtOrBefore(halfPeriods);
    if (!firstHalfEvent) return null;
    firstHalfScore = { home: firstHalfEvent.home, away: firstHalfEvent.away };
  }

  let secondHalfScore = { home: 0, away: 0 };
  if (currentHalf === 2) {
    secondHalfScore = {
      home: Math.max(0, (asNumber(home?.score) ?? 0) - firstHalfScore.home),
      away: Math.max(0, (asNumber(away?.score) ?? 0) - firstHalfScore.away)
    };
  } else if (currentHalf === 3) {
    const regulationEnd = lastAtOrBefore(periodCount);
    if (regulationEnd) {
      secondHalfScore = {
        home: Math.max(0, regulationEnd.home - firstHalfScore.home),
        away: Math.max(0, regulationEnd.away - firstHalfScore.away)
      };
    } else {
      secondHalfScore = null;
    }
  }

  const elapsedMinutes = clockState.elapsedSeconds / 60;
  if (elapsedMinutes < 5) return null;

  const pacePerMinute = isFiniteNumber(model?.possessionsPerMinute) && model.possessionsPerMinute > 0
    ? Number(model.possessionsPerMinute)
    : prior.possessionsPerGame / prior.gameMinutes;
  const homePPP = isFiniteNumber(model?.homePPP) && model.homePPP > 0
    ? Number(model.homePPP) : prior.pointsPerPossession;
  const awayPPP = isFiniteNumber(model?.awayPPP) && model.awayPPP > 0
    ? Number(model.awayPPP) : prior.pointsPerPossession;
  const benchmark = (prior.possessionsPerGame / prior.gameMinutes) * halfLengthMinutes * prior.pointsPerPossession;
  const classify = points => points === null || points === undefined
    ? "UNAVAILABLE"
    : points >= benchmark + 2.5 ? "OVER_PACE"
    : points <= benchmark - 2.5 ? "UNDER_PACE" : "ON_PACE";
  const teamResult = (side, ppp) => {
    const current = side === "home"
      ? (asNumber(home?.score) ?? 0)
      : (asNumber(away?.score) ?? 0);
    const first = firstHalfScore[side];
    const second = secondHalfScore?.[side] ?? null;
    let firstProjection = first;
    let secondProjection = second;

    if (currentHalf === 1) {
      firstProjection = first + pacePerMinute * (remainingInCurrentHalf / 60) * ppp;
      secondProjection = pacePerMinute * halfLengthMinutes * ppp;
    } else if (currentHalf === 2) {
      secondProjection = second + pacePerMinute * (remainingInCurrentHalf / 60) * ppp;
    }

    return {
      firstHalf: {
        points: round1(firstProjection),
        actual: currentHalf > 1,
        pace: classify(firstProjection)
      },
      secondHalf: {
        points: secondProjection === null || secondProjection === undefined
          ? null : round1(secondProjection),
        actual: currentHalf === 3,
        pace: classify(secondProjection)
      }
    };
  };

  return {
    currentHalf,
    halfLengthMinutes: round1(halfLengthMinutes),
    benchmark: round1(benchmark),
    home: teamResult("home", homePPP),
    away: teamResult("away", awayPPP),
    note: "OVER/UNDER PACE compares the estimate with a typical league team half, not a sportsbook line."
  };
}

function isFiniteNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

export function projectLiveTotal({
  league,
  state,
  period,
  clock,
  periodLengthSeconds,
  regulationPeriods,
  home,
  away,
  recentPossessionsPerMinute = null,
  recentPaceWindowMinutes = null
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
      projectedRemainingPossessions: null,
      homePPP: null,
      awayPPP: null,
      homeProjectedPoints: null,
      awayProjectedPoints: null,
      projectedHomeMargin: null,
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
    const basePossessionsPerMinute = (
      gamePossessions + priorPossessionsPerMinute * PACE_PRIOR_MINUTES
    ) / (elapsedMinutes + PACE_PRIOR_MINUTES);
    const hasRecentPace = isFiniteNumber(recentPossessionsPerMinute) &&
      Number(recentPossessionsPerMinute) >= 0.75 &&
      Number(recentPossessionsPerMinute) <= 3.2 &&
      isFiniteNumber(recentPaceWindowMinutes) &&
      Number(recentPaceWindowMinutes) >= 2;
    const recentPaceWeight = hasRecentPace
      ? clamp((Number(recentPaceWindowMinutes) - 1.5) / 10, 0.15, 0.35)
      : 0;
    const possessionsPerMinute = hasRecentPace
      ? basePossessionsPerMinute * (1 - recentPaceWeight) +
        Number(recentPossessionsPerMinute) * recentPaceWeight
      : basePossessionsPerMinute;
    const remainingPossessions = possessionsPerMinute * remainingMinutes;

    const observedHomePPP = homeScore / Math.max(1, homePossessions);
    const observedAwayPPP = awayScore / Math.max(1, awayPossessions);
    const homeBasePPP = (
      clamp(observedHomePPP, 0.55, 1.85) * homePossessions +
      prior.pointsPerPossession * PPP_PRIOR_POSSESSIONS
    ) / (homePossessions + PPP_PRIOR_POSSESSIONS);
    const awayBasePPP = (
      clamp(observedAwayPPP, 0.55, 1.85) * awayPossessions +
      prior.pointsPerPossession * PPP_PRIOR_POSSESSIONS
    ) / (awayPossessions + PPP_PRIOR_POSSESSIONS);

    const homeShotProfile = profilePointsPerPossession(homeBox, homePossessions, prior);
    const awayShotProfile = profilePointsPerPossession(awayBox, awayPossessions, prior);
    const homePPP = homeShotProfile
      ? homeBasePPP * 0.65 + homeShotProfile.pointsPerPossession * 0.35
      : homeBasePPP;
    const awayPPP = awayShotProfile
      ? awayBasePPP * 0.65 + awayShotProfile.pointsPerPossession * 0.35
      : awayBasePPP;

    const homeProjectedPoints = homeScore + remainingPossessions * homePPP;
    const awayProjectedPoints = awayScore + remainingPossessions * awayPPP;
    const projectedTotal = homeProjectedPoints + awayProjectedPoints;
    const projectedHomeMargin = homeProjectedPoints - awayProjectedPoints;
    const sample = gamePossessions < 12
      ? "EARLY SAMPLE"
      : gamePossessions < 30
        ? "DEVELOPING SAMPLE"
        : "LARGER SAMPLE";

    return {
      total: round1(projectedTotal),
      homeProjectedPoints: round1(homeProjectedPoints),
      awayProjectedPoints: round1(awayProjectedPoints),
      projectedHomeMargin: round1(projectedHomeMargin),
      method: "possessions_efficiency",
      sample,
      elapsedMinutes: round1(elapsedMinutes),
      remainingMinutes: round1(remainingMinutes),
      possessionsPerTeam: round1(gamePossessions),
      possessionsPerMinute: round2(possessionsPerMinute),
      basePossessionsPerMinute: round2(basePossessionsPerMinute),
      recentPossessionsPerMinute: hasRecentPace ? round2(Number(recentPossessionsPerMinute)) : null,
      recentPaceWindowMinutes: hasRecentPace ? round1(Number(recentPaceWindowMinutes)) : null,
      recentPaceWeight: round2(recentPaceWeight),
      projectedRemainingPossessions: round1(remainingPossessions),
      homePPP: round2(homePPP),
      awayPPP: round2(awayPPP),
      combinedPPP: round2(homePPP + awayPPP),
      homeShootingProfile: homeShotProfile?.profile || buildShootingProfile(homeBox),
      awayShootingProfile: awayShotProfile?.profile || buildShootingProfile(awayBox),
      currentTotal,
      overtime: period > regulationPeriods,
      note: period > regulationPeriods
        ? "Possession and scoring-efficiency projection through the end of the current overtime period; additional overtimes are not modeled."
        : "Possession and scoring-efficiency projection with early-game regression toward league averages."
    };
  }

  if (elapsedMinutes < 5) {
    return {
      total: null,
      method: "warming_up",
      sample: "EARLY SAMPLE",
      elapsedMinutes: round1(elapsedMinutes),
      remainingMinutes: round1(remainingMinutes),
      possessionsPerTeam: null,
      projectedRemainingPossessions: null,
      homePPP: null,
      awayPPP: null,
      combinedPPP: null,
      homeProjectedPoints: null,
      awayProjectedPoints: null,
      projectedHomeMargin: null,
      currentTotal,
      overtime: period > regulationPeriods,
      note: "Waiting for complete box-score inputs or a longer game sample before using the fallback projection."
    };
  }

  const elapsedFraction = clockState.elapsedSeconds / clockState.windowSeconds;
  const homeProjectedPoints = elapsedFraction > 0 ? homeScore / elapsedFraction : null;
  const awayProjectedPoints = elapsedFraction > 0 ? awayScore / elapsedFraction : null;
  const scorePaceTotal = homeProjectedPoints === null || awayProjectedPoints === null
    ? null
    : homeProjectedPoints + awayProjectedPoints;
  const projectedHomeMargin = homeProjectedPoints === null || awayProjectedPoints === null
    ? null
    : homeProjectedPoints - awayProjectedPoints;
  const projectedRemainingPossessions = prior.possessionsPerGame / prior.gameMinutes * remainingMinutes;

  return {
    total: scorePaceTotal === null ? null : round1(scorePaceTotal),
    homeProjectedPoints: homeProjectedPoints === null ? null : round1(homeProjectedPoints),
    awayProjectedPoints: awayProjectedPoints === null ? null : round1(awayProjectedPoints),
    projectedHomeMargin: projectedHomeMargin === null ? null : round1(projectedHomeMargin),
    method: "score_pace_fallback",
    sample: "LIMITED DATA",
    elapsedMinutes: round1(elapsedMinutes),
    remainingMinutes: round1(remainingMinutes),
    possessionsPerTeam: null,
    projectedRemainingPossessions: round1(projectedRemainingPossessions),
    homePPP: null,
    awayPPP: null,
    combinedPPP: null,
    currentTotal,
    overtime: period > regulationPeriods,
    note: "Box-score possession inputs are incomplete; using a simple score-and-clock fallback."
  };
}
