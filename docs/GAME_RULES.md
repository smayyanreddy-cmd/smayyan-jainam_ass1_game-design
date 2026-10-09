# PedalPace: Game Rules

*Working title. Version 1.0 of the rules, matching the prototype in this repo.*

PedalPace turns real walks and rides into a territory game. Your GPS route is drawn on the real map. **Close a loop** to claim the area inside. **Move through a rival's area** to damage it. Break it to 0 HP and it turns neutral, ready to be claimed.

Every number below is defined once in [`js/rules.js`](../js/rules.js). The prototype and this document use the same values.

---

## 1. Core concepts

| Term | Meaning |
|---|---|
| **Cell** | The smallest unit of territory: a 66 m × 66 m square (≈ 0.0044 km²) on a fixed city grid. |
| **Zone** | A group of cells claimed together by one loop. Zones have an owner, a name and a health bar (HP). |
| **Neutral cell** | A cell that used to be owned, but its zone was broken (by damage or decay). Anyone can claim it. |
| **Never-owned cell** | A cell nobody has ever claimed. Claiming one gives the biggest claim bonus. |
| **Friendly zone** | A zone owned by you or a clan mate. |
| **Enemy zone** | A zone owned by anyone else. |

---

## 2. Positive points: damage

**Points earned = damage dealt.** You earn damage on every valid metre you move, wherever you are. *Where* you are only decides what that damage does: it hurts an enemy zone, heals a friendly one, or simply scores points.

### 2.1 Damage per GPS segment

```
D = d_km × 100 × M × S × G × C
```

| Symbol | Name | Value |
|---|---|---|
| `d_km` | Distance of the segment | km |
| `100` | Damage per km at 1.0× | constant |
| `M` | Intensity multiplier | §2.2 |
| `S` | Streak multiplier | `1 + min(0.20, 0.02 × streakDays)`: +2 % per consecutive active day, max +20 % |
| `G` | Group combo | 1 player 1.0 · 2 players **1.2** · 3 players **1.35** · 4+ players **1.5** |
| `C` | Context | **1.25** when moving through a *damaged* friendly zone (defending), otherwise 1.0 |

### 2.2 Intensity multiplier `M`

Intensity is scaled per activity, so walkers and cyclists are on equal footing.

**Walking** (use the highest tier that applies):

| Condition | M |
|---|---|
| Base | **1.0** |
| Brisk: speed ≥ 5.5 km/h **or** heart rate in zone 3+ | **1.3** |
| Uphill: grade ≥ 4 % | **1.5** |

**Cycling** (base plus bonuses, capped at 0.80):

| Component | Value |
|---|---|
| Base (cycling covers more ground per minute) | **0.40** per km |
| Sustained-effort bonus, *with* HR monitor: HR zone held ≥ 120 s: Z3 / Z4 / Z5 | +0.10 / +0.20 / +0.25 |
| Sustained-effort bonus, *without* HR: speed held ≥ 120 s: ≥ 20 km/h / ≥ 26 km/h | +0.10 / +0.20 |
| Uphill (grade ≥ 4 %) | +0.15 |
| **Cap** | **0.80** |

HR zones are a percentage of max HR (default 190 bpm): Z1 < 60 %, Z2 60 to 70 %, Z3 70 to 80 %, Z4 80 to 90 %, Z5 ≥ 90 %.
Grade is measured over the last ~10 s of movement.

### 2.3 Balance check: equal time, roughly equal damage

| 30-minute activity | Distance | M | Damage |
|---|---|---|---|
| Easy walk, 4.5 km/h | 2.25 km | 1.0 | **225** |
| Brisk walk, 5.8 km/h | 2.9 km | 1.3 | **377** |
| Steady ride, 18 km/h | 9 km | 0.4 | **360** |
| Hard ride, 22 km/h, HR Z4 | 11 km | 0.6 | **660** |
| Hilly brisk walk (⅓ uphill) | 2.7 km | ≈1.37 | **≈370** |

Walking gets intensity tiers and cycling gets a low base, so a brisk walker and a steady cyclist earn about the same per minute. Riding faster still pays a little more, but cycling is capped at 0.8×, so it can never go past 2× the base rate.

### 2.4 What damage does to zones

| Where you are | Effect on the zone | Points |
|---|---|---|
| Enemy zone | Zone loses `D` HP (**× 1.25** if its owner has been inactive ≥ 2 days: *vulnerable*) | `D` |
| Friendly zone below max HP | Zone **heals** by `D` HP (up to max) | `D` (includes the ×1.25 defend bonus) |
| Friendly zone at full HP | None (patrolling) | `D` |
| Neutral / never-owned ground | None | `D` |

**Zone HP:** `maxHP = 40 + 6 × cells`. A 49-cell (≈0.21 km²) zone has 334 HP.

When an enemy zone hits **0 HP** it **breaks**: all its cells become neutral and you get **+50 points**.

### 2.5 Claiming (closing a loop)

* A loop closes when your current position comes within **25 m** of a point you passed at least **250 m** of travel earlier (in this activity, since your last loop).
* Everything the loop encloses is captured. Odd shapes, figure-eights and laps all work. The loop must enclose at least 2 interior cells.
* What happens to each enclosed cell:

| Cell | Result | Bonus |
|---|---|---|
| Never-owned | Becomes yours | **+5 pts / cell** |
| Neutral | Becomes yours | **+3 pts / cell** |
| Friendly | That zone is restored to full HP (*reinforced*) | — |
| Enemy (HP > 0) | **Protected**, can't be claimed. Break the zone first. | — |

