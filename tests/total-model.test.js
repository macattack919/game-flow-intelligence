import test from "node:test";
import assert from "node:assert/strict";
import { estimatePossessions, extractAdvancedBox, projectLiveTotal, evaluateLiveTotalSignal, evaluateTripleDipperSignal, evaluateLateGameOverPotential, projectHalfTeamTotals } from "../lib/total-model.js";

const homeStats = {
  "fieldGoalsMade-fieldGoalsAttempted": "18-40",
  "freeThrowsMade-freeThrowsAttempted": "7-9",
  offensiveRebounds: "4",
  turnovers: "5"
};

const awayStats = {
  "fieldGoalsMade-fieldGoalsAttempted": "17-38",
  "freeThrowsMade-freeThrowsAttempted": "8-12",
  offensiveRebounds: "6",
  turnovers: "6"
};

test("extracts standard ESPN-style box-score fields", () => {
  const box = extractAdvancedBox(homeStats);
  assert.equal(box.fieldGoalAttempts, 40);
  assert.equal(box.freeThrowAttempts, 9);
  assert.equal(box.offensiveRebounds, 4);
  assert.equal(box.turnovers, 5);
  assert.equal(box.complete, true);
});

test("estimates possessions using FGA + 0.44 FTA - OREB + turnovers", () => {
  const box = extractAdvancedBox(homeStats);
  assert.equal(estimatePossessions(box), 40 + 0.44 * 9 - 4 + 5);
});

test("creates a possession-and-efficiency projection for a live NBA game", () => {
  const projection = projectLiveTotal({
    league: "nba",
    state: "in",
    period: 2,
    clock: "5:00",
    periodLengthSeconds: 12 * 60,
    regulationPeriods: 4,
    home: { score: 45, stats: homeStats },
    away: { score: 43, stats: awayStats }
  });
  assert.equal(projection.method, "possessions_efficiency");
  assert.equal(projection.elapsedMinutes, 19);
  assert.equal(projection.remainingMinutes, 29);
  assert.ok(Number.isFinite(projection.total));
  assert.ok(projection.total >= 88);
  assert.ok(Number.isFinite(projection.projectedHomeMargin));
  assert.ok(Number.isFinite(projection.projectedRemainingPossessions));
  assert.ok(projection.projectedRemainingPossessions > 0);
  assert.ok(Number.isFinite(projection.homeProjectedPoints));
  assert.ok(Number.isFinite(projection.awayProjectedPoints));
  assert.ok(Math.abs(projection.total - projection.homeProjectedPoints - projection.awayProjectedPoints) < 0.11);
});

test("uses recent possession pace as a limited-weight adjustment", () => {
  const input = {
    league: "nba",
    state: "in",
    period: 2,
    clock: "5:00",
    periodLengthSeconds: 12 * 60,
    regulationPeriods: 4,
    home: { score: 45, stats: homeStats },
    away: { score: 43, stats: awayStats }
  };
  const baseline = projectLiveTotal(input);
  const fasterRecent = projectLiveTotal({
    ...input,
    recentPossessionsPerMinute: 2.7,
    recentPaceWindowMinutes: 4.5
  });
  assert.equal(fasterRecent.recentPossessionsPerMinute, 2.7);
  assert.ok(fasterRecent.possessionsPerMinute > baseline.possessionsPerMinute);
  assert.ok(fasterRecent.total > baseline.total);
});

test("extracts live shot profile and returns a regressed team-specific efficiency", () => {
  const shootingStats = {
    ...homeStats,
    "threePointFieldGoalsMade-threePointFieldGoalsAttempted": "6-15"
  };
  const box = extractAdvancedBox(shootingStats);
  assert.equal(box.shootingComplete, true);
  assert.equal(box.fieldGoalsMade, 18);
  assert.equal(box.threePointFieldGoalsMade, 6);
  assert.equal(box.threePointFieldGoalAttempts, 15);

  const projection = projectLiveTotal({
    league: "nba",
    state: "in",
    period: 2,
    clock: "5:00",
    periodLengthSeconds: 12 * 60,
    regulationPeriods: 4,
    home: { score: 45, stats: shootingStats },
    away: { score: 43, stats: awayStats }
  });
  assert.equal(projection.homeShootingProfile.threePointPct, 40);
  assert.equal(projection.homeShootingProfile.effectiveFieldGoalPct, 52.5);
  assert.ok(Number.isFinite(projection.homePPP));
  assert.ok(projection.homePPP > 0);
});

