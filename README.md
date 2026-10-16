# PedalPace *(working title)*

A mobile-first fitness game that turns real walks and rides into a territory-and-combat game, inspired by territory-capture running apps, built for **walkers and cyclists**.

* **Go on a trip:** your real GPS route is drawn on the map behind you, including campus inner roads and footpaths (nothing is snapped to main roads).
* **End the trip:** the route is closed with a straight line back to your start and the whole shape becomes your zone. A full loop claims the loop; a semicircle claims the filled semicircle.
* **Move through someone else's zone:** deal damage. At 0 HP it breaks, and its ground is free to claim.
* **Damage = distance × intensity**, balanced so walkers and cyclists compete fairly.
* **Play with friends:** add them by code and see their zones and live positions. Trip together for a combo bonus.
* **Inactivity costs points** (−5 → −50/day cap) and makes your zones decay. A 15-minute walk, or a weekly rest token, keeps you safe.

## Deliverables

| Deliverable | Where |
|---|---|
| Game rules with exact scoring formulas | [docs/GAME_RULES.md](docs/GAME_RULES.md) |
| Screen list & user flow | [docs/SCREENS_AND_FLOW.md](docs/SCREENS_AND_FLOW.md) |
| Interactive web app: live GPS, satellite map, real-shape zones, friends | `index.html` (this folder) |
| Online multiplayer setup (Firebase, free) | [docs/SETUP_FIREBASE.md](docs/SETUP_FIREBASE.md) |

## Running it

```
node serve.js        # then open http://localhost:5173
```

Needs Node; there's nothing to install. Open it in any modern browser (Chrome, Edge, Opera GX, Firefox, Safari).

* **Offline mode (default):** works straight away. You play single player and progress is saved on this device.
* **Online mode:** add a free Firebase config to [`js/config.js`](js/config.js) ([docs/SETUP_FIREBASE.md](docs/SETUP_FIREBASE.md)). This turns on Google or guest sign-in, friends, shared zones, live positions and notifications.
* **On a phone:** GPS needs `https://`. Publish with GitHub Pages (see the setup doc) and open that link. Laptops locate by Wi-Fi and are usually too rough (±50 m+) to record. For testing at a desk, use **GO → Test: draw a route and simulate it** (shown on `localhost` or with `?test` in the URL).

### The map

* It starts wherever you are: the browser asks for your location.
* There are three map types (the layers button): **Satellite** (Esri World Imagery with road and place labels, sharp enough for campus paths), **Map** (OpenStreetMap, which includes campus inner roads and buildings) and **Dark**. None of them needs an API key.
* It looks and works like Google Maps: a blue dot with an accuracy circle and heading, re-centre, pinch zoom. Tap a zone for its details.

### A trip

1. **GO → Start trip.** Pick Auto, Walk or Cycle. The sheet shows your GPS accuracy.
2. Walk or ride. Your trail is drawn in your colour. A dotted line runs from you back to your start 🏁, and a light fill shows the zone you'd get if you ended now.
3. **End trip → End & claim.** The shape is saved as your zone. The newest claim wins: any part of another player's zone inside it becomes yours and their zone shrinks. Your own zones it touches merge into it.

GPS handling: fixes worse than ±30 m are dropped. A Kalman filter smooths jitter, standing still doesn't add distance, and the screen stays awake while recording. Keep the app open in the foreground: browsers pause GPS for background tabs.

## Automated checks

```
node tests/run-scenarios.js
```

This checks the scoring rules and the zone geometry: semicircles filled by the closing line, loops, figure-eights, cutting around rival zones, merging, and decay. It also feeds noisy GPS into the real recorder to check distance accuracy, jitter while standing still, poor fixes, zone breaking, anti-cheat, the real-calendar penalties and rest tokens.

## Project structure

```
index.html            app shell (all screens)
css/style.css         neon + sunlight themes, mobile-first layout
js/rules.js           every scoring constant & formula (mirrors GAME_RULES.md)
js/world.js           geometry, trip → zone shape, claim planning, profile, real-calendar day cycle
js/sim.js             live GPS filter (Kalman), test-route simulator, trip recorder (mode, anti-cheat, damage)
js/store.js           data layer: Firebase (online) or this device (offline)
js/app.js             UI: map, location, trips, friends, ranks, profile, onboarding
js/config.js          your Firebase web config (empty = offline mode)
firestore.rules       database security rules (paste into Firebase)
serve.js              zero-dependency local server (http://localhost:5173)
tests/                headless rule, geometry and recorder checks (Node)
vendor/leaflet/       Leaflet 1.9.4 (BSD-2-Clause)
vendor/turf/          Turf.js 7.1.0 geometry (MIT)
docs/                 rules, screens/flow, Firebase setup
```

## Credits

Map data © OpenStreetMap contributors. Satellite imagery © Esri, Maxar, Earthstar Geographics; dark basemap © Esri. Map library: Leaflet. Geometry: Turf.js. Backend: Firebase.