* Newly claimed cells form a new zone at full HP.

### 2.6 Total points for an activity

```
Points = Σ D  +  claim bonuses  +  50 × zones broken
```

---

## 3. Negative points: inactivity

### 3.1 Daily minimum

A day counts as **active** when:

```
walk_minutes / 15  +  cycle_km / 5  ≥ 1
```

So 15 min of walking **or** 5 km of cycling **or** any mix (e.g. 8 min walking + 2.5 km riding). Meeting it:

* adds 1 to your **streak**,
* resets your missed-day counter,
* stops your zones decaying.

### 3.2 Missed-day penalty

For the *n*-th consecutive missed day:

```
P(n) = min(50, 5 × 2^(n−1))
```

| Missed day | 1 | 2 | 3 | 4 | 5+ |
|---|---|---|---|---|---|
| Penalty | −5 | −10 | −20 | −40 | **−50 (cap)** |

* A missed day also resets your streak to 0.
* Total points never go below 0.
* **The penalty is never harsher than this.** There is no extra punishment, and no bonus for doing more than one activity per day, beyond normal damage.

### 3.3 Rest tokens

* **1 rest token per week** (refilled every 7 days, no carry-over).
* Using one on an inactive day means **no penalty** and **streak kept**. Your missed-day and inactive-day counters don't advance, so decay doesn't get worse.
* This exists so recovery days aren't punished. Rest is part of training.

### 3.4 Territory decay

Zones whose owner has been inactive lose HP every night:

| Owner inactive for | Overnight decay |
|---|---|
| 0 to 1 days | none |
| 2 to 4 days | −10 % of max HP |
| 5+ days | −20 % of max HP |

Decaying zones also take **×1.25 damage** from attackers (§2.4). A zone that decays to 0 HP becomes neutral.

---

## 4. Anti-cheat

The recorder checks every 1 Hz GPS fix. Flagged distance earns **no damage, no daily-minimum credit, and can't be part of a claim loop**. The loop restarts after a flagged segment.

| Check | Rule | Example |
|---|---|---|
| **GPS jump** | > 80 m between consecutive 1-second fixes (≈ 290 km/h) | Teleport across town: the segment is ignored |
| **Mode mismatch** | Mode is *walking* and the 5-second smoothed speed is > 10 km/h | "Walking" at 25 km/h |
| **Car-speed segment** | Smoothed speed is > 45 km/h in any mode | Riding in a car or bus |

* Damage stops on the **first** over-limit sample. A visible flag ("Anti-cheat: …") appears once the speed has been over the limit for **8 s**, so a GPS spike doesn't trigger a warning.
* The summary lists every flag and the kilometres excluded.

### Mode detection

* **Auto (default):** smoothed speed < 7.5 km/h means walking and > 9.5 km/h means cycling. Between the two, the previous mode is kept, so it doesn't flicker at junctions.
* **Manual override:** the player can lock Walk or Cycle. The lock is then enforced by the mode-mismatch check.

---

## 5. Clans

* Clan mates' zones are **friendly**. Moving through them heals them (with the ×1.25 defend bonus) instead of damaging them.
* Loops that enclose a clan mate's zone reinforce it to full HP.
* Moving together gives the **group combo** `G` (×1.2 / ×1.35 / ×1.5).
* Clan leaderboards add up members' points, weekly damage and territory.

---

## 6. Leaderboards & profile

| Board | Ranked by |
|---|---|
| Friends | Total points among people you follow |
| City | Total points, all players in the city |
| Weekly damage | Damage dealt since the weekly reset (every 7 days) |
| Biggest territory | km² currently held |
| Clans | Combined clan points |

**Profile stats:** total points, damage dealt, points lost to inactivity, current and best streak, territory (km²), rest tokens, badges.

### Badges

| Badge | Unlock |
|---|---|
| 🚩 Flag Planter | Claim your first area |
| ⚔️ Raider | Break an enemy zone |
| 🛡️ Defender | Heal a damaged zone |
| 🧭 Explorer | Claim 50 never-owned cells in total |
| 👥 Squad Goals | Finish a group activity |
| ✅ Fair Play | Finish an activity with no anti-cheat flags |
| 🔥 On a Roll | 3-day streak |
| 🏆 Week Warrior | 7-day streak |
| 😴 Smart Recovery | Use a rest token |

---

## 7. Notifications

| Trigger | Message |
|---|---|
| A rival damages your zone | "Your territory is under attack! Kai hit Home Turf for 42 HP." |
| You've been inactive ≥ 2 days | "Your zones are decaying (−67 HP overnight). A 15-min walk or 5 km ride stops it." |
| A zone of yours hits 0 HP | "You lost Turf #2. It is now neutral and anyone can claim it." |
| Each morning | "Keep your 3-day streak 🔥 15 min walking or 5 km cycling today." |
| Missed day | "Missed day: −10 pts. Tomorrow's penalty would be −20." |

---

## 8. Design rationale (wellbeing guard-rails)

* **Low bar to stay safe.** 15 minutes of walking is enough. The game rewards consistency, not volume.
* **Capped downside.** The worst possible day costs 50 points. That is about what a 7-minute walk earns, and one normal walk wins it back.
* **Streak bonus caps at 10 days (+20 %),** so there's no growing pressure to never take a day off.
* **Rest token keeps the streak**, so recovery doesn't feel like losing.
* **No bonus for multiple activities per day**, so there's no incentive to double up.
* **Anti-cheat protects fairness** without punishing players: flagged distance is simply not counted, and there are no point deductions.
