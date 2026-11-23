#!/usr/bin/env node
/**
 * End-to-end run against the deployed LeagueLedger on GenLayer Studio.
 *
 *   node scripts/e2e_studionet.js [contractAddress]
 *
 * Reads real scoreboard pages published at leagueledger-scores.surge.sh.
 * Every write is finalized, then confirmed with a view read. Two negative
 * controls are exercised: a page with no score, and a duplicate match id.
 * No key material is ever written to stdout or to an artifact.
 */
const fs = require("fs");
const path = require("path");
const { createClient, createAccount } = require("genlayer-js");
const { studionet } = require("genlayer-js/chains");

const ROOT = path.resolve(__dirname, "..");
const KEY_PATH = path.join(__dirname, ".league-ledger-keys.json");
const DEPLOY_PATH = path.join(ROOT, "artifacts", "deploy.json");
const E2E_PATH = path.join(ROOT, "artifacts", "e2e.json");
const SNAPSHOT_PATH = path.join(ROOT, "app", "snapshot.js");

const ADDRESS = process.argv[2] || (fs.existsSync(DEPLOY_PATH) && JSON.parse(fs.readFileSync(DEPLOY_PATH, "utf8")).address);
if (!ADDRESS) {
  console.error("usage: node scripts/e2e_studionet.js <contractAddress>");
  process.exit(1);
}
const BASE = process.env.LL_SCORES || "https://leagueledger-scores.surge.sh";
const VERIFY = process.env.LL_VERIFY === "1";
const VERIFY_TXS = (process.env.LL_TXS || "").split(",").map((s) => s.trim()).filter(Boolean);
const SEASON_ID = process.env.LL_SEASON || `demo-${Date.now().toString(36)}`;
const TEAMS = ["Northside", "Riverside", "Eastgate"];

const keys = JSON.parse(fs.readFileSync(KEY_PATH, "utf8"));
const client = createClient({ chain: studionet, account: createAccount(keys.creator) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATE_LIMIT = /rate limit|-32029/i;
const HICCUP = /DOCTYPE|fetch failed|ECONNRESET|timeout|temporarily unavailable|not available/i;
const hashes = [];
const record = { address: ADDRESS, seasonId: SEASON_ID, scoreboardBase: BASE, writes: [] };

async function retrying(label, fn, attempts = 30) {
  let last;
  for (let n = 0; n < attempts; n += 1) {
    try {
      return await fn();
    } catch (error) {
      const message = String((error && error.message) || error);
      if (RATE_LIMIT.test(message)) {
        console.log(`  ${label}: studio rate limit reached; stopping retries`);
        throw error;
      }
      if (!HICCUP.test(message)) throw error;
      last = error;
      console.log(`  ${label}: rpc hiccup, retry ${n + 1} in 6s`);
      await sleep(6000);
    }
  }
  throw last;
}

function decode(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (_) {
      return value;
    }
  }
  return value;
}

function leaderFailed(receipt) {
  const leader = (receipt.consensus_data && receipt.consensus_data.leader_receipt) || [];
  return String(leader[0] && leader[0].execution_result).toUpperCase() === "ERROR";
}

async function read(fn, args) {
  return decode(await retrying(`read ${fn}`, () =>
    client.readContract({ address: ADDRESS, functionName: fn, args })
  ));
}

async function write(fn, args, expect = "success") {
  console.log(`\n[write] ${fn}(${JSON.stringify(args).slice(0, 180)})`);
  const hash = await retrying(`send ${fn}`, () =>
    client.writeContract({ address: ADDRESS, functionName: fn, args, value: 0n })
  );
  hashes.push(hash);
  console.log(`  tx ${hash}`);
  const receipt = await retrying(`receipt ${fn}`, () =>
    client.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 160, interval: 5000 })
  );
  const failed = leaderFailed(receipt);
  console.log(`  finalized ${receipt.status_name || receipt.status} - ${failed ? "contract refused" : "executed"}`);
  record.writes.push({ functionName: fn, hash, refused: failed });
  if (expect === "refuse" && !failed) throw new Error(`${fn} should have been refused`);
  if (expect === "success" && failed) throw new Error(`${fn} was refused by the contract`);
  return hash;
}

