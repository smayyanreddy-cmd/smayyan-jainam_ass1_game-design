# PedalPace: Game Rules

*Working title. Version 2.0 of the rules (real GPS, real-shape zones, multiplayer), matching the prototype in this repo.*

PedalPace turns real walks and rides into a territory game. Your GPS route is drawn on the real map behind you. **End the trip** and the route is closed with a straight line back to your start: the whole shape becomes your zone. **Move through another player's zone** to damage it. Break it to 0 HP and its ground is free to claim.

Every number below is defined once in [`js/rules.js`](../js/rules.js). The prototype and this document use the same values.

---

## 1. Core concepts

| Term | Meaning |
|---|---|
| **Trip** | One recorded walk or ride, from *Start trip* to *End trip*. |
| **Zone** | The area one trip enclosed, in its exact shape. Zones have an owner, a name and a health bar (HP). |
| **Free ground** | Any ground not inside a standing zone: never claimed, or the zone there was broken. |
| **Your zone** | A zone you own. Moving through it heals it. |
| **Rival zone** | A zone owned by anyone else, friends included. Moving through it damages it. |

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
| Rival zone | Zone loses `D` HP (**× 1.25** if its owner has been inactive ≥ 2 days: *vulnerable*) | `D` |
| Your zone below max HP | Zone **heals** by `D` HP (up to max) | `D` (includes the ×1.25 defend bonus) |
| Your zone at full HP | None (patrolling) | `D` |
| Free ground | None | `D` |

**Zone HP:** `maxHP = 40 + 1.5 × area / 1,000 m²`. A 20,000 m² zone has 70 HP; a 0.2 km² zone has 340 HP.

When a rival zone hits **0 HP** it **breaks**: it disappears, its ground is free, and you get **+50 points**. Damage is applied live, so the owner sees their HP bar drop while you ride.

### 2.5 Claiming (ending a trip)

* Tap **End trip**. The app joins your **end point back to your start point with a straight line** and fills the shape.
  * Come back to where you started and you claim the exact loop you rode.
  * Ride an open arc (e.g. a semicircle) and the gap is closed with a straight line, so you claim the filled semicircle.
  * Figure-eights and laps work: every enclosed lobe is claimed.
* While recording, the map shows a dotted line from you back to your start 🏁 and a light fill of the zone you'd get if you ended now. When you're back within **30 m** of your start (after at least **250 m**), the app tells you so.
* What happens to the enclosed ground:

| Ground | Result | Bonus |
|---|---|---|
| Free ground | Becomes yours | **+2 pts per 1,000 m²** |
| Ground of a rival zone broken by decay | Becomes yours (the old zone is removed) | **+2 pts per 1,000 m²** |
| Your own zone it touches | Merged into the new zone, which starts at full HP (*reinforced*) | none for ground you already held |
| Rival zone with HP > 0 | **Protected**: the new zone is cut around it. Break it first. | none |

* A claim smaller than **500 m²** doesn't make a zone (an out-and-back ride along one road encloses almost nothing). Damage and points still count.
* Slivers under 50 m² left over after cutting around rival zones are dropped.
* GPS is never snapped to roads: inner campus roads and footpaths count exactly as ridden.

### 2.6 Total points for an activity

