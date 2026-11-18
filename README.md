# Game Flow Intelligence

A separate basketball analytics application focused on live game totals for NBA and NCAA Men's games. Race to 80 remains a separate project.

## Current features
- NBA and NCAA Men's scoreboard tabs
- ESPN scoreboard feed with game clocks and statuses
- Live play-by-play scoring events and team statistics when ESPN supplies them
- 30-second scoreboard refresh
- Possession-and-efficiency live total projection when the required box-score fields are available
- A score-and-clock fallback after five minutes when the required possession fields are missing
- Early-game regression toward league pace and points-per-possession baselines
- Model sample and method shown on each live game card
- ESPN Core API odds lookup for entries explicitly labeled "Live Odds"
- Live-total comparison only when ESPN explicitly identifies an in-game line; opening, closing, or ordinary current pregame lines are never displayed as live totals
- Overtime-aware clock handling; the current projection only covers the end of the current overtime period and does not add hypothetical future overtimes
- Built-in Node tests for possession extraction, projection, fallback, and overtime

## Live total model v1

The possession estimate is:

`Possessions ≈ FGA + 0.44 × FTA − offensive rebounds + turnovers`

The game possession estimate averages the two teams' possession estimates. Remaining possessions are projected using an early-game pace blend with a league-level prior. Each team's observed points per possession is regressed toward a league-level scoring-efficiency prior using 18 pseudo-possessions.

Initial settings:
- NBA pace prior: 99.0 possessions per 48 minutes
- NCAA men's pace prior: 67.5 possessions per 40 minutes
- NBA efficiency prior: 1.143 points per possession
- NCAA men's efficiency prior: 1.09 points per possession
- Pace prior weight: six minutes
- Efficiency prior weight: 18 possessions

These are starting assumptions, not optimized or validated model parameters. The model is a transparent live estimate, not a calibrated probability model or a betting recommendation.

## Important limitations
- ESPN's live odds availability is inconsistent. The live-total field is unavailable when no explicitly labeled in-game line is returned.
- The possession model relies on ESPN exposing FGA, FTA, offensive rebounds, and turnovers in team box-score statistics. If any required field is missing, the app uses a simple score-and-clock fallback after five minutes.
- This first version does not yet use pregame team strength, player availability, foul trouble, shot-quality data, lineup data, or opponent-adjusted ratings.
- No historical model backtest has been completed. The displayed sample label reflects the amount of in-game data, not a calibrated confidence probability.
- No paid odds feed or sportsbook API key is required.
- The app does not place bets.

## Tests

Run locally with Node.js:

`npm test`

## Deploy

Deploy this folder as a separate Vercel project. The API is served by `api/scores.js` and accepts `?league=nba` or `?league=ncaa`.

## Next development milestones
- Verify the ESPN team-stat field names against live game responses.
- Collect timestamped model predictions and final scores for error analysis.
- Backtest the pace and efficiency prior settings separately for NBA and NCAA Men's.
- Refine the model using team season ratings and game situation inputs.
- Add Watch / Qualified / Expired states only after thresholds are validated against logged results.
