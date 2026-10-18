# Passé Panic

Multiplayer French passé composé survival game built with Node.js, Express and Socket.IO.

## Run locally

1. Install Node.js 18 or newer.
2. In this folder run `npm install`.
3. Run `npm start` and open `http://localhost:3000` in your browser.

## Checks

- `npm test` checks JavaScript syntax and procedural world placement invariants.
- `npm run test:e2e` runs the Playwright end-to-end browser suite. Install the Playwright browser once with `npx playwright install chromium` if needed.
- `GET /health` returns a small server health response.

## Current gameplay features

- Up to 30 players and seven-minute matches.
- Four edge-to-centre ziplines plus two high-ground access ziplines, all with a ten-second cooldown.
- Four speed relays; zombies reach 225 speed for three seconds when boosting.
- Automatic zombie boosts, a five-second starting freeze, lives/shields, file/crate/computer objectives, score tracking, speed boosts and bandages. Successful zombie attacks award 0.5 points, and hit players are stunned for 0.5 seconds before the existing shield window.
- 4000×4000 procedural four-biome map with varied terrain props (passable rocks, mushrooms, logs and crystals), collidable trees/pines/pillars/bushes/logs/crystals, lakes kept off elevated ground, four elevation areas across two height levels, cliff boundaries, visible ramps, high-ground access ziplines, file stations, minimap, keyboard and mobile joystick controls.
- Expanded lobby avatar customization with 10 body colors, 10 accessories, and 8 accessory colors. Wearables such as halos, horns, crowns, flowers and antennae draw outside the avatar body circle; names containing Layne keep the fixed Layne avatar.
- Room-code links and QR sharing.

Objective and pickup placement uses a validated open-point search with a deterministic scan fallback; it no longer silently falls back to a hard-coded potentially blocked point.
