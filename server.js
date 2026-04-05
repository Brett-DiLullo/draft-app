// ═══════════════════════════════════════════════════════
// server.js — Reads match data from data/matches.jsonl
// Falls back to live Riot API if no data collected yet
// ═══════════════════════════════════════════════════════

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.static("public"));

const RIOT_API_KEY = process.env.RIOT_API_KEY || "YOUR_API_KEY_HERE";
const REGION = "americas";
const PLATFORM = "na1";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── File paths ───
const DATA_DIR = path.join(__dirname, "data");
const MATCHES_FILE = path.join(DATA_DIR, "matches.jsonl");
const STATS_FILE = path.join(DATA_DIR, "collector_stats.json");

// ─── Cache ───
let cache = null;
let lastBuild = 0;
let lastFileSize = 0;
const CACHE_TIME = 1000 * 60 * 2; // rebuild every 2 min (cheap since it's local file)

// ─── Data Dragon ───
let itemMap = {};
let runeMap = {};
let runeTreeMap = {};

async function fetchDataDragon() {
  try {
    console.log("Fetching Data Dragon...");
    const vRes = await axios.get("https://ddragon.leagueoflegends.com/api/versions.json");
    const version = vRes.data[0];
    const itemRes = await axios.get(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/item.json`);
    for (const [id, item] of Object.entries(itemRes.data.data)) {
      itemMap[id] = { name: item.name, isBoots: !!(item.tags && item.tags.includes("Boots") && item.gold && item.gold.total > 300) };
    }
    const runeRes = await axios.get(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/runesReforged.json`);
    for (const tree of runeRes.data) {
      runeTreeMap[tree.id] = tree.name;
      for (const slot of tree.slots) { for (const rune of slot.runes) { runeMap[rune.id] = rune.name; } }
    }
    console.log(`Data Dragon: ${Object.keys(itemMap).length} items, ${Object.keys(runeMap).length} runes`);
  } catch (e) { console.error("Data Dragon failed:", e.message); }
}

// ─── Read matches from JSONL file ───
function loadMatches() {
  if (!fs.existsSync(MATCHES_FILE)) return [];
  const content = fs.readFileSync(MATCHES_FILE, "utf8");
  const lines = content.trim().split("\n").filter(l => l.length > 0);
  const matches = [];
  for (const line of lines) {
    try { matches.push(JSON.parse(line)); } catch (e) { /* skip bad lines */ }
  }
  return matches;
}