test("uses a transparent score-pace fallback when possession stats are missing", () => {
  const projection = projectLiveTotal({
    league: "ncaa",
    state: "in",
    period: 1,
    clock: "15:00",
    periodLengthSeconds: 20 * 60,
    regulationPeriods: 2,
    home: { score: 12, stats: {} },
    away: { score: 8, stats: {} }
  });
  assert.equal(projection.method, "score_pace_fallback");
  assert.equal(projection.sample, "LIMITED DATA");
  assert.equal(projection.total, 160);
  assert.equal(projection.homeProjectedPoints, 96);
  assert.equal(projection.awayProjectedPoints, 64);
  assert.equal(projection.projectedHomeMargin, 32);
  assert.equal(projection.projectedRemainingPossessions, 59.1);
});

test("waits for a usable clock sample and ignores non-live games", () => {
  const early = projectLiveTotal({
    league: "nba",
    state: "in",
    period: 1,
    clock: "11:30",
    periodLengthSeconds: 12 * 60,
    regulationPeriods: 4,
    home: { score: 2, stats: homeStats },
    away: { score: 0, stats: awayStats }
  });
  assert.equal(early.method, "warming_up");
  assert.equal(early.projectedRemainingPossessions, null);

  const final = projectLiveTotal({
    league: "nba",
    state: "post",
    period: 4,
    clock: "0:00",
    periodLengthSeconds: 12 * 60,
    regulationPeriods: 4,
    home: { score: 100, stats: homeStats },
    away: { score: 98, stats: awayStats }
  });
  assert.equal(final, null);
});

test("handles an NBA overtime period without adding hypothetical future overtimes", () => {
  const projection = projectLiveTotal({
    league: "nba",
    state: "in",
    period: 5,
    clock: "3:00",
    periodLengthSeconds: 12 * 60,
    regulationPeriods: 4,
    home: { score: 110, stats: homeStats },
    away: { score: 108, stats: awayStats }
  });
  assert.equal(projection.method, "possessions_efficiency");
  assert.equal(projection.elapsedMinutes, 50);
  assert.equal(projection.remainingMinutes, 3);
});


test("flags an over entry window only when model edge reaches the conservative threshold", () => {
  const signal = evaluateLiveTotalSignal({
    projection: { total: 154, method: "possessions_efficiency", elapsedMinutes: 20 },
    liveLine: 145.5,
    remainingMinutes: 20,
    scoreMargin: 6
  });
  assert.equal(signal.status, "OVER_WINDOW");
  assert.equal(signal.direction, "OVER");
  assert.equal(signal.edge, 8.5);
});

test("flags an under entry window when the model is sufficiently below the live total", () => {
  const signal = evaluateLiveTotalSignal({
    projection: { total: 154, method: "possessions_efficiency", elapsedMinutes: 20 },
    liveLine: 162,
    remainingMinutes: 20,
    scoreMargin: 6
  });
  assert.equal(signal.status, "UNDER_WINDOW");
  assert.equal(signal.direction, "UNDER");
  assert.equal(signal.edge, -8);
});

test("returns watch rather than entry for a moderate model edge", () => {
  const signal = evaluateLiveTotalSignal({
    projection: { total: 154, method: "possessions_efficiency", elapsedMinutes: 20 },
    liveLine: 149,
    remainingMinutes: 20,
    scoreMargin: 6
  });
  assert.equal(signal.status, "WATCH_OVER");
});

test("blocks signals during a scoring surge or a close late-game finish", () => {
  const projection = { total: 154, method: "possessions_efficiency", elapsedMinutes: 20 };
  const surge = evaluateLiveTotalSignal({
    projection, liveLine: 145, remainingMinutes: 5, scoreMargin: 6, recentScoringSurge: true
  });
  assert.equal(surge.status, "VOLATILE");
  const late = evaluateLiveTotalSignal({
    projection, liveLine: 170, remainingMinutes: 3, scoreMargin: 4
  });
  assert.equal(late.status, "LATE_GAME");
});

test("does not generate an entry from fallback projections or without a live line", () => {
  const fallback = evaluateLiveTotalSignal({
    projection: { total: 154, method: "score_pace_fallback", elapsedMinutes: 20 },
    liveLine: 140, remainingMinutes: 20, scoreMargin: 10
  });
  assert.equal(fallback.status, "NO_BET");
  const missingLine = evaluateLiveTotalSignal({
    projection: { total: 154, method: "possessions_efficiency", elapsedMinutes: 20 },
    liveLine: null, remainingMinutes: 20, scoreMargin: 10
  });
  assert.equal(missingLine.status, "NEEDS_LINE");
});


