# Game Flow Intelligence

A separate basketball analytics application focused on live game totals for NBA and NCAA Men's games. Race to 80 remains a separate project.

## Current features
- NBA and NCAA Men's scoreboard tabs
- ESPN scoreboard feed with game clocks and statuses
- Live play-by-play scoring events and team statistics when ESPN supplies them
- 30-second scoreboard refresh
- Simple live scoring-pace projections for combined and team totals
- Overtime-aware pace projection window
- ESPN Core API odds lookup for entries explicitly labeled "Live Odds"
- Live-total comparison only when ESPN explicitly identifies an in-game line; opening, closing, or ordinary current pregame lines are never displayed as live totals
- Projection gap between the scoring-pace estimate and an explicitly identified live total

## Important limitations
- ESPN does not consistently publish in-game totals for current NBA and NCAA games. The live-total field will be unavailable when no explicitly labeled live entry is returned.
- The pace projection is a straight-line extrapolation of scoring to the end of regulation or the current overtime period. It is a baseline, not a calibrated predictive model or a betting recommendation.
- No paid odds feed or sportsbook API key is required.
- The app does not place bets.

## Deploy
Deploy this folder as a separate Vercel project. The API is served by `api/scores.js` and accepts `?league=nba` or `?league=ncaa`.

## Next development milestones
- Validate whether ESPN returns explicit in-game totals during live games.
- Build a stronger total projection using possessions, pace, efficiency, turnovers, rebounds, and free throws.
- Record time-stamped game snapshots and evaluate projection error against final scores.
- Add Watch / Qualified / Expired states only after thresholds are tested and calibrated.