// ─── Stat builder ───
function buildStats(matches) {
  const stats = {};
  const laneMatchups = {};

  for (const match of matches) {
    const participants = match.info?.participants;
    if (!participants) continue;

    const teamDmg = { 100: { ad: 0, ap: 0 }, 200: { ad: 0, ap: 0 } };
    for (const p of participants) {
      const dmg = (p.physicalDamageDealtToChampions || 0) > (p.magicDamageDealtToChampions || 0) ? "ad" : "ap";
      if (teamDmg[p.teamId]) teamDmg[p.teamId][dmg]++;
    }

    for (const p of participants) {
      const champ = p.championName;
      const role = p.teamPosition || "UNKNOWN";
      const enemyTeamId = p.teamId === 100 ? 200 : 100;

      if (!stats[champ]) {
        stats[champ] = {
          totalGames: 0, totalWins: 0, roles: {}, vs: {},
          items: {}, boots: {},
          keystones: {}, secondaryTrees: {}, secondaryRunes: {},
          itemsVsHeavyAD: {}, itemsVsHeavyAP: {},
          keystonesVsHeavyAD: {}, keystonesVsHeavyAP: {},
        };
      }

      const s = stats[champ];
      s.totalGames++;
      if (p.win) s.totalWins++;
      if (!s.roles[role]) s.roles[role] = { games: 0, wins: 0 };
      s.roles[role].games++;
      if (p.win) s.roles[role].wins++;

      // Items
      const rawItems = [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6].filter(id => id > 0);
      const heavyAD = teamDmg[enemyTeamId] ? teamDmg[enemyTeamId].ad >= 3 : false;
      const heavyAP = teamDmg[enemyTeamId] ? teamDmg[enemyTeamId].ap >= 3 : false;

      for (const id of rawItems) {
        const info = itemMap[id];
        if (!info) continue;
        if (info.isBoots) { s.boots[info.name] = (s.boots[info.name] || 0) + 1; }
        else {
          s.items[info.name] = (s.items[info.name] || 0) + 1;
          if (heavyAD) s.itemsVsHeavyAD[info.name] = (s.itemsVsHeavyAD[info.name] || 0) + 1;
          if (heavyAP) s.itemsVsHeavyAP[info.name] = (s.itemsVsHeavyAP[info.name] || 0) + 1;
        }
      }

      // Runes
      const perks = p.perks;
      if (perks?.styles?.length >= 2) {
        const keystoneId = perks.styles[0]?.selections?.[0]?.perk;
        if (keystoneId && runeMap[keystoneId]) {
          const kn = runeMap[keystoneId];
          s.keystones[kn] = (s.keystones[kn] || 0) + 1;
          if (heavyAD) s.keystonesVsHeavyAD[kn] = (s.keystonesVsHeavyAD[kn] || 0) + 1;
          if (heavyAP) s.keystonesVsHeavyAP[kn] = (s.keystonesVsHeavyAP[kn] || 0) + 1;
        }
        const secId = perks.styles[1]?.style;
        if (secId && runeTreeMap[secId]) s.secondaryTrees[runeTreeMap[secId]] = (s.secondaryTrees[runeTreeMap[secId]] || 0) + 1;
        for (const sel of (perks.styles[1]?.selections || [])) {
          if (runeMap[sel.perk]) s.secondaryRunes[runeMap[sel.perk]] = (s.secondaryRunes[runeMap[sel.perk]] || 0) + 1;
        }
      }

      // Matchups
      for (const enemy of participants) {
        if (enemy.teamId !== p.teamId) {
          const ec = enemy.championName, er = enemy.teamPosition || "UNKNOWN";
          if (!s.vs[ec]) s.vs[ec] = { games: 0, wins: 0 };
          s.vs[ec].games++;
          if (p.win) s.vs[ec].wins++;
          if (role === er && role !== "UNKNOWN") {
            const key = `${role}|${champ}|${ec}`;
            if (!laneMatchups[key]) laneMatchups[key] = { wins: 0, games: 0 };
            laneMatchups[key].games++;
            if (p.win) laneMatchups[key].wins++;
          }
        }
      }
    }
  }

  // Finalize
  const result = { champions: {}, laneMatchups: {}, totalMatches: matches.length };
  const sortTop = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));

  for (const champ in stats) {
    const s = stats[champ];
    if (s.totalGames < 1) continue;
    const totalWR = (s.totalWins / s.totalGames) * 100;
    let bestRole = null, bestGames = 0;
    for (const r in s.roles) { if (s.roles[r].games > bestGames) { bestGames = s.roles[r].games; bestRole = r; } }
    const rd = s.roles[bestRole] || { games: 0, wins: 0 };
    const wr = rd.games > 0 ? (rd.wins / rd.games) * 100 : totalWR;
    const counters = [], strongAgainst = [];
    for (const e in s.vs) { const m = s.vs[e]; if (m.games < 3) continue; const r = m.wins / m.games; if (r < 0.45) counters.push(e); if (r > 0.55) strongAgainst.push(e); }

    result.champions[champ] = {
      winrate: Math.round(wr * 10) / 10, pickrate: s.totalGames,
      role: bestRole, roles: s.roles, counters, strongAgainst,
      build: {
        games: s.totalGames,
        items: sortTop(s.items, 10), boots: sortTop(s.boots, 3),
        keystones: sortTop(s.keystones, 3),
        secondaryTrees: sortTop(s.secondaryTrees, 3),
        secondaryRunes: sortTop(s.secondaryRunes, 6),
        itemsVsHeavyAD: sortTop(s.itemsVsHeavyAD, 5),
        itemsVsHeavyAP: sortTop(s.itemsVsHeavyAP, 5),
        keystonesVsHeavyAD: sortTop(s.keystonesVsHeavyAD, 2),
        keystonesVsHeavyAP: sortTop(s.keystonesVsHeavyAP, 2),
      }
    };
  }

  for (const key in laneMatchups) {
    const m = laneMatchups[key]; if (m.games < 2) continue;
    const [role, champ, enemy] = key.split("|");
    if (!result.laneMatchups[champ]) result.laneMatchups[champ] = {};
    result.laneMatchups[champ][enemy] = { role, wins: m.wins, games: m.games, winrate: Math.round((m.wins / m.games) * 1000) / 10 };
  }

  return result;
}