function summary(row) {
  return `${row.home} ${row.home_goals}-${row.away_goals} ${row.away} (${row.outcome})`;
}

(async () => {
  if (VERIFY) {
    console.log(`[verify] reading closed season ${SEASON_ID} from ${ADDRESS}`);
    const season = await read("get_season", [SEASON_ID]);
    const standings = await read("get_standings", [SEASON_ID]);
    const rows = await read("results_of", [SEASON_ID]);
    const medals = await read("medals", [SEASON_ID]);
    const stats = await read("stats", []);
    const got = [medals.champion, medals.silver, medals.bronze];
    if (season.status !== "closed") throw new Error("season is not closed");
    if (rows.length !== 3) throw new Error(`expected 3 results, found ${rows.length}`);
    if (JSON.stringify(got) !== JSON.stringify(["Northside", "Riverside", "Eastgate"])) {
      throw new Error(`medals mismatch: ${JSON.stringify(got)}`);
    }
    if (standings[0].team !== "Northside") throw new Error("unexpected champion in the table");
    const labels = [
      "register_season", "submit_result", "submit_result", "submit_result",
      "submit_result", "submit_result", "close_season",
    ];
    record.writes = VERIFY_TXS.map((hash, i) => ({
      functionName: labels[i] || "submit_result", hash, refused: i === 4 || i === 5,
    }));
    record.champion = medals.champion;
    record.medals = { gold: medals.champion, silver: medals.silver, bronze: medals.bronze };
    record.standings = standings;
    record.results = rows.map((row) => ({
      match_id: row.match_id, home: row.home, away: row.away,
      home_goals: row.home_goals, away_goals: row.away_goals, outcome: row.outcome,
    }));
    record.stats = stats;
    record.readAt = new Date().toISOString();
    record.verifyMode = true;
    fs.mkdirSync(path.dirname(E2E_PATH), { recursive: true });
    fs.writeFileSync(E2E_PATH, JSON.stringify(record, null, 2) + "\n");
    const snapshot = {
      readAt: record.readAt, address: ADDRESS, season, standings,
      results: record.results, medals: record.medals, stats,
    };
    fs.writeFileSync(
      SNAPSHOT_PATH,
      `// Generated from a live readContract run on ${record.readAt}. Do not edit by hand.\n` +
        `window.LEAGUE_LEDGER_SNAPSHOT = ${JSON.stringify(snapshot, null, 2)};\n`
    );
    console.log("medals", got.join(" / "), "| results", rows.length, "| status", season.status);
    console.log(`\nRESULT e2e_verify_ok address=${ADDRESS} season=${SEASON_ID} champion=${medals.champion} writes=${VERIFY_TXS.length}`);
    VERIFY_TXS.forEach((hash, i) => console.log(`TX${i + 1} ${hash}`));
    return;
  }

  const pages = ["round-1.html", "round-2.html", "round-3.html", "malformed.html"];
  for (const page of pages) {
    const response = await fetch(`${BASE}/${page}`);
    if (!response.ok) throw new Error(`scoreboard ${page} returned HTTP ${response.status}`);
    const text = await response.text();
    if (!text || text.trim().length < 40) throw new Error(`scoreboard ${page} is empty`);
  }
  console.log(`scoreboards live at ${BASE}`);

  const before = await read("stats", []);
  console.log("initial stats", JSON.stringify(before));

  await write("register_season", [
    SEASON_ID, "City League Demo", JSON.stringify(TEAMS), 3, 1, 0, "H2H_GD_EARLIEST",
  ]);
  const season = await read("get_season", [SEASON_ID]);
  if (season.season_id !== SEASON_ID || season.status !== "open") {
    throw new Error(`registration did not apply: ${JSON.stringify(season)}`);
  }
  console.log("registered", season.name, season.teams.join(" / "), "tie order", season.tie_order);

  const fixtures = [
    ["r1", "Northside", "Riverside", "round-1.html", "HOME_WIN", 2, 0],
    ["r2", "Riverside", "Eastgate", "round-2.html", "DRAW", 1, 1],
    ["r3", "Eastgate", "Northside", "round-3.html", "AWAY_WIN", 0, 3],
  ];
  for (const [id, home, away, page, outcome, hg, ag] of fixtures) {
    await write("submit_result", [SEASON_ID, id, home, away, `${BASE}/${page}`]);
    const stored = await read("get_result", [SEASON_ID, id]);
    if (stored.outcome !== outcome || stored.home_goals !== hg || stored.away_goals !== ag) {
      throw new Error(`result ${id} mismatch: ${JSON.stringify(stored)}`);
    }
    console.log("confirmed", id, summary(stored));
  }

  const rowsBefore = await read("results_of", [SEASON_ID]);
  if (rowsBefore.length !== 3) throw new Error(`expected 3 results, got ${rowsBefore.length}`);

  // Negative control 1: a live page with no final score.
  await write("submit_result", [SEASON_ID, "broken", "Northside", "Eastgate", `${BASE}/malformed.html`], "refuse");
  // Negative control 2: a result already recorded under the same match id.
  await write("submit_result", [SEASON_ID, "r1", "Northside", "Riverside", `${BASE}/round-1.html`], "refuse");
  const rowsAfter = await read("results_of", [SEASON_ID]);
  if (rowsAfter.length !== 3) throw new Error(`a refused write changed the table: ${rowsAfter.length} results`);
  console.log("both refusals left the ledger at 3 recorded results");

  const liveTable = await read("get_standings", [SEASON_ID]);
  console.log("standings", liveTable.map((r) => `${r.rank}.${r.team} ${r.points}pts ${r.gd >= 0 ? "+" : ""}${r.gd}`).join("  "));
  if (liveTable[0].team !== "Northside") throw new Error("unexpected live champion");

  await write("close_season", [SEASON_ID]);
  const medals = await read("medals", [SEASON_ID]);
  const expected = ["Northside", "Riverside", "Eastgate"];
  const got = [medals.champion, medals.silver, medals.bronze];
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    throw new Error(`medals mismatch: ${JSON.stringify(got)}`);
  }
  console.log("medals", got.join(" / "));

  const finalSeason = await read("get_season", [SEASON_ID]);
  const finalStats = await read("stats", []);
  const results = await read("results_of", [SEASON_ID]);
  if (finalSeason.status !== "closed") throw new Error("season was not closed");

  record.champion = medals.champion;
  record.medals = { gold: medals.champion, silver: medals.silver, bronze: medals.bronze };
  record.standings = medals.standings;
  record.results = results.map((row) => ({
    match_id: row.match_id, home: row.home, away: row.away,
    home_goals: row.home_goals, away_goals: row.away_goals, outcome: row.outcome,
  }));
  record.stats = finalStats;
  record.readAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(E2E_PATH), { recursive: true });
  fs.writeFileSync(E2E_PATH, JSON.stringify(record, null, 2) + "\n");

  const snapshot = {
    readAt: record.readAt,
    address: ADDRESS,
    season: finalSeason,
    standings: medals.standings,
    results: record.results,
    medals: record.medals,
    stats: finalStats,
  };
  fs.writeFileSync(
    SNAPSHOT_PATH,
    `// Generated from a live readContract run on ${record.readAt}. Do not edit by hand.\n` +
      `window.LEAGUE_LEDGER_SNAPSHOT = ${JSON.stringify(snapshot, null, 2)};\n`
  );

  console.log(`\nRESULT e2e_ok address=${ADDRESS} season=${SEASON_ID} champion=${medals.champion} writes=${hashes.length}`);
  hashes.forEach((hash, i) => console.log(`TX${i + 1} ${hash}`));
})().catch((error) => {
  console.error("FAILED:", error.message);
  console.error("completed tx hashes:", hashes.join(" "));
  process.exit(1);
});
