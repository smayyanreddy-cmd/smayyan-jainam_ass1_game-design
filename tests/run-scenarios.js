// Headless checks of the game rules, the zone geometry and the trip recorder.
// Usage: node tests/run-scenarios.js
'use strict';
const assert = require('assert');
global.window = globalThis;
window.turf = require('../vendor/turf/turf.min.js');
window.Rules = require('../js/rules.js');
require('../js/world.js');
require('../js/sim.js');
const R = window.Rules, W = window.World, Sim = window.Sim, T = window.turf, Geo = W.Geo;

// ---- Pure rule checks
assert.deepStrictEqual([1, 2, 3, 4, 5, 9].map(R.inactivityPenalty), [5, 10, 20, 40, 50, 50]);
assert.strictEqual(R.intensity('walk', { kmh: 4.5, grade: 0 }), 1.0);
assert.strictEqual(R.intensity('walk', { kmh: 6, grade: 0 }), 1.3);
assert.strictEqual(R.intensity('walk', { kmh: 4, grade: 0.06 }), 1.5);
assert.strictEqual(R.intensity('cycle', { kmh: 18, grade: 0 }), 0.4);
assert.strictEqual(R.intensity('cycle', { kmh: 22, sustainedKmh: 21, grade: 0 }), 0.5);
assert.strictEqual(R.streakMult(15), 1.2);
assert.strictEqual(R.groupMult(7), 1.5);
assert.strictEqual(R.zoneMaxHp(20000), 70);
assert.strictEqual(R.claimPoints(20000), 40);
assert.deepStrictEqual([0, 1, 2, 3, 5, 6].map((d) => R.decayTotal(100, d)), [0, 0, 10, 20, 50, 70]);
console.log(`fairness  30-min walk ${R.segmentDamage(2.9, 1.3, 0, 1).toFixed(0)} vs 30-min ride ${R.segmentDamage(9, 0.4, 0, 1).toFixed(0)}`);

// ---- Geometry helpers (FLAME University area, but any place works)
const O = { lat: 18.5236, lng: 73.7307 };
Geo.setOrigin(O);
const ll = (x, y) => Geo.toLL(x, y);
const arc = (cx, cy, r, a0, a1, n) => Array.from({ length: n + 1 }, (_, k) => { const a = a0 + (a1 - a0) * k / n; return ll(cx + r * Math.cos(a), cy + r * Math.sin(a)); });
const rect = (x0, y0, x1, y1) => [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1), ll(x0, y0 + 1)];
const today = W.dayIndex();
const profile = W.newProfile({ name: 'Me', color: 'cyan' });
const zoneFrom = (pts, owner, name, extra) => ({ id: name, ...W.makeZone(W.tripShape(pts), owner, { name, color: 'red' }, name, today), ...extra });

// Semicircle (open arc): the gap is closed with a straight line and filled.
const semi = W.tripShape(arc(0, 0, 100, 0, Math.PI, 60));
const semiArea = T.area(semi), semiExpected = Math.PI * 100 * 100 / 2;
console.log(`semicircle  area ${semiArea.toFixed(0)} m² (expected ≈ ${semiExpected.toFixed(0)})`);
assert.ok(Math.abs(semiArea - semiExpected) / semiExpected < 0.03, 'semicircle filled');

// Full loop back to the start.
const loop = W.tripShape(arc(0, 0, 80, 0, 2 * Math.PI, 80));
assert.ok(Math.abs(T.area(loop) - Math.PI * 6400) / (Math.PI * 6400) < 0.03, 'circle loop');

// Figure-eight: both lobes are claimed.
const fig8 = [ll(0, 0), ll(100, 100), ll(100, 0), ll(0, 100), ll(0, 1)];
const f8 = W.tripShape(fig8);
assert.ok(f8 && Math.abs(T.area(f8) - 5000) < 300, 'figure-eight lobes: ' + (f8 && T.area(f8)));