// ─── Live fetch fallback ───
async function liveFetch() {
  console.log("No stored data, doing live fetch...");
  const headers = { "X-Riot-Token": RIOT_API_KEY };

  let entries = [];
  try {
    const res = await axios.get(`https://${PLATFORM}.api.riotgames.com/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5`, { headers });
    entries = res.data.entries.filter(e => e.puuid).slice(0, 10);
  } catch (e) { console.error("Failed:", e.message); return null; }

  let matchIds = [];
  for (const p of entries) {
    try {
      const res = await axios.get(`https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${p.puuid}/ids?count=5`, { headers });
      matchIds.push(...res.data); await sleep(1500);
    } catch (e) {}
  }
  matchIds = [...new Set(matchIds)];

  const matches = [];
  for (const id of matchIds.slice(0, 50)) {
    try {
      const res = await axios.get(`https://${REGION}.api.riotgames.com/lol/match/v5/matches/${id}`, { headers });
      matches.push(res.data); await sleep(1500);
    } catch (e) {}
  }

  return matches.length > 0 ? buildStats(matches) : null;
}

// ─── API Endpoints ───
app.get("/api/stats", async (req, res) => {
  try {
    const now = Date.now();

    // Check if file changed since last build
    let fileSize = 0;
    try { fileSize = fs.statSync(MATCHES_FILE).size; } catch (e) {}
    const fileChanged = fileSize !== lastFileSize;

    if (cache && !fileChanged && now - lastBuild < CACHE_TIME) return res.json(cache);

    // Try reading from collected data
    const matches = loadMatches();
    if (matches.length > 0) {
      console.log(`Building stats from ${matches.length} stored matches...`);
      cache = buildStats(matches);
      lastBuild = now;
      lastFileSize = fileSize;
      return res.json(cache);
    }

    // Fallback
    const stats = await liveFetch();
    if (!stats) return res.status(503).json({ error: "No data. Run: node collector.js" });
    cache = stats; lastBuild = now;
    res.json(stats);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Error building stats" });
  }
});

app.get("/api/health", (req, res) => {
  let matchCount = 0;
  try { matchCount = loadMatches().length; } catch (e) {}

  let collectorStats = null;
  try { collectorStats = JSON.parse(fs.readFileSync(STATS_FILE, "utf8")); } catch (e) {}

  res.json({
    status: "ok",
    storedMatches: matchCount,
    collector: collectorStats,
    cache: { active: !!cache, champions: cache ? Object.keys(cache.champions).length : 0 },
    dataDragon: { items: Object.keys(itemMap).length, runes: Object.keys(runeMap).length },
  });
});

const PORT = process.env.PORT || 3001;
fetchDataDragon().then(() => {
  app.listen(PORT, () => {
    const mc = loadMatches().length;
    console.log(`\nDraft Assistant on http://localhost:${PORT}`);
    console.log(`Stored matches: ${mc}`);
    if (mc === 0) console.log("→ Run 'node collector.js' in another terminal to start collecting!");
    else console.log(`→ Serving stats from ${mc} matches`);
  });
});