test("uses the team-total label for individual team market comparisons", () => {
  const missingLine = evaluateLiveTotalSignal({
    projection: { total: 82.5, method: "possessions_efficiency", elapsedMinutes: 18 },
    liveLine: null,
    remainingMinutes: 22,
    scoreMargin: 5,
    marketLabel: "team total"
  });
  assert.equal(missingLine.status, "NEEDS_LINE");
  assert.match(missingLine.reason, /live team total/);

  const over = evaluateLiveTotalSignal({
    projection: { total: 91, method: "possessions_efficiency", elapsedMinutes: 18 },
    liveLine: 82.5,
    remainingMinutes: 22,
    scoreMargin: 5,
    marketLabel: "team total"
  });
  assert.equal(over.status, "OVER_WINDOW");
  assert.equal(over.direction, "OVER");
  assert.equal(over.edge, 8.5);
  assert.match(over.reason, /live team total/);
});


test("projects both regulation team halves during the first half", () => {
  const halves = projectHalfTeamTotals({
    league: "ncaa",
    state: "in",
    period: 1,
    clock: "10:00",
    periodLengthSeconds: 20 * 60,
    regulationPeriods: 2,
    home: { score: 20 },
    away: { score: 18 },
    scoringEvents: [],
    model: { possessionsPerMinute: 1.7, homePPP: 1.1, awayPPP: 1.0 }
  });
  assert.equal(halves.currentHalf, 1);
  assert.equal(halves.home.firstHalf.actual, false);
  assert.equal(halves.home.firstHalf.points, 38.7);
  assert.equal(halves.away.firstHalf.points, 35);
  assert.equal(halves.home.secondHalf.points, 37.4);
  assert.equal(halves.away.secondHalf.points, 34);
  assert.ok(["OVER_PACE", "UNDER_PACE", "ON_PACE"].includes(halves.home.firstHalf.pace));
});

test("tracks completed first-half scores and projects the second half from live scoring", () => {
  const halves = projectHalfTeamTotals({
    league: "ncaa",
    state: "in",
    period: 2,
    clock: "15:00",
    periodLengthSeconds: 20 * 60,
    regulationPeriods: 2,
    home: { score: 48 },
    away: { score: 42 },
    scoringEvents: [
      { period: 1, clock: "0:04", sequence: 100, homeScore: 40, awayScore: 34 }
    ],
    model: { possessionsPerMinute: 1.8, homePPP: 1.08, awayPPP: 1.0 }
  });
  assert.equal(halves.currentHalf, 2);
  assert.equal(halves.home.firstHalf.points, 40);
  assert.equal(halves.away.firstHalf.points, 34);
  assert.equal(halves.home.firstHalf.actual, true);
  assert.equal(halves.home.secondHalf.points, 37.2);
  assert.equal(halves.away.secondHalf.points, 35);
  assert.equal(halves.home.secondHalf.actual, false);
});

test("returns no half split when second-half play-by-play is not available", () => {
  const halves = projectHalfTeamTotals({
    league: "nba",
    state: "in",
    period: 3,
    clock: "9:00",
    periodLengthSeconds: 12 * 60,
    regulationPeriods: 4,
    home: { score: 70 },
    away: { score: 65 },
    scoringEvents: [],
    model: { possessionsPerMinute: 2, homePPP: 1.1, awayPPP: 1.0 }
  });
  assert.equal(halves, null);
});


test("fires Triple Dipper when every published NCAA condition is met", () => {
  const signal = evaluateTripleDipperSignal({
    league: "ncaa", state: "in", period: 2, regulationPeriods: 2,
    elapsedMinutes: 24, remainingMinutes: 16,
    homeScore: 45, awayScore: 33, liveLine: 160
  });
  assert.equal(signal.status, "TRIPLE_DIPPER_UNDER");
  assert.equal(signal.direction, "UNDER");
  assert.equal(signal.neededPpm, 5.13);
  assert.equal(signal.actualPpm, 3.25);
  assert.equal(signal.gapPpm, 1.88);
});

test("Triple Dipper excludes an 8-point lead, overtime, and time outside minutes 20–32", () => {
  const base = {
    league: "ncaa", state: "in", period: 2, regulationPeriods: 2,
    elapsedMinutes: 24, remainingMinutes: 16, homeScore: 44, awayScore: 36, liveLine: 160
  };
  assert.equal(evaluateTripleDipperSignal(base).status, "CLOSE_GAME");
  assert.equal(evaluateTripleDipperSignal({...base, homeScore: 45, awayScore: 33, period: 3}).status, "OVERTIME");
  assert.equal(evaluateTripleDipperSignal({...base, homeScore: 45, awayScore: 33, elapsedMinutes: 32.1}).status, "OUTSIDE_WINDOW");
});

