// ═══════════════════════════════════════════════════════
// collector.js — Background match harvester
// Stores matches as JSON Lines files (one JSON per line)
// Run: node collector.js
// ═══════════════════════════════════════════════════════

const axios = require("axios");
const fs = require("fs");
const path = require("path");

const RIOT_API_KEY = process.env.RIOT_API_KEY || "YOUR_API_KEY_HERE";
const REGION = "americas";
const PLATFORM = "na1";

const REQUEST_DELAY = 1500;
const CYCLE_PAUSE = 1000 * 60 * 5; // 5 min between cycles
const MATCHES_PER_PLAYER = 10;
const PLAYERS_PER_CYCLE = 40;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── File paths ───
const DATA_DIR = path.join(__dirname, "data");
const MATCHES_FILE = path.join(DATA_DIR, "matches.jsonl");     // one match JSON per line
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");
const SEEN_FILE = path.join(DATA_DIR, "seen_matches.json");    // set of match IDs already fetched
const STATS_FILE = path.join(DATA_DIR, "collector_stats.json");

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ─── Load state ───
let players = [];
try { players = JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8")); } catch (e) {}

let seenMatches = new Set();
try { seenMatches = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"))); } catch (e) {}

let requestCount = 0;
let totalNewMatches = 0;

// ─── Riot API helper ───
async function riotGet(url) {
  requestCount++;
  const res = await axios.get(url, { headers: { "X-Riot-Token": RIOT_API_KEY } });
  await sleep(REQUEST_DELAY);
  return res.data;
}

// ─── Save helpers ───
function savePlayers() { fs.writeFileSync(PLAYERS_FILE, JSON.stringify(players, null, 0)); }
function saveSeen() { fs.writeFileSync(SEEN_FILE, JSON.stringify([...seenMatches])); }
function appendMatch(matchData) {
  fs.appendFileSync(MATCHES_FILE, JSON.stringify(matchData) + "\n");
}
function saveStats() {
  const matchCount = seenMatches.size;
  fs.writeFileSync(STATS_FILE, JSON.stringify({
    totalMatches: matchCount,
    totalPlayers: players.length,
    apiRequests: requestCount,
    lastUpdate: new Date().toISOString(),
  }));
}

// ─── Phase 1: Discover players ───
async function discoverPlayers() {
  console.log("\n[Discover] Fetching player lists...");
  const existing = new Set(players.map(p => p.puuid));
  let added = 0;

  const addEntries = (entries, tier) => {
    let count = 0;
    for (const e of entries) {
      const puuid = e.puuid;
      if (!puuid || existing.has(puuid)) continue;
      players.push({ puuid, tier, lp: e.leaguePoints || 0, lastFetched: 0 });
      existing.add(puuid);
      count++;
      added++;
    }
    return count;
  };

  // Challenger
  try {
    const data = await riotGet(`https://${PLATFORM}.api.riotgames.com/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5`);
    const n = addEntries(data.entries, "CHALLENGER");
    console.log(`  Challenger: ${data.entries.length} (${n} new)`);
  } catch (e) { console.warn("  Challenger:", e.message); }

  // Grandmaster
  try {
    const data = await riotGet(`https://${PLATFORM}.api.riotgames.com/lol/league/v4/grandmasterleagues/by-queue/RANKED_SOLO_5x5`);
    const n = addEntries(data.entries, "GRANDMASTER");
    console.log(`  Grandmaster: ${data.entries.length} (${n} new)`);
  } catch (e) { console.warn("  Grandmaster:", e.message); }

  // Master
  try {
    const data = await riotGet(`https://${PLATFORM}.api.riotgames.com/lol/league/v4/masterleagues/by-queue/RANKED_SOLO_5x5`);
    const n = addEntries(data.entries, "MASTER");
    console.log(`  Master: ${data.entries.length} (${n} new)`);
  } catch (e) { console.warn("  Master:", e.message); }

  // Diamond I-IV
  for (const div of ["I", "II", "III", "IV"]) {
    for (let page = 1; page <= 2; page++) {
      try {
        const data = await riotGet(`https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/RANKED_SOLO_5x5/DIAMOND/${div}?page=${page}`);
        if (data.length === 0) break;
        const n = addEntries(data, "DIAMOND");
        console.log(`  Diamond ${div} p${page}: ${data.length} (${n} new)`);
      } catch (e) { console.warn(`  Diamond ${div} p${page}:`, e.message); break; }
    }
  }

  savePlayers();
  console.log(`[Discover] Total players: ${players.length} (${added} new this cycle)`);
}

// ─── Phase 2: Check puuids ───
async function checkPuuids() {
  const withPuuid = players.filter(p => p.puuid);
  const without = players.length - withPuuid.length;
  if (without > 0) console.log(`[Puuids] ${withPuuid.length} players with puuid, ${without} without (skipped)`);
  else console.log(`[Puuids] All ${players.length} players have puuids`);
}

// ─── Phase 3: Collect matches ───
async function collectMatches() {
  const ready = players.filter(p => p.puuid).sort((a, b) => a.lastFetched - b.lastFetched).slice(0, PLAYERS_PER_CYCLE);
  if (ready.length === 0) { console.log("[Collect] No players with puuids yet"); return; }

  console.log(`\n[Collect] Processing ${ready.length} players...`);
  let newMatches = 0, skipped = 0;

  for (const p of ready) {
    try {
      const matchIds = await riotGet(
        `https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${p.puuid}/ids?count=${MATCHES_PER_PLAYER}&type=ranked`
      );

      for (const matchId of matchIds) {
        if (seenMatches.has(matchId)) { skipped++; continue; }

        try {
          const matchData = await riotGet(`https://${REGION}.api.riotgames.com/lol/match/v5/matches/${matchId}`);
          appendMatch(matchData);
          seenMatches.add(matchId);
          newMatches++;
          totalNewMatches++;
        } catch (e) {
          if (e.response?.status === 429) { console.warn("[Collect] Rate limited, pausing 15s..."); await sleep(15000); }
        }
      }

      p.lastFetched = Date.now();
    } catch (e) {
      if (e.response?.status === 429) { console.warn("[Collect] Rate limited, pausing 15s..."); await sleep(15000); }
      else { p.lastFetched = Date.now(); } // skip on other errors
    }
  }

  savePlayers();
  saveSeen();
  console.log(`[Collect] New: ${newMatches} | Skipped: ${skipped}`);
}

// ─── Main loop ───
async function run() {
  console.log("═══════════════════════════════════════");
  console.log("  LoL Match Collector — Diamond+");
  console.log("  Data dir: " + DATA_DIR);
  console.log("  Press Ctrl+C to stop");
  console.log("═══════════════════════════════════════\n");

  let cycle = 0;
  while (true) {
    cycle++;
    console.log(`\n━━━ Cycle ${cycle} at ${new Date().toLocaleTimeString()} ━━━`);

    if (cycle === 1 || cycle % 10 === 0) await discoverPlayers();
    await checkPuuids();
    await collectMatches();

    saveStats();
    console.log(`\n  📊 Total matches: ${seenMatches.size} | Players: ${players.length} | API calls: ${requestCount}`);
    console.log(`  Pausing ${CYCLE_PAUSE / 1000}s...\n`);
    await sleep(CYCLE_PAUSE);
  }
}

run().catch(e => { console.error("Fatal:", e); process.exit(1); });