// Out-and-back along one road encloses nothing.
assert.strictEqual(W.planClaim([], [ll(0, 0), ll(300, 2), ll(0, 3)], 'me', today).reason, 'small');

// Claim over a rival zone with HP: cut around it.
const rival = zoneFrom(rect(40, -50, 140, 50), 'vex', 'Vex Yards');
const plan = W.planClaim([rival], rect(0, -100, 200, 100), 'me', today);
console.log(`cut-around  claimed ${plan.areaM2.toFixed(0)} m² of 40000 (rival holds 10000)`);
assert.ok(plan.shape && Math.abs(plan.areaM2 - 30000) < 600 && plan.protectedNames[0] === 'Vex Yards', 'rival protected');

// A rival zone broken by decay is free ground.
const stale = { ...rival, ownerActiveDay: today - 40 };
assert.ok(W.effHp(stale) <= 0);
const plan2 = W.planClaim([stale], rect(0, -100, 200, 100), 'me', today);
assert.ok(plan2.dead.length === 1 && Math.abs(plan2.areaM2 - 40000) < 600, 'decayed zone taken');

// Your own touching zone merges into the new one.
const mine = zoneFrom(rect(150, -50, 300, 50), 'me', 'Turf #1');
const plan3 = W.planClaim([mine], rect(0, -100, 200, 100), 'me', today);
assert.ok(plan3.merged.length === 1 && plan3.shape.geometry.type === 'Polygon', 'own zones merge');
assert.ok(Math.abs(plan3.newAreaM2 - 35000) < 600, 'new area excludes what you already owned');

// Point-in-zone
assert.strictEqual(W.zoneAt([rival], ...ll(90, 0)).name, 'Vex Yards');
assert.strictEqual(W.zoneAt([rival], ...ll(0, 0)), null);

// ---- Recorder with noisy live GPS on a 4-minute ride around a 150 m-radius loop
function liveRide({ kmh, jitter, noisyAcc, laps, hooks, declared }) {
  Geo.setOrigin(O);
  const evs = [];
  const rec = Sim.createRecorder({ declared: declared || 'auto', streak: 0, group: () => 1 }, { ...hooks, emit: (e) => evs.push(e) });
  const live = Sim.createLiveSource({ onSample: (s) => rec.push(s) });
  const r = 150, mps = kmh / 3.6, total = Math.round(2 * Math.PI * r * (laps || 1) / mps);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  for (let t = 0; t <= total; t++) {
    const a = (t * mps) / r;
    const [lat, lng] = ll(r * Math.cos(a) + rnd() * jitter, r * Math.sin(a) + rnd() * jitter);
    live.feed({ coords: { latitude: lat, longitude: lng, accuracy: noisyAcc || 6, altitude: null, heading: null, speed: null }, timestamp: t * 1000 });
  }
  return { rec, evs };
}
const ride = liveRide({ kmh: 18, jitter: 4, laps: 1, hooks: { zoneAt: () => null } });
const rideShape = W.tripShape(ride.rec.track);
console.log(`live ride  ${(ride.rec.dist / 1000).toFixed(2)} km (true ${(2 * Math.PI * 150 / 1000).toFixed(2)}) · mode ${ride.rec.mode} · zone ${T.area(rideShape).toFixed(0)} m² (true ${(Math.PI * 150 * 150).toFixed(0)}) · flags ${ride.rec.flags.length}`);
assert.strictEqual(ride.rec.mode, 'cycle');
assert.ok(Math.abs(ride.rec.dist / (2 * Math.PI * 150) - 1) < 0.06, 'Kalman keeps distance honest under 4 m jitter');
assert.ok(Math.abs(T.area(rideShape) / (Math.PI * 22500) - 1) < 0.05, 'zone matches the ridden loop');
assert.ok(ride.evs.some((e) => e.type === 'nearStart'), 'back-at-start hint');
assert.strictEqual(ride.rec.flags.length, 0);