test("Triple Dipper requires both 4.7 needed points per minute and a 1.3 pace gap", () => {
  const base = {
    league: "ncaa", state: "in", period: 2, regulationPeriods: 2,
    elapsedMinutes: 24, remainingMinutes: 16, homeScore: 48, awayScore: 30, liveLine: 150
  };
  assert.equal(evaluateTripleDipperSignal(base).status, "NO_SIGNAL");
  assert.equal(evaluateTripleDipperSignal({...base, liveLine: 180}).status, "TRIPLE_DIPPER_UNDER");
});

test("Triple Dipper is NCAA-only and requires a manually entered live total", () => {
  const base = {
    league: "ncaa", state: "in", period: 2, regulationPeriods: 2,
    elapsedMinutes: 24, remainingMinutes: 16, homeScore: 45, awayScore: 33
  };
  assert.equal(evaluateTripleDipperSignal({...base, league: "nba", liveLine: 160}).status, "UNSUPPORTED");
  assert.equal(evaluateTripleDipperSignal(base).status, "NEEDS_LINE");
});

test("identifies a strong NCAA late-foul Over potential when the leader has the ball and is in the bonus", () => {
  const potential = evaluateLateGameOverPotential({
    league: "ncaa",
    state: "in",
    period: 2,
    regulationPeriods: 2,
    remainingMinutes: 1.2,
    homeScore: 71,
    awayScore: 67,
    homeTeamId: "home",
    awayTeamId: "away",
    possessionTeamId: "home",
    homeOffense: { label: "DOUBLE BONUS", tone: "up" }
  });
  assert.equal(potential.status, "HIGH");
  assert.equal(potential.qualified, true);
  assert.equal(potential.leaderSide, "home");
  assert.equal(potential.leaderHasPossession, true);
  assert.equal(potential.leaderDoubleBonus, true);
});

test("shows a late-game watch for a close NCAA finish before strong foul conditions are confirmed", () => {
  const potential = evaluateLateGameOverPotential({
    league: "ncaa",
    state: "in",
    period: 2,
    regulationPeriods: 2,
    remainingMinutes: 2.4,
    homeScore: 68,
    awayScore: 61,
    homeTeamId: "home",
    awayTeamId: "away"
  });
  assert.equal(potential.status, "WATCH");
  assert.equal(potential.qualified, true);
});

test("does not flag late-foul Over potential in blowouts, early game, or NBA games", () => {
  const base = {
    league: "ncaa", state: "in", period: 2, regulationPeriods: 2,
    remainingMinutes: 1.2, homeScore: 80, awayScore: 65
  };
  assert.equal(evaluateLateGameOverPotential(base).status, "NOT_CLOSE");
  assert.equal(evaluateLateGameOverPotential({ ...base, homeScore: 71, awayScore: 67, remainingMinutes: 3.1 }).status, "TOO_EARLY");
  assert.equal(evaluateLateGameOverPotential({ ...base, league: "nba" }).status, "UNSUPPORTED");
});

test("allows a late-game Over signal only when the late-foul setup is qualified and the model edge remains positive", () => {
  const lateGameOverPotential = { qualified: true, reason: "The leader has possession and is in the double bonus." };
  const strong = evaluateLiveTotalSignal({
    projection: { total: 150, method: "possessions_efficiency", elapsedMinutes: 38.8 },
    liveLine: 142,
    remainingMinutes: 1.2,
    scoreMargin: 4,
    lateGameOverPotential
  });
  assert.equal(strong.status, "OVER_WINDOW");
  assert.equal(strong.direction, "OVER");
  assert.match(strong.label, /LATE FOUL/);

  const watch = evaluateLiveTotalSignal({
    projection: { total: 147, method: "possessions_efficiency", elapsedMinutes: 38.8 },
    liveLine: 142,
    remainingMinutes: 1.2,
    scoreMargin: 4,
    lateGameOverPotential
  });
  assert.equal(watch.status, "WATCH_OVER");

  const noEdge = evaluateLiveTotalSignal({
    projection: { total: 143, method: "possessions_efficiency", elapsedMinutes: 38.8 },
    liveLine: 142,
    remainingMinutes: 1.2,
    scoreMargin: 4,
    lateGameOverPotential
  });
  assert.equal(noEdge.status, "LATE_FOUL_POTENTIAL");
  assert.equal(noEdge.direction, null);
});
