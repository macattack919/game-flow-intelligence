import test from "node:test";
import assert from "node:assert/strict";
import { buildLiveContext } from "../lib/live-context.js";

test("marks a current timeout and clears it when an in-game action follows", () => {
  const timeout = buildLiveContext({
    league: "nba",
    period: 4,
    clock: "2:12",
    homeTeamId: "10",
    awayTeamId: "20",
    plays: [
      { sequence: 1, period: 4, clock: "2:20", teamId: "10", type: "Jump Shot", description: "Shot missed" },
      { sequence: 2, period: 4, clock: "2:12", teamId: "20", type: "Timeout", description: "Full timeout" }
    ]
  });
  assert.equal(timeout.timeoutActive, true);
  assert.equal(timeout.timeoutTeamName, null);

  const resumed = buildLiveContext({
    league: "nba",
    period: 4,
    clock: "2:05",
    homeTeamId: "10",
    awayTeamId: "20",
    plays: [
      { sequence: 1, period: 4, clock: "2:20", teamId: "10", type: "Jump Shot", description: "Shot missed" },
      { sequence: 2, period: 4, clock: "2:12", teamId: "20", type: "Timeout", description: "Full timeout" },
      { sequence: 3, period: 4, clock: "2:05", teamId: "10", type: "Turnover", description: "Bad pass" }
    ]
  });
  assert.equal(resumed.timeoutActive, false);
});

test("infers possession for made baskets, turnovers, steals, and rebounds", () => {
  const base = {
    league: "nba",
    period: 3,
    clock: "4:00",
    homeTeamId: "10",
    awayTeamId: "20"
  };
  const madeBasket = buildLiveContext({
    ...base,
    plays: [{ sequence: 1, period: 3, clock: "4:05", teamId: "10", scoringPlay: true, points: 2, type: "Jump Shot", description: "Made jump shot" }]
  });
  assert.equal(madeBasket.possession.teamId, "20");

  const turnover = buildLiveContext({
    ...base,
    plays: [{ sequence: 1, period: 3, clock: "4:05", teamId: "10", type: "Turnover", description: "Bad pass turnover" }]
  });
  assert.equal(turnover.possession.teamId, "20");

  const steal = buildLiveContext({
    ...base,
    plays: [{ sequence: 1, period: 3, clock: "4:05", teamId: "20", type: "Steal", description: "Steal" }]
  });
  assert.equal(steal.possession.teamId, "20");

  const rebound = buildLiveContext({
    ...base,
    plays: [{ sequence: 1, period: 3, clock: "4:05", teamId: "10", type: "Defensive Rebound", description: "Defensive rebound" }]
  });
  assert.equal(rebound.possession.teamId, "10");
});

test("flags a possible late-game bench rotation only for the leading team after several subs", () => {
  const result = buildLiveContext({
    league: "nba",
    period: 4,
    clock: "2:00",
    homeTeamId: "10",
    awayTeamId: "20",
    homeScore: 101,
    awayScore: 87,
    plays: [
      { sequence: 1, period: 4, clock: "4:40", teamId: "10", teamName: "Home", type: "Substitution", description: "Substitution: Bench Guard A for Starter Guard A" },
      { sequence: 2, period: 4, clock: "4:05", teamId: "10", teamName: "Home", type: "Substitution", description: "Substitution: Bench Wing B for Starter Wing B" },
      { sequence: 3, period: 4, clock: "3:20", teamId: "10", teamName: "Home", type: "Substitution", description: "Substitution: Bench Forward C for Starter Forward C" }
    ]
  });
  assert.equal(result.benchRotationLikely, true);
  assert.equal(result.benchRotationTeamId, "10");
  assert.equal(result.recentSubstitutions.length, 3);
  assert.equal(result.recentSubstitutions[0].playerIn, "Bench Guard A");
  assert.equal(result.recentSubstitutions[0].playerOut, "Starter Guard A");

  const closeGame = buildLiveContext({
    league: "nba",
    period: 4,
    clock: "2:00",
    homeTeamId: "10",
    awayTeamId: "20",
    homeScore: 101,
    awayScore: 97,
    plays: [
      { sequence: 1, period: 4, clock: "4:40", teamId: "10", type: "Substitution", description: "Substitution: Bench Guard A for Starter Guard A" },
      { sequence: 2, period: 4, clock: "4:05", teamId: "10", type: "Substitution", description: "Substitution: Bench Wing B for Starter Wing B" },
      { sequence: 3, period: 4, clock: "3:20", teamId: "10", type: "Substitution", description: "Substitution: Bench Forward C for Starter Forward C" }
    ]
  });
  assert.equal(closeGame.benchRotationLikely, false);
});

test("does not invent possession when the feed has no possession-changing event", () => {
  const result = buildLiveContext({
    league: "ncaa",
    period: 2,
    clock: "8:00",
    homeTeamId: "10",
    awayTeamId: "20",
    plays: [{ sequence: 1, period: 2, clock: "8:05", teamId: "10", type: "Foul", description: "Personal foul" }]
  });
  assert.equal(result.possession.teamId, null);
  assert.equal(result.possession.confidence, "unknown");
});
