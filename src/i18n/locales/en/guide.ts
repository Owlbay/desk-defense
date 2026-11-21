import type { Dict } from '../../index';

// Namespace guide (en): the in-game "Codex & How to Play" page (guide.*) and the landing page /about (guide.about.*).
// Conventions: `**text**` means bold; keys ending in .1 .2 .3… form a list and must be numbered consecutively (no gaps).
// Names and descriptions of towers / enemies / skills are not written here; they come from core's *_META (namespace data).
export default {
  // ───────────── Common ─────────────
  'guide.title': 'Codex & How to Play',
  'guide.menu.label': 'Codex / How to Play',
  'guide.menu.sub': 'Look up towers, enemies and tips anytime',
  'guide.loading': 'Loading the Codex…',
  'guide.loadFail': "Couldn't load the Codex",
  'guide.loadFail.hint': 'Check your connection and try again.',
  'guide.retry': 'Retry',
  'guide.tabs.label': 'Codex categories',
  'guide.search.label': 'Search the Codex',
  'guide.search.placeholder': 'Search towers, enemies, skills, questions…',
  'guide.search.clear': 'Clear search',
  'guide.search.count': '{n} result|{n} results',
  'guide.search.empty': 'Nothing found for "{q}"',
  'guide.search.emptyHint': 'Try another word, like the name of a tower or enemy.',
  'guide.backToList': 'Back to list',
  'guide.toc': 'On this page',
  'guide.yes': 'Yes',
  'guide.no': 'No',
  'guide.none': '—',
  'guide.wave': 'Wave {n}',
  'guide.unlock.default': 'Available from the start',
  'guide.unlock.campaign': 'Campaign {c}-{w}',
  'guide.about.link': 'About the game',

  'guide.tab.play': 'How to Play',
  'guide.tab.tower': 'Towers',
  'guide.tab.enemy': 'Enemies & bosses',
  'guide.tab.affix': 'Affixes',
  'guide.tab.skill': 'Skills / perks / talents',
  'guide.tab.combo': 'Combos & builds',
  'guide.tab.ai': 'AI Play',
  'guide.tab.faq': 'FAQ',

  // ───────────── How to Play · Getting started ─────────────
  'guide.play.start.title': 'Getting started',
  'guide.play.start.intro':
    "Desk Defense is a **maze tower defense** game: towers are walls, and every tower you place changes the enemies' route. Protect the homework notebook at the bottom of the desk and don't let your lives hit zero.",
  'guide.play.start.1':
    '**Goal**: enemies walk from the entrance at the top to the homework notebook at the bottom. Each one that gets through costs lives (usually 1; Tape Rolls cost 2, bosses 5–8). In Campaign you win by surviving wave 20; in Endless you see how long you can last.',
  'guide.play.start.2':
    '**Build the path first, then the towers**: enemies always take the shortest route available. Use 5-gold Book Walls to make the path longer so every tower gets more shots.',
  'guide.play.start.3':
    "**No full blocks**: after you place a tower, every entrance must still have a path to the homework notebook, and you can't trap enemies already on the board.",
  'guide.play.start.4':
    '**Flying enemies ignore the maze**: Paper Planes and Moths fly in a straight line from the entrance to the homework notebook. You need a Pencil, Desk Lamp, Ruler, Fountain Pen or Fly Swatter to hit them.',
  'guide.play.start.5':
    '**Where gold comes from**: kill bounties, wave clear rewards (10 + 2 × wave number), interest (5% of your gold at the end of each wave, capped at 20 on Normal), rewards for calling the next wave early, and Piggy Banks.',
  'guide.play.start.6':
    '**Towers grow**: towers earn XP by dealing damage and level up to Lv9 for free. You can also pay gold to level up right away. The fuller the XP bar, the cheaper it is, down to half price on a full bar.',
  'guide.play.start.7':
    "**Misplaced a tower? No loss**: within 5 seconds of placing it, if it hasn't fired yet, you can undo for a full refund. Selling returns 70%–25% of the gold you put in, depending on level.",
  'guide.play.start.8':
    "**Read the next-wave preview**: it tells you which entrance the enemies will use and whether there's a boss, an air raid, a rush or elites, so you can prepare.",
  'guide.play.start.tips.title': '5 tips for new players',
  'guide.play.start.tips.1': 'Place towers at corners and between lanes. A tower that covers two stretches of path is worth double.',
  'guide.play.start.tips.2':
    "Don't rush to pay for upgrades. Let towers earn XP first; with a full XP bar at Lv9, going Legendary costs only half.",
  'guide.play.start.tips.3': "Bring anti-air every run. The maze can't stop flying enemies.",
  'guide.play.start.tips.4':
    'When you have gold to spare, keep about 400 in the bank before spending. That is 20 free gold in interest every wave.',
  'guide.play.start.tips.5': 'Save your skills for boss waves: Big Eraser gives the best value right after the Coffee Stain splits.',

  // ───────────── How to Play · Controls ─────────────
  'guide.play.controls.title': 'Controls',
  'guide.play.controls.intro':
    'Use mouse and keyboard on a computer, and touch on phones and tablets. Every touch action is "tap once to preview, tap the same spot again to confirm", so mis-taps are harmless.',
  'guide.play.controls.col.action': 'Action',
  'guide.play.controls.col.desktop': 'Computer',
  'guide.play.controls.col.touch': 'Phone / tablet',
  'guide.play.controls.build.a': 'Pick a tower to build',
  'guide.play.controls.build.d': 'Click the tower bar, or press 1–9, 0, -, =',
  'guide.play.controls.build.t': 'Tap the tower bar',
  'guide.play.controls.place.a': 'Place a tower',
  'guide.play.controls.place.d': 'Hover to preview range and the new route, click to place; keep clicking to place more',
  'guide.play.controls.place.t': 'Tap a tile to preview, tap the same tile again to confirm',
  'guide.play.controls.cancel.a': 'Cancel',
  'guide.play.controls.cancel.d': 'Right-click or Esc',
  'guide.play.controls.cancel.t': 'Tap the selected button again, or tap outside the board',
  'guide.play.controls.upgrade.a': 'Upgrade / sell',
  'guide.play.controls.upgrade.d': 'Buttons, or U / S',
  'guide.play.controls.upgrade.t': 'Buttons; selling takes two taps',
  'guide.play.controls.skill.a': 'Use a skill',
  'guide.play.controls.skill.d': 'Q W E R to aim, click the board to cast',
  'guide.play.controls.skill.t': 'Tap the skill, tap the board to preview, tap again to confirm',
  'guide.play.controls.wave.a': 'Start the wave / call the next wave early',
  'guide.play.controls.wave.d': 'Space',
  'guide.play.controls.wave.t': 'Tap the wave button',
  'guide.play.controls.speed.a': 'Speed 1× / 2× / 3×',
  'guide.play.controls.speed.d': 'F',
  'guide.play.controls.speed.t': 'Tap the speed button',
  'guide.play.controls.pause.a': 'Pause',
  'guide.play.controls.pause.d': 'P',
  'guide.play.controls.pause.t': 'Tap the pause button in the top right',
  'guide.play.controls.ability.a': 'Mythic tower ability',
  'guide.play.controls.ability.d': 'Select the tower, then press A',
  'guide.play.controls.ability.t': 'Tap the tower ability button to the right of the skill bar',
  'guide.play.controls.note':
    'The game pauses automatically when you switch to another app or tab. See the FAQ for the full list of shortcuts.',

  // ───────────── How to Play · Modes ─────────────
  'guide.play.modes.title': 'Modes',
  'guide.play.modes.intro':
    'Three ways to play, plus a Daily Challenge. Endless and the Daily Challenge are open from the start; clearing Chapter 1 of the Campaign opens Custom mode and more maps.',
  'guide.play.modes.campaign.name': 'Campaign',
  'guide.play.modes.campaign.desc':
    '3 chapters, each with its own map and 20 hand-crafted waves, on Normal or Hard. You earn 1–3 stars based on lives left, and stars buy permanent talents. New towers and skills unlock as you progress.',
  'guide.play.modes.endless.name': 'Endless',
  'guide.play.modes.endless.desc':
    "Keep going for as long as you can on any map you've cleared. Difficulty runs from Easy, Normal, Hard and Nightmare up to Abyss I–X. Every 10 waves brings a boss and a perk pick, every 7 waves an air raid, every 5 waves a rush. You earn ink at the end of the run, and your result goes on the leaderboard.",
  'guide.play.modes.daily.name': 'Daily Challenge',
  'guide.play.modes.daily.desc':
    "One desk with a fixed seed every day. Everyone gets the same map and rules and competes on that day's leaderboard.",
  'guide.play.modes.custom.name': 'Custom',
  'guide.play.modes.custom.desc':
    "Start from a difficulty preset, then use sliders to tune everything: enemy HP, count, speed, interest, event frequency and more. Generate a share code and send it to friends. Results don't go on the leaderboard.",
  'guide.play.modes.maps.title': 'Three maps',
  'guide.play.modes.diff.title': 'Endless difficulty',
  'guide.play.modes.diff.col.name': 'Difficulty',
  'guide.play.modes.diff.col.gold': 'Starting gold',
  'guide.play.modes.diff.col.lives': 'Lives',
  'guide.play.modes.diff.col.hp': 'Enemy HP',
  'guide.play.modes.diff.col.elite': 'Elites appear',
  'guide.play.modes.diff.col.interest': 'Interest cap',
  'guide.play.modes.diff.eliteNever': 'Never',
  'guide.play.modes.diff.abyss': 'Abyss {n}',
  'guide.play.modes.diff.unlock':
    'Unlocks: Easy and Normal are available from the start. Reach wave 30 on Normal for Hard, wave 40 on Hard for Nightmare, and wave 35 on Nightmare for Abyss I. After that, reach wave 30 on each Abyss level to open the next.',
  'guide.play.modes.seed':
    '**Seed**: the same seed means the same clutter layout, waves and event schedule. You can copy it from the pause menu, the results screen and the leaderboard. Send it to a friend to play the exact same run.',
  'guide.play.modes.score': '**Score** = (waves survived × 100 + kills + lives left × 50 + gold left × 0.1) × difficulty multiplier.',

  // ───────────── How to Play · Auto Wave ─────────────
  'guide.play.autowave.title': 'Auto-start waves',
  'guide.play.autowave.intro':
    'Waves start either manually or automatically. Easy difficulty and an uncleared Chapter 1 default to manual; everything else defaults to auto. You can change this in Settings or on the run setup screen. Leaderboards are kept separately for each wave start mode.',
  'guide.play.autowave.1':
    '**Manual**: you start every wave yourself, with no time pressure. Starting the next wave before the current one is finished rewards 5 + wave number gold.',
  'guide.play.autowave.2':
    '**Auto**: you start the first wave. After that, a countdown begins once all enemies of a wave have spawned (20 seconds on Normal), and the next wave starts when it hits 0.',
  'guide.play.autowave.3':
    'The countdown is ×1.5 before a boss wave. Each wave also has a time limit (60 seconds on Normal); when it runs out, the next wave starts anyway.',
  'guide.play.autowave.4':
    'You can call the next wave early during the countdown. Reward = seconds left × (1 + wave number / 10) gold, so it pays more the later you are in the run.',
  'guide.play.autowave.5': 'At most 3 waves can be active at once. At the limit, the countdown holds at 0 until you clear one.',
  'guide.play.autowave.6': 'The countdown pauses while you pick a perk. The wave button flashes when 3 seconds are left.',

  // ───────────── How to Play · Random events ─────────────
  'guide.play.events.title': 'Random events',
  'guide.play.events.intro':
    'Every two or three waves, something happens on the desk. Some events cause trouble, some bring gifts. Events with a warning are announced on screen ahead of time. The higher the difficulty, the more often events happen and the more of them are bad.',
  'guide.play.events.tone.bad': 'Negative',
  'guide.play.events.tone.good': 'Positive',
  'guide.play.events.tone.neutral': 'Neutral',
  'guide.play.events.minWave': 'From wave {n}',
  'guide.play.events.warn': '{n}s warning',
  'guide.play.events.warnDrop': 'Warning varies by difficulty',
  'guide.play.events.crate.title': 'Supply Crate rewards (3 random options each time)',
  'guide.play.events.tip':
    'You have to **click** coins and Supply Crates to collect them (on a computer you can also hover and press Space). They disappear if you wait too long.',

  // ───────────── How to Play · Dynamic Battlefield ─────────────
  'guide.play.field.title': 'Dynamic Battlefield',
  'guide.play.field.intro':
    "Enemies don't come from just one place. New entrances open and boxes drop from above, so leave some slack in your maze.",
  'guide.play.field.1':
    "**Desk-edge entrances**: the main entrance on the north side is open from the start. Side entrances open at set waves. Even an entrance that isn't open yet must keep a path to the homework notebook.",
  'guide.play.field.2':
    "**Secret Doors**: hidden spawn points built into the map. The Secret Door event opens one for 3 waves. Put a tower on a Secret Door's tile and that door can't open.",
  'guide.play.field.3':
    '**Airdrop Boxes**: a few seconds after the warning, the box lands and becomes a new obstacle and spawn point. For the next 2–4 waves, 25%–40% of enemies come out of it.',
  'guide.play.field.4':
    '**Dealing with boxes**: once it lands, click it to dismantle it (40 + 5 × wave number gold), or seal it outright with the Packing Tape skill (this works during the warning too). A box in the back half of your maze gives enemies a shortcut, so deal with it first.',
  'guide.play.field.5':
    '**Landing rules**: boxes only land on open ground at least 7 tiles from the homework notebook, with no towers in the ring of tiles around it. The tighter your maze, the fewer places a box can land.',
  'guide.play.field.6':
    '**Spawn patterns**: alternating, random, pincer (split evenly across all entrances at once) and ambush (the whole group pours out of one entrance). The next-wave preview shows exactly what will happen.',
  'guide.play.field.7':
    '**Special waves** (Endless): an air raid every 7 waves (about 60% flying enemies), a rush every 5 waves (fast enemies ×2), and from wave 12 a possible pincer every 8 waves.',

  // ───────────── How to Play · Evolution ─────────────
  'guide.play.evolve.title': 'Evolution',
  'guide.play.evolve.intro': 'Every attack tower has five forms, and its look changes with each one.',
  'guide.play.evolve.col.form': 'Form',
  'guide.play.evolve.col.level': 'Level',
  'guide.play.evolve.col.gain': 'You get',
  'guide.play.evolve.lv.1': 'Lv1–3',
  'guide.play.evolve.lv.2': 'Lv4–6',
  'guide.play.evolve.lv.3': 'Lv7–9',
  'guide.play.evolve.lv.4': 'Lv10',
  'guide.play.evolve.lv.5': 'Legendary ★3',
  'guide.play.evolve.gain.1': 'Base abilities',
  'guide.play.evolve.gain.2': 'Fine trait',
  'guide.play.evolve.gain.3': 'Gilded trait',
  'guide.play.evolve.gain.4': "Path A or B ability. Pick one; it can't be changed later",
  'guide.play.evolve.gain.5': 'An active ability and a brand-new look',
  'guide.play.evolve.1': 'Each level: damage ×1.15, attack interval ×0.97, range +0.06 tiles. Lv10 damage is about 3.5 times Lv1.',
  'guide.play.evolve.2':
    'XP can take a tower up to Lv9. **Lv10 has to be bought with gold and requires picking a legend path.** It costs about 14 times the build cost, or half that with a full XP bar.',
  'guide.play.evolve.3':
    'After Legendary, a tower can gain 3 more stars. ★1 and ★2 each unlock a path trait and can be reached on XP alone (500 / 1000 evolution XP).',
  'guide.play.evolve.4':
    '**★3 Mythic** has to be bought with gold (Legendary cost × 1.3; evolution XP can cover up to half) and grants an active ability.',
  'guide.play.evolve.5':
    'Each star: damage ×1.12, range +0.1, attack interval ×0.97. For the Calculator and Piggy Bank it is +10% aura or income instead.',
  'guide.play.evolve.6':
    "Mythic ability cooldowns only tick during combat. The ability button is in the tower's info panel and also appears to the right of the skill bar.",

  // ───────────── Towers ─────────────
  'guide.tower.intro':
    '12 towers: 1 maze-building Book Wall, 9 attack towers, 1 support tower and 1 economy tower. Open any of them to see its forms, stats and legend paths.',
  'guide.tower.cost': 'Cost',
  'guide.tower.ground': 'Hits ground',
  'guide.tower.air': 'Hits air',
  'guide.tower.unlock': 'Campaign unlock',
  'guide.tower.forms': 'Forms',
  'guide.tower.forms.wall': 'Three levels',
  'guide.tower.stats': 'Stats',
  'guide.tower.stats.note': 'Panel values on Normal with no adjacency bonuses and no buffs, matching what the game shows.',
  'guide.tower.col.stat': 'Stat',
  'guide.tower.col.level': 'Lv{n}',
  'guide.tower.col.branch': 'Lv10 · {b}',
  'guide.tower.traits': 'Traits',
  'guide.tower.trait.level': 'Unlocks at Lv{n}',
  'guide.tower.trait.combo': 'Adjacency combo',
  'guide.tower.branches': 'Legend paths (pick one at Lv10)',
  'guide.tower.branch': 'Path {b}',
  'guide.tower.mythic': '★3 Mythic · {form}',
  'guide.tower.ability': 'Active ability',
  'guide.tower.ability.cd': 'Cooldown {n}s',
  'guide.tower.ability.charge': 'Charges: 1 restored every {n} wave|Charges: 1 restored every {n} waves',
  'guide.tower.legendCost': 'Legendary upgrade cost (before discount): {n} gold',
  'guide.tower.computeFail': "This tower's stats can't be read right now.",
  'guide.tower.targets': 'Targeting: {list}. Select a tower to switch.',
  'guide.listSep': ', ',

  // ───────────── Enemies & bosses ─────────────
  'guide.enemy.intro':
    '12 regular enemies and 4 bosses. Stats are base values for wave 1 on Normal. HP, count, speed and armor grow with wave number and difficulty.',
  'guide.enemy.section.normal': 'Regular enemies',
  'guide.enemy.section.boss': 'Bosses',
  'guide.enemy.section.rules': 'Rules',
  'guide.enemy.hp': 'HP',
  'guide.enemy.speed': 'Speed',
  'guide.enemy.armor': 'Armor',
  'guide.enemy.bounty': 'Bounty',
  'guide.enemy.lives': 'Lives lost',
  'guide.enemy.first': 'First seen in Endless',
  'guide.enemy.speedUnit': '{n} tiles/s',
  'guide.enemy.tag.flying': 'Flying',
  'guide.enemy.tag.boss': 'Boss',
  'guide.enemy.tag.stealth': 'Stealth',
  'guide.enemy.tag.unstoppable': 'Unstoppable',
  'guide.enemy.tag.shield': 'Shield',
  'guide.enemy.tag.fast': 'Fast',
  'guide.enemy.tag.armored': 'Armored',
  'guide.enemy.behavior': 'Behavior',
  'guide.enemy.counter': 'Counter',
  'guide.enemy.bossCommon':
    '**Resistances shared by all bosses**: slows are halved; stuns and roots last 0.3 seconds at most; immune to knockback and execution. You get a warning 3 seconds before a boss appears, and it has its own HP bar at the top of the screen. In Endless, bosses rotate every 10 waves: 2 at a time from wave 50, and 3 from wave 100.',

  'guide.enemy.crumb.behavior': 'The most basic enemy. Comes in large numbers.',
  'guide.enemy.crumb.counter': 'Any tower works. The Pencil, Stapler and Compass are all effective.',
  'guide.enemy.inkdot.behavior': 'Almost twice as fast as an Eraser Crumb, with very low HP. Shows up in swarms during rush waves.',
  'guide.enemy.inkdot.counter':
    "Slow them with Glue and make the path longer. The Stapler's and Compass's area damage needs no aiming, so it's reliable against fast enemies.",
  'guide.enemy.paperclip.behavior': 'Has 3 armor. Armor is subtracted from every hit it takes.',
  'guide.enemy.paperclip.counter':
    "Desk Lamp (ignores armor), Eraser (shreds armor), and damage over time such as the Fountain Pen's ink trail.",
  'guide.enemy.plane.behavior': 'Flying. Ignores the maze and flies straight from the entrance to the homework notebook.',
  'guide.enemy.plane.counter':
    'Place a Fly Swatter, Pencil, Desk Lamp or Ruler near the straight line from the entrance to the homework notebook.',
  'guide.enemy.paperball.behavior': 'Splits into 3 Paper Scraps when it dies.',
  'guide.enemy.paperball.counter': 'Keep some area damage (Stapler, Compass) in the back half of the maze to mop up the scraps.',
  'guide.enemy.sticky.behavior':
    'Comes with a shield equal to its HP. If it goes 4 seconds without being hit, the shield regenerates quickly.',
  'guide.enemy.sticky.counter': "The Eraser deals triple damage to shields. Keep up steady fire and don't give it a window to recharge.",
  'guide.enemy.rubberband.behavior': "Every 4 seconds it bounces 2 tiles forward along the path. It can't be hit mid-bounce.",
  'guide.enemy.rubberband.counter': 'A long maze plus sustained fire. A stun resets its bounce timer.',
  'guide.enemy.whiteout.behavior': 'Every second it heals other enemies within 1.5 tiles for 4% of their max HP.',
  'guide.enemy.whiteout.counter': 'The Fountain Pen\'s ink trail halves healing. Set targeting to "strongest" to kill it first.',
  'guide.enemy.ant.behavior':
    "Rushes out fast in swarms. Ants don't cost lives, but each one that reaches the homework notebook steals at least 5 gold (or 3% of your current gold).",
  'guide.enemy.ant.counter': "Area damage such as the Stapler and Compass. The Piggy Bank's path B stops Ants from stealing gold.",
  'guide.enemy.invisink.behavior': "Stealthed. Normally it can't be targeted and is only revealed within 1.2 tiles of a tower.",
  'guide.enemy.invisink.counter':
    "The Desk Lamp detects it. The Stapler's and Compass's area damage needs no aiming. The White-Out and Magnifier skills reveal it.",
  'guide.enemy.tape.behavior': 'High HP, armored, costs 2 lives, and immune to slow, stun, root and knockback.',
  'guide.enemy.tape.counter': 'Only damage works: the Desk Lamp, Staplers and Pencils after its armor is shredded, and damage over time.',
  'guide.enemy.moth.behavior': 'Flying. Has a 25% chance to dodge Pencil and Fountain Pen shots, and takes ×2 damage from the Desk Lamp.',
  'guide.enemy.moth.counter': "Desk Lamp, Fly Swatter (swats can't be dodged), Ruler.",
  'guide.enemy.crumbmini.behavior': 'Scraps left when a Paper Ball splits. Very low HP.',
  'guide.enemy.crumbmini.counter': 'Any area damage.',
  'guide.enemy.boss_coffee.behavior':
    'Every 8 seconds it disables towers within 1.5 tiles for 2 seconds. At half HP it splits into two small Coffee Stains.',
  'guide.enemy.boss_coffee.counter':
    "Don't pack all your firepower into one stretch of path, and keep ranged towers at least 2 tiles from the route. Right after the split the two halves are bunched up, which is the perfect moment for Big Eraser.",
  'guide.enemy.boss_coffee_small.behavior': 'Split off from the Coffee Stain. It also splashes and disables towers.',
  'guide.enemy.boss_coffee_small.counter': "Hit them with area damage right after the split, while they're still bunched up.",
  'guide.enemy.boss_shredder.behavior': 'Has a hefty 6 armor, and every 5 seconds it spits out 2 Eraser Crumbs behind it.',
  'guide.enemy.boss_shredder.counter':
    'The Desk Lamp ignores armor. Shred its armor with the Eraser first. Damage over time such as the Fountain Pen also ignores armor. Keep area damage in the back half to clean up the crumbs.',
  'guide.enemy.boss_inkbottle.behavior': 'Every 10 seconds it shields allies within 2.5 tiles. At 30% HP it goes stealth for 5 seconds.',
  'guide.enemy.boss_inkbottle.counter':
    'Clear shields with the Eraser. Put a Desk Lamp in the back half of the maze, or save Magnifier or White-Out for the stealth phase.',
  'guide.enemy.boss_alarm.behavior':
    'Every 12 seconds it speeds up all enemies by 50% for 3 seconds. Immune to stun. Costs 8 lives if it gets through. Appears only in Endless.',
  'guide.enemy.boss_alarm.counter':
    'Your maze needs to be long enough. Combine slows with focused Desk Lamp fire, and save Mythic abilities like Deep Freeze and Emergency Lockdown until it gets close.',

  'guide.enemy.rules.armor':
    '**Armor**: subtracted from every hit, down to a minimum of 1 damage. Desk Lamp beams, all damage over time and the Big Eraser skill ignore armor.',
  'guide.enemy.rules.shield':
    "**Shield**: absorbs damage before HP, and armor doesn't protect it. The Eraser deals triple damage to shields.",
  'guide.enemy.rules.air':
    '**Flying**: flies straight to the homework notebook, so the maze does nothing. Towers that hit air: Pencil, Desk Lamp, Ruler, Fountain Pen, Fly Swatter. School Bell and White-Out have no effect on flying enemies.',
  'guide.enemy.rules.stealth':
    "**Stealth**: can't be targeted. Revealed within 1.2 tiles of any tower, within 1.5 tiles of a Desk Lamp, when hit by an area attack, or inside a White-Out or Magnifier zone.",
  'guide.enemy.rules.elite':
    '**Elites**: appear on higher difficulties with HP ×2.5 and bounty and XP ×2, carrying 1–4 affixes. See "Affixes" for details.',

  // ───────────── Affixes ─────────────
  'guide.affix.intro':
    'On higher difficulties, regular enemies have a chance to become **elites**: HP ×2.5, larger size, bounty and XP ×2, with affix icons above their heads. An elite has at most 1 affix on Normal, 2 on Hard and Nightmare, 3 on Abyss, and 4 from Abyss V.',
  'guide.affix.counter': 'Counter',
  'guide.affix.hard.counter': 'Desk Lamp, Eraser, damage over time.',
  'guide.affix.swift.counter': 'Glue, School Bell, White-Out.',
  'guide.affix.regen.counter': "The Fountain Pen's ink trail halves regeneration. Focus burst damage.",
  'guide.affix.shield.counter': 'The Eraser deals triple damage to shields.',
  'guide.affix.split.counter': 'Area damage such as the Stapler and Compass.',
  'guide.affix.stealth.counter': 'Desk Lamp, area damage, Magnifier, White-Out.',
  'guide.affix.reflect.counter': 'Switch to damage other than beams.',
  'guide.affix.unstoppable.counter': "Crowd control doesn't work. Just stack damage.",
  'guide.affix.rally.counter': 'Set targeting to "strongest" or "first" to kill it early.',
  'guide.affix.note.1': '"Unstoppable" never appears together with "Swift".',
  'guide.affix.note.2': 'The next-wave preview shows the number of elites and their affixes.',
  'guide.affix.note.3': "The Eraser's Mythic ability can wipe every affix from one non-boss elite at once.",

  // ───────────── Skills / perks / talents ─────────────
  'guide.skill.section.skills': 'Active skills',
  'guide.skill.section.perks': 'In-run perks',
  'guide.skill.section.talents': 'Permanent talents',
  'guide.skill.intro':
    "You bring 3 skills into a run (the Big Backpack talent unlocks a 4th). Skills cost no gold; they're limited by cooldowns.",
  'guide.skill.rules.1': "All skills are ready at the start. Cooldowns **only tick during combat** and don't move between waves.",
  'guide.skill.rules.2': 'Upgrade skills with ink on the Skills page, up to Lv3: each level gives −8% cooldown and +15% effect.',
  'guide.skill.rules.3': 'The higher the difficulty, the longer the cooldowns (×0.8 on Easy, about ×1.38 on Abyss X).',
  'guide.skill.rules.4': 'Big Eraser and Ruler Sweep damage scales with wave number, so they stay useful late in a run.',
  'guide.skill.cd': 'Cooldown {n}s',
  'guide.skill.charge': 'Charges',
  'guide.perk.intro':
    'In Endless and Custom you pick a perk every 10 waves; in Campaign you pick once after wave 10. Choose 1 of 3, or pay 50 gold to reroll. Each perk can be taken only once per run (except repeatable ones).',
  'guide.perk.rarity.common': 'Common',
  'guide.perk.rarity.rare': 'Rare',
  'guide.perk.rarity.epic': 'Epic',
  'guide.perk.needsTower': 'Requires choosing a tower',
  'guide.talent.intro':
    'Buy talents in the Backpack on the main menu. They last forever. Every level can be bought with stars or ink: stars come from Campaign ratings (18 at most), and ink comes from finishing Endless and Custom runs.',
  'guide.talent.max': 'Max level {n}',
  'guide.talent.price': '{star} stars or {ink} ink per level',
  'guide.talent.tip':
    'Spend stars on the big single-level talents first (Big Backpack, Stationery Collector, Lucky Draw), and fill in the small multi-level bonuses with ink over time.',
  'guide.talent.pure':
    '**Pure Mode**: when starting an Endless run you can turn off all talents. Your result goes on a separate Pure leaderboard.',

  // ───────────── Combos & builds ─────────────
  'guide.combo.section.combos': 'Combos',
  'guide.combo.section.wall': 'Book Wall bonuses',
  'guide.combo.section.archetypes': 'Eight builds',
  'guide.combo.intro':
    'Place the two named towers **directly next to each other (up, down, left or right)** to trigger a combo. It costs nothing extra.',
  'guide.combo.wall.1': 'A Lv2 Book Wall gives adjacent attack towers ×1.05 range.',
  'guide.combo.wall.2': 'A Lv3 Book Wall also gives adjacent attack towers +5% damage.',
  'guide.combo.wall.3': 'Set your main towers into a row of walls so the lanes above and below are both in range.',
  'guide.combo.vuln':
    '**Vulnerability stacks**: "takes more damage" effects from Desk Lamp B, Fountain Pen B, Eraser A, the Magnifier skill and other sources add together, making your whole defense stronger.',
  'guide.arch.core': 'Core',
  'guide.arch.how': 'How to play',
  'guide.arch.weak': 'Weaknesses',
  'guide.arch.maze.name': 'Maze build · Serpentine corridor',
  'guide.arch.maze.core': 'Book Walls, Stapler, Compass and Glue, with a little anti-air.',
  'guide.arch.maze.how':
    'Use walls to divide the desk into back-and-forth lanes, and set Staplers and Compasses into the wall rows so they cover the lanes above and below. Put Glue right next to the Staplers.',
  'guide.arch.maze.weak': "Air raid waves, side entrances that cut the path short, and unstoppable enemies that can't be slowed.",
  'guide.arch.grow.name': 'Growth build · Few but mighty',
  'guide.arch.grow.core': 'Calculator (path B) plus 3–4 main towers, with the Inspiration skill.',
  'guide.arch.grow.how':
    "Don't rush to spend. Let towers grow on XP, wait until the XP bar is past half before every upgrade, and go Legendary at half price with full XP at Lv9.",
  'guide.arch.grow.weak': 'Weak firepower early on. With so few towers, getting disabled silences the whole defense.',
  'guide.arch.armor.name': 'Armor-break build · Boss killer',
  'guide.arch.armor.core': 'Eraser, Desk Lamp B, Fountain Pen B, Stapler B.',
  'guide.arch.armor.how':
    'Put the Eraser in the front half of the maze to shred armor first. Place the Desk Lamp and Fountain Pen next to each other to trigger their combo and stack vulnerability, then focus high-armor targets.',
  'guide.arch.armor.weak': 'The Homework Check event and Reflective elites. Swarms of fast enemies call for extra area damage.',
  'guide.arch.eco.name': 'Economy build · Pain now, payoff later',
  'guide.arch.eco.core': 'Piggy Bank ×3 plus a Calculator, and interest management.',
  'guide.arch.eco.how':
    'Put all three Piggy Banks next to the Calculator to trigger the combo. Hold enough gold to max out interest, then stack Legendary towers all at once late in the run.',
  'guide.arch.eco.weak': 'A firepower gap early on. Ants steal a percentage of your gold. Slow to pay off on high difficulties.',
  'guide.arch.air.name': 'Anti-air build · Hold the sky',
  'guide.arch.air.core': 'Fly Swatter ×2–3, Desk Lamp, Ruler.',
  'guide.arch.air.how': 'All flight paths meet above the homework notebook. Put a Fly Swatter there on each side.',
  'guide.arch.air.weak': "The Fan On event. Fly Swatters don't hit ground enemies, so building too many leaves the ground thin.",
  'guide.arch.rush.name': 'Speed build · Call waves early',
  'guide.arch.rush.core': 'Cost-efficient damage such as the Pencil, Stapler and Glue.',
  'guide.arch.rush.how':
    'Once you have enough firepower, call the next wave early for the reward. With auto-start waves, the reward grows the later you are in the run.',
  'guide.arch.rush.weak':
    "Pressure spikes when waves overlap, and a single leak hands the reward right back. Don't get greedy before a boss wave.",
  'guide.arch.mythic.name': 'Mythic ability build · Active saves',
  'guide.arch.mythic.core': 'Evolve 1–2 key towers to ★3 as early as you can.',
  'guide.arch.mythic.how':
    'Handle emergencies with Mythic active abilities: root every enemy, reveal stealth across the map, pull flying enemies to the ground, or briefly let leaks through without losing lives.',
  'guide.arch.mythic.weak': 'A huge early investment, and weak firepower in the mid game.',
  'guide.arch.line.name': 'Ruler & Compass build · Long-range piercing',
  'guide.arch.line.core': 'Ruler and Compass (adjacent for the combo), with Steel Ruler knockback.',
  'guide.arch.line.how':
    'Leave one long straight lane and place the Ruler in line with it so a single shot pierces the whole row. The Compass holds the corners.',
  'guide.arch.line.weak': 'The straight lane breaks easily when events change the terrain. Inefficient against spread-out enemies.',
  'guide.arch.prism.name': 'Prism Array build · Focused beams',
  'guide.arch.prism.core': 'Desk Lamp ×3–4, later a Laser Pointer (Legend A) as the core, plus one Eye-Care Lamp (B).',
  'guide.arch.prism.how':
    "Line the Desk Lamps up along the Boss route about 2 tiles apart (≤ 2.5 tiles center to center). In a link group only the main lamp fires while the others feed their light into it, so the beam keeps shining and ramps up. A normal link group holds at most 4 lamps; a group with a Laser Pointer has no limit. The Eye-Care Lamp marks targets and adds vulnerability for the whole group's beams.",
  'guide.arch.prism.weak':
    'Swarms of small and fast enemies (single beam, ramp resets on a new target). Coffee on a lamp in the middle of the chain splits the group. The Lamp Outage event. The Reflective affix halves the damage.',

  // ───────────── AI Play ─────────────
  'guide.ai.intro':
    "Let a large language model play the game like a player, or have it advise you while you play. Every AI move goes through the same validation as your clicks, so it can't cheat. AI results go on a separate AI leaderboard.",
  'guide.ai.modes.title': 'Two roles',
  'guide.ai.modes.1': '**AI Player**: the model plays a whole run on its own. You can watch its reasoning and every action.',
  'guide.ai.modes.2':
    '**AI Advisor**: you play, and the model only reads the board and makes suggestions, which you can apply with one click.',
  'guide.ai.setup.title': 'Three ways to connect',
  'guide.ai.relay.name': 'API relay or official key',
  'guide.ai.relay.desc':
    'Open "AI Play" from the main menu, choose an API relay under Model, paste the service URL and API key, click "Fetch models" and pick one, then click "Test connection". Requests go straight from your browser to the address you entered and never pass through our servers.',
  'guide.ai.local.name': 'Local model',
  'guide.ai.local.desc':
    'Run Ollama or LM Studio on your own computer and allow cross-origin access from this site (set OLLAMA_ORIGINS for Ollama; turn on Enable CORS in LM Studio), then choose the matching local service on the setup page.',
  'guide.ai.bridge.name': 'Local Bridge',
  'guide.ai.bridge.desc':
    "Use this when a provider doesn't allow direct access from web pages: run the bridge on your computer (npm run agent:bridge), connect the page to it with a pairing code, and the bridge calls the model for you. Your key stays on your computer.",
  'guide.ai.demo': 'No key? You can still try it: choose "Offline Demo" to go through the whole flow with a built-in strategy.',
  'guide.ai.tips.title': 'Troubleshooting',
  'guide.ai.tips.1':
    "**Can't connect**: most likely the provider doesn't allow cross-origin requests from browsers. Use the Local Bridge instead.",
  'guide.ai.tips.2':
    '**Key rejected**: check that the key is correct and still has quota. We recommend a separate key with a spending limit.',
  'guide.ai.tips.3':
    '**Want to see what the AI is thinking?** Open the "Reasoning & requests" panel during a run. It lists every decision, tool call and usage figure in order. All of this stays in your browser.',
  'guide.ai.open': 'Open AI Play',

  // ───────────── FAQ ─────────────
  'guide.faq.save.q': 'Where is my progress saved? Can I lose it?',
  'guide.faq.save.a':
    'All progress is saved automatically in this browser, with no sign-in needed. You lose it if you clear site data, use private browsing, or choose "Delete save" in Settings. Progress doesn\'t sync between devices.',
  'guide.faq.offline.q': 'Can I play offline? How do I install it?',
  'guide.faq.offline.a':
    'Yes. Open the game once while online and its files are cached on your device. On iPhone and iPad, tap "Share" in Safari, then "Add to Home Screen". In Chrome or Edge on Android or a computer, choose "Install" from the menu or the address bar.',
  'guide.faq.resume.q': 'I quit in the middle of a run. Can I pick it up again?',
  'guide.faq.resume.a':
    'Yes. The game saves after every wave. Go back to the main menu and choose "Continue" to resume from the end of the last wave.',
  'guide.faq.place.q': "Why can't I place a tower here?",
  'guide.faq.place.a':
    "Common reasons: it would block the path, it would trap enemies, an enemy is standing on the tile, the tile is an entrance or clutter, an Airdrop Box warning is active there, you don't have enough gold, or the tower isn't unlocked in the Campaign yet. You can have at most 3 Piggy Banks.",
  'guide.faq.air.q': "Why can't my towers hit flying enemies?",
  'guide.faq.air.a':
    'Only the Pencil, Desk Lamp, Ruler, Fountain Pen and Fly Swatter can hit air. Flying enemies head straight for the homework notebook, so put your anti-air towers just above it, where all flight paths meet.',
  'guide.faq.idle.q': 'Why did my tower suddenly stop attacking?',
  'guide.faq.idle.a':
    'It may be disabled (by the Coffee Stain boss or the Coffee Spill event), hit by a Lamp Outage, or its target may be stealthed, a Rubber Band in mid-bounce, or out of range.',
  'guide.faq.cooldown.q': "Why isn't my skill cooldown moving?",
  'guide.faq.cooldown.a':
    "Skill and Mythic ability cooldowns only tick while combat is under way. They don't move during the prep phase between waves.",
  'guide.faq.branch.q': 'I picked the wrong legend path. Can I change it?',
  'guide.faq.branch.a':
    'No. The only way is to sell the tower and rebuild it, and a Lv10 tower refunds just 25%. You can read up on both paths in this Codex before choosing.',
  'guide.faq.autowave.q': 'Auto-start waves are too fast. Can I turn them off?',
  'guide.faq.autowave.a':
    'Yes. Set wave start to manual in Settings, or switch it on the run setup screen. The change applies from your next run. Leaderboards are kept separately for each wave start mode.',
  'guide.faq.friend.q': 'How do I play the same run as a friend?',
  'guide.faq.friend.a':
    'Send your friend the seed. They enter it on the run setup screen and pick the same map. In Custom mode, add the share code and the rules will match exactly too.',
  'guide.faq.perf.q': 'My phone gets hot or laggy. What can I do?',
  'guide.faq.perf.a': 'Set Graphics to "Low" in Settings and use 3× speed less often.',
  'guide.faq.lang.q': 'How do I change the language and appearance?',
  'guide.faq.lang.a': 'Open "Settings" from the main menu to change the language. 简体中文, 繁體中文, English and 日本語 are supported.',
  'guide.faq.shortcuts.title': 'Keyboard shortcuts',
  'guide.faq.shortcuts.col.key': 'Key',
  'guide.faq.shortcuts.col.action': 'Action',
  'guide.faq.shortcuts.build': 'Select {name}',
  'guide.faq.shortcuts.skills': 'Skills 1–4',
  'guide.faq.shortcuts.axis': 'Switch Ruler Sweep between horizontal / vertical',
  'guide.faq.shortcuts.space': 'Start the next wave / call it early; collect when hovering over a coin or Supply Crate',
  'guide.faq.shortcuts.speed': 'Switch speed 1× / 2× / 3×',
  'guide.faq.shortcuts.pause': 'Pause / resume',
  'guide.faq.shortcuts.upgrade': 'Upgrade the selected tower',
  'guide.faq.shortcuts.sell': 'Sell the selected tower',
  'guide.faq.shortcuts.ability': "Use the selected Mythic tower's active ability",
  'guide.faq.shortcuts.esc': 'Cancel the current action',
  'guide.faq.shortcuts.key.space': 'Space',
  'guide.faq.shortcuts.key.rightClick': 'Right-click',

  // ───────────── Landing page /about ─────────────
  'guide.about.meta.title': 'Desk Defense · A tower defense game where you build mazes out of stationery',
  'guide.about.meta.desc':
    'Desk Defense is a free maze tower defense game for the web. Build a maze with pencils, staplers and desk lamps and fight off eraser crumbs, paper planes and coffee stains. 12 towers, 5 forms, Endless Abyss, global leaderboards and a Daily Challenge. Plays on phone and computer, online or offline.',
  'guide.about.skip': 'Skip to content',
  'guide.about.nav.label': 'Page navigation',
  'guide.about.nav.features': 'Features',
  'guide.about.nav.towers': 'Towers',
  'guide.about.nav.how': 'How to play',
  'guide.about.nav.faq': 'FAQ',
  'guide.about.lang.label': 'Language',
  'guide.about.theme.label': 'Appearance',
  'guide.about.theme.auto': 'System',
  'guide.about.theme.light': 'Light',
  'guide.about.theme.dark': 'Dark',
  'guide.about.brand': 'Desk Defense',
  'guide.about.hero.kicker': 'Free · Play right in your browser',
  'guide.about.hero.title': 'Desk Defense',
  'guide.about.hero.tagline': 'Build a maze out of stationery and protect your homework.',
  'guide.about.hero.lead':
    'Pencils, Staplers, Glue Bottles and Desk Lamps form your line of defense against Eraser Crumbs, Paper Planes and Coffee Stains. Towers are walls, so you decide which way the enemies go.',
  'guide.about.hero.play': 'Play now',
  'guide.about.hero.guide': 'Open the Codex',
  'guide.about.hero.note': 'No download or sign-up. Progress is saved on your device.',
  'guide.about.stats.towers': 'towers',
  'guide.about.stats.forms': 'forms',
  'guide.about.stats.enemies': 'enemies and bosses',
  'guide.about.stats.events': 'random events',
  'guide.about.features.title': 'Features',
  'guide.about.feature.maze.title': 'Maze tower defense',
  'guide.about.feature.maze.desc':
    'Place towers freely on a 12 × 14 board, and they block the way. Use 5-gold Book Walls to stretch the path and keep enemies circling inside your line of fire.',
  'guide.about.feature.towers.title': '12 towers, 5 forms',
  'guide.about.feature.towers.desc':
    'Every tower grows from Draft through Fine and Gilded to Legendary, then evolves into Mythic. Legendary offers two paths, A and B, Mythic adds an active ability, and each stage has its own look.',
  'guide.about.feature.field.title': 'Dynamic Battlefield',
  'guide.about.feature.field.desc':
    'Entrances open, boxes drop from above, the lamp trips out and the coffee spills. 23 random events make every run different.',
  'guide.about.feature.endless.title': 'Endless Abyss',
  'guide.about.feature.endless.desc':
    'After the 3 Campaign chapters comes Endless: Easy, Normal, Hard, Nightmare, then Abyss I–X. Elite enemies carry random affixes. How many waves can you survive?',
  'guide.about.feature.online.title': 'Global leaderboards and Daily Challenge',
  'guide.about.feature.online.desc':
    'One desk with a fixed seed every day, and everyone competes on the same map. Every Endless difficulty has its own global leaderboard.',
  'guide.about.feature.ai.title': 'AI Play',
  'guide.about.feature.ai.desc':
    'Plug in your own large language model and let it play a run on its own, or have it advise you while you play. Works with API relays, local models and the Local Bridge.',
  'guide.about.feature.pwa.title': 'Any device, even offline',
  'guide.about.feature.pwa.desc':
    'Play on computer, tablet or phone, in landscape or portrait. Add it to your home screen to run full screen, even without a connection.',
  'guide.about.towers.title': 'Meet your stationery',
  'guide.about.towers.lead': 'Start with a single pencil and grow it all the way to Mythic.',
  'guide.about.towers.evolution': 'The five forms of the Pencil Tower',
  'guide.about.enemies.title': 'And these little troublemakers',
  'guide.about.enemies.lead': 'Eraser Crumbs come in swarms, Paper Planes ignore the maze, and the Coffee Stain disables your towers.',
  'guide.about.how.title': 'How to play',
  'guide.about.how.1.title': 'Build the maze',
  'guide.about.how.1.desc':
    "Enemies always take the shortest path. Stretch it with Book Walls and towers, but you can't block it completely.",
  'guide.about.how.2.title': 'Hold every wave',
  'guide.about.how.2.desc': 'Read the next-wave preview and prepare: slows, armor break and anti-air are all essential.',
  'guide.about.how.3.title': 'Grow your towers',
  'guide.about.how.3.desc':
    'Towers earn XP by fighting, and the more XP they have, the cheaper the upgrade. Pick a legend path when you reach Legendary.',
  'guide.about.how.4.title': 'Take on higher difficulties',
  'guide.about.how.4.desc': 'Unlock talents and skills with stars and ink, then head for the Endless Abyss and the leaderboards.',
  'guide.about.board.alt': "Diagram: Book Walls bend the enemies' route into a zigzag",
  'guide.about.board.caption': 'Towers are walls: the longer the path, the more every tower gets to shoot.',
  'guide.about.faq.title': 'FAQ',
  'guide.about.faq.1.q': 'Do I need to pay or sign up?',
  'guide.about.faq.1.a':
    'No. The game is completely free with no ads. Just open the page and play. Your progress is saved in your browser.',
  'guide.about.faq.2.q': 'Can I play on my phone?',
  'guide.about.faq.2.a':
    'Yes. Phones, tablets and computers all use the same board, and every touch action has a preview and a confirmation. Add it to your home screen to play full screen and offline.',
  'guide.about.faq.3.q': 'How long does a run take?',
  'guide.about.faq.3.a':
    'A Campaign chapter is 20 waves, about 15–25 minutes. If you leave midway the game saves automatically, and you can pick up where you left off.',
  'guide.about.faq.4.q': 'What do I need for AI Play?',
  'guide.about.faq.4.a':
    'Your own model service: an API relay or official API key, or Ollama or LM Studio on your computer. Without a key you can still try the Offline Demo.',
  'guide.about.faq.5.q': 'Which languages are supported?',
  'guide.about.faq.5.a': '简体中文, 繁體中文, English and 日本語. You can switch at any time.',
  'guide.about.cta.title': 'The desk is all set',
  'guide.about.cta.lead': 'Chapter 1 takes just over ten minutes.',
  'guide.about.footer.play': 'Play now',
  'guide.about.footer.guide': 'Codex & How to Play',
  'guide.about.footer.leaderboard': 'Leaderboard',
  'guide.about.footer.label': 'Footer links',
  'guide.about.footer.note': 'Desk Defense, a tower defense game for the web.',
  'guide.enemy.goldbag.behavior':
    'Runs along the route very fast and regenerates quickly after 2s without being hit. Drops a big burst of collectible coins when killed; if it escapes it costs no lives but steals a large chunk of gold.',
  'guide.enemy.goldbag.counter':
    'Focus fire or use burst skills like the Big Eraser to take it down in one go; slows and roots keep it under fire so it never gets a breather to regenerate.',
  'guide.affix.golden.counter':
    'Golden elites are tougher, but drop a pile of coins when killed. Focus them down and remember to tap the coins.',
} satisfies Dict;
