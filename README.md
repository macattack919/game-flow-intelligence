# Game Flow Intelligence

A separate starter application built from the uploaded No Small Fish / Race-to-75 project.

## Features in this first milestone
- NBA and NCAA Men's tabs
- ESPN scoreboard feed for each league
- Live game clock, scores, and game status
- Live play-by-play scoring events when ESPN supplies them
- Baseline pace projection for full-game and team totals
- Basic recent scoring-flow indicators
- 30-second refresh

## Deploy
Deploy this folder as a separate Vercel project. The API is served by `api/scores.js` and accepts `?league=nba` or `?league=ncaa`. No sportsbook integration or trained probability model is included yet.

## Important model note
The pace and margin values are descriptive baselines, not calibrated probabilities or betting recommendations. Market-line comparison, team-strength priors, possession estimates, historical backtesting, and model calibration are later milestones.
