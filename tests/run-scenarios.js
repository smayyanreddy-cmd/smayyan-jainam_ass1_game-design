// Headless check of the game loop: runs every simulated route through the real
// recorder and asserts the core rules. Usage: node tests/run-scenarios.js
'use strict';
const assert = require('assert');
global.window = globalThis;
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
require('../js/rules.js');
window.Rules = require('../js/rules.js');
require('../js/world.js');
require('../js/sim.js');
const R = window.Rules, W = window.World, Sim = window.Sim;

// ---- Pure rule checks
assert.deepStrictEqual([1, 2, 3, 4, 5, 9].map(R.inactivityPenalty), [5, 10, 20, 40, 50, 50]);
assert.strictEqual(R.intensity('walk', { kmh: 4.5, grade: 0 }), 1.0);
assert.strictEqual(R.intensity('walk', { kmh: 6, grade: 0 }), 1.3);
assert.strictEqual(R.intensity('walk', { kmh: 4, grade: 0.06 }), 1.5);
assert.strictEqual(R.intensity('cycle', { kmh: 18, grade: 0 }), 0.4);
assert.strictEqual(R.intensity('cycle', { kmh: 22, sustainedKmh: 21, grade: 0 }), 0.5);
assert.strictEqual(R.intensity('cycle', { kmh: 22, hasHr: true, sustainedHrZone: 4, grade: 0.05 }), 0.75);
assert.strictEqual(R.streakMult(15), 1.2);
assert.strictEqual(R.groupMult(7), 1.5);
assert.ok(Math.abs(R.segmentDamage(1, 1.3, 0, 1, 'neutral') - 130) < 1e-9);
// Fairness: 30 min brisk walk vs 30 min steady ride, no HR
const walk30 = R.segmentDamage(2.9, 1.3, 0, 1);
const ride30 = R.segmentDamage(9, 0.4, 0, 1);
console.log(`fairness  30-min walk ${walk30.toFixed(0)} vs 30-min ride ${ride30.toFixed(0)}`);

// ---- Scenario runs
function runScenario(id, opts) {
  const s = W.newState();
  const sc = Sim.SCENARIOS.find((x) => x.id === id);
  const events = [];
  const rec = Sim.createRecorder(s, { declared: sc.declared || opts.declared || 'auto', group: sc.group || 1, hr: opts.hr }, (e) => events.push(e));
  const smp = Sim.createSampler(sc, { hr: opts.hr });
  let x; while ((x = smp.next())) rec.push(x);
  const daily = W.addDailyProgress(s, rec.walkSec / 60, rec.cycleKm);
  const out = {
    km: +(rec.dist / 1000).toFixed(2), min: +(rec.time / 60).toFixed(1), mode: rec.mode,
    damage: Math.round(rec.damage), points: Math.round(rec.totalPoints()), claimed: rec.claimedCells,
    virgin: rec.virgin, neutral: rec.neutral, broke: rec.neutralised, healed: Math.round(rec.healed),
    flags: rec.flags.map((f) => f.kind), flaggedKm: +(rec.flaggedDist / 1000).toFixed(2), metMinimum: daily.justMet,
    modeSwitches: events.filter((e) => e.type === 'mode').length,
  };
  console.log(id.padEnd(7), JSON.stringify(out));
  return { s, rec, out };
}

for (const hr of [true, false]) {
  console.log(`\n--- HR monitor: ${hr}`);
  const claim = runScenario('claim', { hr });
  assert.ok(claim.out.claimed >= 30 && claim.out.virgin === claim.out.claimed, 'claim walk claims virgin cells');
  assert.ok(claim.out.metMinimum, 'claim walk meets daily minimum');

  const raid = runScenario('raid', { hr });
  assert.deepStrictEqual(raid.out.broke, ['Vex Yards'], 'raid breaks Vex');
  const vexCells = W.newState().zones.z3.cells;
  assert.ok(vexCells.every((k) => raid.s.cells[k] && raid.s.zones[raid.s.cells[k]].owner === 'you'), 'raid takes every Vex cell');
  assert.strictEqual(raid.out.mode, 'cycle');
  assert.ok(raid.out.metMinimum, 'raid ride (5+ km) meets minimum');

  const def = runScenario('defend', { hr });
  assert.ok(def.out.healed > 0, 'defend heals');
  const home = Object.values(def.s.zones).find((z) => z.name === 'Home Turf');
  assert.strictEqual(home.hp, home.maxHp, 'home turf full after patrol');

  const grp = runScenario('group', { hr });
  assert.ok(grp.rec.parts.group > 0 && grp.out.claimed > 0, 'group combo + claim');

  const cheat = runScenario('cheat', { hr });
  assert.ok(cheat.out.flags.includes('speed') && cheat.out.flags.includes('gps'), 'cheat flagged');
  assert.ok(cheat.out.flaggedKm > 0.9, 'car km excluded');
  assert.ok(cheat.out.damage < 200, 'no car damage');
}

// ---- Inactivity + decay + rest tokens over a simulated fortnight
const s = W.newState();
const log = [];
for (let d = 0; d < 6; d++) log.push(W.endDay(s, false).penalty);
console.log('\npenalties for 6 idle days', log, 'lost', s.stats.pointsLost);
assert.deepStrictEqual(log, [5, 10, 20, 40, 50, 50]);
assert.ok(!Object.values(s.zones).some((z) => z.owner === 'vex'), 'Vex decayed away');
const s2 = W.newState();
const before = s2.stats.streak;
const r = W.endDay(s2, true);
assert.ok(r.tokenUsed && r.penalty === 0 && s2.stats.streak === before, 'rest token: no penalty, streak kept');
assert.strictEqual(W.endDay(s2, true).tokenUsed, false, 'only one token per week');
console.log('\nAll checks passed ✓');
