# PedalPace *(working title)*

A mobile-first fitness game that turns real walks and rides into a territory-and-combat game, inspired by territory-capture running apps, built for **walkers and cyclists**.

* **Close a loop:** claim the area inside, in your colour.
* **Move through a rival's zone:** deal damage. At 0 HP it turns neutral, then claim it.
* **Damage = distance × intensity**, balanced so walkers and cyclists compete fairly.
* **Inactivity costs points** (−5 → −50/day cap) and makes your zones decay. A 15-minute walk, or a weekly rest token, keeps you safe.

## Deliverables

| Deliverable | Where |
|---|---|
| Game rules with exact scoring formulas | [docs/GAME_RULES.md](docs/GAME_RULES.md) |
| Screen list & user flow | [docs/SCREENS_AND_FLOW.md](docs/SCREENS_AND_FLOW.md) |
| Interactive web prototype with simulated GPS | `index.html` (this folder) |

## Running the prototype

1. Open **`index.html`** in Chrome, Edge, Firefox or Safari. Double-clicking works, and no server or build step is needed.
2. An internet connection is needed only for the map tiles. Everything else (including Leaflet, in `vendor/`) is local. Without internet, the territory still draws on a plain background.
3. For the phone experience on a desktop, the app renders inside a phone-sized frame. You can also use DevTools device mode.

Progress is saved in `localStorage`. **Profile → Reset prototype** starts over.

### Suggested test run (≈5 minutes)

1. Go through onboarding and pick a name, colour and clan.
2. **GO → Defend patrol** (×20). Watch Home Turf's HP bar refill and the loop *reinforce* it.
3. **GO → Raid ride** (×60). Laps inside Vex's decaying zone break it (*ZONE BROKEN!*), then the outer loop claims the whole block.
4. **GO → First claim walk.** Brisk pace plus the 1.5× uphill bonus on the park hill, and a big never-owned claim.
5. **GO → Cheat test.** A "walk" that includes a 28 km/h car ride and an 800 m GPS jump. Watch the anti-cheat banner, the red dashed track and the excluded km in the summary.
6. **GO → Clan walk with Mira.** Group combo ×1.2.
7. **Profile → Time machine:** *Skip day* a few times. Watch the penalties (−5, −10, −20…), decay notifications and rival attacks. Then try *Use rest token*.
8. Tap **☀** for sunlight mode, and check **Ranks** and **Clan**.
9. **GO → Draw your own route:** tap waypoints anywhere and set the speed. Try 25 km/h with mode locked to *Walk*.

## Automated checks

```
node tests/run-scenarios.js
```

This runs every simulated route through the real recorder (with and without the HR monitor). It checks the penalty ladder, intensity tiers, claims, zone breaking, healing, group combo, anti-cheat, decay and rest tokens.

## Project structure

```
index.html            app shell (all screens)
css/style.css         neon + sunlight themes, mobile-first layout
js/rules.js           every scoring constant & formula (mirrors GAME_RULES.md)
js/world.js           city grid, zones, seed data, loop claiming, day/decay cycle, leaderboards
js/sim.js             simulated GPS routes + activity recorder (mode detection, anti-cheat, damage, loops)
js/app.js             UI: map rendering, HUD, screens, notifications
tests/                headless scenario tests (Node)
vendor/leaflet/       Leaflet 1.9.4 (BSD-2-Clause)
docs/                 rules + screens/flow
```

## Credits

Map data © OpenStreetMap contributors. Basemap tiles © Esri (Canvas). Map library: Leaflet.
The city setting (Chicago, West Town) is a generic grid city for the prototype. All players other than you are fictional bots.