```
Points = Σ D  +  claim bonus  +  50 × zones broken
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

Days are real calendar days in your own timezone. The overnight rules are applied the next time you open the app, for every day you missed.

### 3.3 Rest tokens

* **1 rest token per week** (refilled every Monday, no carry-over). Use it from **Profile → Today**.
* Using one on an inactive day means **no penalty** and **streak kept**. Your missed-day and inactive-day counters don't advance, so decay doesn't get worse.
* This exists so recovery days aren't punished. Rest is part of training.

### 3.4 Territory decay

Zones whose owner has been inactive lose HP every night:

| Owner inactive for | Overnight decay |
|---|---|
| 0 to 1 days | none |
| 2 to 4 days | −10 % of max HP |
| 5+ days | −20 % of max HP |

Decaying zones also take **×1.25 damage** from attackers (§2.4). A zone that decays to 0 HP is gone and its ground is free. Your next trip (or rest token) stops the decay; HP already lost stays lost until you heal it.

---

## 4. Anti-cheat

The recorder checks every 1 Hz GPS fix. Flagged distance earns **no damage and no daily-minimum credit**, and flagged points are left out of the zone shape. If more than **20 %** of a trip's distance is flagged, the trip makes **no zone**.

| Check | Rule | Example |
|---|---|---|
| **GPS jump** | > 80 m between fixes *and* faster than 40 m/s (144 km/h) | Teleport across town: the segment is ignored |
| **Mode mismatch** | Mode is *walking* and the 5-second smoothed speed is > 10 km/h | "Walking" at 25 km/h |
| **Car-speed segment** | Smoothed speed is > 45 km/h in any mode | Riding in a car or bus |
| **Poor GPS fix** | Fixes with accuracy worse than ±30 m are dropped before scoring | Indoors, or between tall buildings |
| **GPS jitter** | A Kalman filter weighs every fix by its accuracy, and moves smaller than the GPS noise are held | Standing still doesn't add distance |
| **Altitude glitch** | A measured grade steeper than 25 % is treated as flat | GPS altitude jumping, so there's no fake uphill bonus |

* Damage stops on the **first** over-limit sample. A visible flag ("Anti-cheat: …") appears once the speed has been over the limit for **8 s**, so a GPS spike doesn't trigger a warning.
* The summary lists every flag and the kilometres excluded.

### Mode detection

* **Auto (default):** smoothed speed < 7.5 km/h means walking and > 9.5 km/h means cycling. Between the two, the previous mode is kept, so it doesn't flicker at junctions.
* **Manual override:** the player can lock Walk or Cycle. The lock is then enforced by the mode-mismatch check.

---

## 5. Friends & multiplayer

* Every player has a 6-character **friend code** (and an invite link). Adding a friend is mutual.
* Everyone's zones near you are on the map. Friends are still **rivals**: moving through their zones damages them, and theirs damages yours.
* While you're on a trip, your live position is shared with your friends (only while recording).
* **Go together:** each friend who is also on a trip within **60 m** of you adds the **group combo** `G` (2 players ×1.2, 3 ×1.35, 4+ ×1.5).
* When you damage or break someone's zone, they get a notification.

---

## 6. Leaderboards & profile

| Board | Ranked by |
|---|---|
| Friends | Total points, you and your friends |
| Weekly damage | Damage dealt since Monday, you and your friends |
| Territory | Area currently held, you and your friends |
| Everyone | Total points, top 50 players |

**Profile stats:** total points, damage dealt, points lost to inactivity, current and best streak, territory (km²), rest tokens, badges.

### Badges

| Badge | Unlock |
|---|---|
| 🚩 Flag Planter | Claim your first zone |
| ⚔️ Raider | Break a rival zone |
| 🛡️ Defender | Heal a damaged zone |
| 🧭 Explorer | Claim 0.05 km² (50,000 m²) in total |
| 👥 Squad Goals | Finish a trip with a friend nearby |
| ✅ Fair Play | Finish an activity with no anti-cheat flags |
| 🔥 On a Roll | 3-day streak |
| 🏆 Week Warrior | 7-day streak |
| 😴 Smart Recovery | Use a rest token |

---

## 7. Notifications

| Trigger | Message |
|---|---|
| Someone damages your zone | "Mira hit your zone Turf #2 for 42 HP. Ride through it to heal it." |
| Someone breaks your zone | "Mira broke your zone Turf #2! Its ground is free to claim." |
| A zone of yours decays to 0 HP | "You lost Turf #2 to decay." |
| Someone adds you | "Mira added you as a friend." |
| Each morning | "Keep your 3-day streak 🔥 15 min walking or 5 km cycling today." |
| Missed day(s) | "Missed 1 day: −10 pts. Next missed day costs −20." |

---

## 8. Design rationale (wellbeing guard-rails)

* **Low bar to stay safe.** 15 minutes of walking is enough. The game rewards consistency, not volume.
* **Capped downside.** The worst possible day costs 50 points. That is about what a 7-minute walk earns, and one normal walk wins it back.
* **Streak bonus caps at 10 days (+20 %),** so there's no growing pressure to never take a day off.
* **Rest token keeps the streak**, so recovery doesn't feel like losing.
* **No bonus for multiple activities per day**, so there's no incentive to double up.
* **Anti-cheat protects fairness** without punishing players: flagged distance is simply not counted, and there are no point deductions.
