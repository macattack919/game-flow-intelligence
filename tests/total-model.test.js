import test from "node:test";
import assert from "node:assert/strict";
import { estimatePossessions, extractAdvancedBox, projectLiveTotal } from "../api/total-model.js";

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
  assert.ok(Number.isFinite(projection.homeProjectedPoints));
  assert.ok(Number.isFinite(projection.awayProjectedPoints));
  assert.ok(Math.abs(projection.total - projection.homeProjectedPoints - projection.awayProjectedPoints) < 0.11);
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