// A slow walk with ±8 m fixes still measures true distance (the hold doesn't eat it).
const walk = liveRide({ kmh: 4.5, jitter: 3, noisyAcc: 8, hooks: { zoneAt: () => null } });
console.log(`live walk  ${(walk.rec.dist / 1000).toFixed(3)} km (true ${(2 * Math.PI * 150 / 1000).toFixed(3)}) · mode ${walk.rec.mode}`);
assert.ok(walk.rec.mode === 'walk' && Math.abs(walk.rec.dist / (2 * Math.PI * 150) - 1) < 0.08, 'walk distance');

// Standing still with jitter adds (almost) no distance.
Geo.setOrigin(O);
const still = Sim.createRecorder({ declared: 'walk' }, { zoneAt: () => null });
const stillSrc = Sim.createLiveSource({ onSample: (s) => still.push(s) });
let sd = 3; const rn = () => ((sd = (sd * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
for (let t = 0; t < 120; t++) { const [lat, lng] = ll(rn() * 5, rn() * 5); stillSrc.feed({ coords: { latitude: lat, longitude: lng, accuracy: 8, altitude: null }, timestamp: t * 1000 }); }
console.log(`standing still 2 min  ${still.dist.toFixed(1)} m recorded`);
assert.ok(still.dist < 25, 'jitter while standing still is held');

// Fixes worse than ±30 m are ignored.
const fuzzy = liveRide({ kmh: 15, jitter: 0, noisyAcc: 60, hooks: { zoneAt: () => null } });
assert.strictEqual(fuzzy.rec.samples.length, 0, 'inaccurate fixes are not recorded');

// Riding through a rival zone damages and breaks it; a car-speed "walk" is flagged.
const target = { id: 'z9', owner: 'vex', name: 'Vex Loop', maxHp: 60, hp: 30, ownerActiveDay: today };
let hp = target.hp;
const raid = liveRide({ kmh: 18, jitter: 2, hooks: {
  zoneAt: () => (hp > 0 ? { zone: target, mine: false } : null),
  hit: (z, d) => { hp -= d; return { broken: hp <= 0 }; },
} });
assert.deepStrictEqual(raid.rec.broken, ['Vex Loop'], 'zone broken');
assert.ok(raid.rec.zoneDamage >= 30);
const car = liveRide({ kmh: 30, jitter: 1, declared: 'walk', hooks: { zoneAt: () => null } });
assert.ok(car.rec.flags.some((f) => f.kind === 'speed') && car.rec.damage < 20, 'car-speed walk flagged');

// ---- Real-calendar day cycle
const p = W.newProfile({ name: 'P' });
p.stats.totalPoints = 500;
const d0 = p.lastTickDay;
const rep = W.tickDays(p, d0 + 6); // 6 days away, nothing done
console.log('\n6 idle days  penalty', rep.penalty, 'missed', rep.missed);
assert.strictEqual(rep.penalty, 5 + 10 + 20 + 40 + 50 + 50);
const q = W.newProfile({ name: 'Q' });
const met = W.addDailyProgress(q, 16, 0);
assert.ok(met.justMet && q.stats.streak === 1);
assert.strictEqual(W.tickDays(q, q.today.day + 1).penalty, 0, 'met day: no penalty');
assert.strictEqual(W.useRestToken(q), '');
assert.strictEqual(W.tickDays(q, q.today.day + 1).penalty, 0, 'rest token covers the day');
assert.strictEqual(q.stats.streak, 1, 'rest token keeps the streak');
assert.ok(W.useRestToken(q).length > 0 || q.stats.restTokens === 0, 'one token per week');

// Decay: owner inactive 2+ days -> decaying, takes extra damage.
const z = { maxHp: 100, hp: 100, ownerActiveDay: today - 3 };
assert.ok(W.isDecaying(z, today) && W.effHp(z, today) === 90);
console.log('\nAll checks passed ✓');
