import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const ADDRESS = "0x54bD8Fb18914b2ed5dEF4E91fa653aB5EA6B88Fe";
const CACHE_KEY = `leagueledger.cache.${ADDRESS.toLowerCase()}`;
const ACCOUNT_KEY = "leagueledger.desk.key";
const RATE_LIMIT = /rate limit|-32029/i;

const $ = (id) => document.getElementById(id);
const explorerTx = (hash) => `https://explorer-studio.genlayer.com/tx/${hash}`;

function account() {
  let key = localStorage.getItem(ACCOUNT_KEY);
  if (!key) {
    key = generatePrivateKey();
    localStorage.setItem(ACCOUNT_KEY, key);
  }
  return createAccount(key);
}

const desk = account();
const client = createClient({ chain: studionet, account: desk });

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

async function read(name, args = []) {
  return decode(await client.readContract({ address: ADDRESS, functionName: name, args }));
}

function readCached() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function showBanner(text) {
  $("banner-text").textContent = text;
  $("banner").classList.add("show");
}

function hideBanner() {
  $("banner").classList.remove("show");
  $("banner-text").textContent = "";
}

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined && text !== null) item.textContent = String(text);
  return item;
}

function clear(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function signed(value) {
  const number = Number(value) || 0;
  return number > 0 ? `+${number}` : String(number);
}

function renderStandings(rows) {
  const body = $("standings-body");
  clear(body);
  if (!Array.isArray(rows) || rows.length === 0) {
    const tr = node("tr");
    const td = node("td", "empty", "No standings recorded yet. Register a season and read a scoreboard.");
    td.colSpan = 10;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  rows.forEach((row) => {
    const tr = node("tr", Number(row.rank) === 1 ? "leader" : "");
    tr.appendChild(node("td", "", ""));
    tr.firstChild.appendChild(node("span", "rank", row.rank));
    const team = node("td", "team", row.team);
    team.appendChild(node("span", "sub", `  ${row.wins}-${row.draws}-${row.losses}`));
    tr.appendChild(team);
    for (const key of ["played", "wins", "draws", "losses", "gf", "ga"]) {
      tr.appendChild(node("td", "", row[key]));
    }
    tr.appendChild(node("td", "", signed(row.gd)));
    tr.appendChild(node("td", "pts", row.points));
    body.appendChild(tr);
  });
}

function renderPodium(medals, season) {
  const podium = $("podium");
  clear(podium);
  const names = [
    ["gold", "1", medals && medals.champion],
    ["silver", "2", medals && medals.silver],
    ["bronze", "3", medals && medals.bronze],
  ];
  const any = names.some((entry) => entry[2]);
  if (!any) {
    podium.appendChild(node("div", "empty", "No medals yet. Closing a season writes them on chain."));
  } else {
    names.forEach(([tone, place, name]) => {
      if (!name) return;
      const box = node("div", `medal ${tone}`);
      box.appendChild(node("div", "disc", place));
      const text = node("div");
      text.appendChild(node("b", "", name));
      text.appendChild(node("small", "", place === "1" ? "Champion" : place === "2" ? "Silver" : "Bronze"));
      box.appendChild(text);
      podium.appendChild(box);
    });
  }
  $("season-status").textContent = season ? season.status : "—";
  $("tie-note").textContent = season
    ? `Tie order: ${season.tie_order.replaceAll("_", " ").toLowerCase()} · ${season.win_points}/${season.draw_points}/${season.loss_points} points`
    : "Tie order is fixed when the season opens.";
}

function renderFeed(rows) {
  const feed = $("feed");
  clear(feed);
  if (!Array.isArray(rows) || rows.length === 0) {
    feed.appendChild(node("div", "empty", "No results recorded yet."));
    $("result-count").textContent = "0 results";
    return;
  }
  rows.forEach((row) => {
    const item = node("div", "match");
    item.appendChild(node("div", "home", row.home));
    item.appendChild(node("div", "score", `${row.home_goals} : ${row.away_goals}`));
    item.appendChild(node("div", "away", row.away));
    item.appendChild(node("span", "tag", String(row.outcome).replaceAll("_", " ").toLowerCase()));
    if (row.scoreboard_url) {
      const link = node("a", "", "evidence ↗");
      link.href = row.scoreboard_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      item.appendChild(link);
    }
    feed.appendChild(item);
  });
  $("result-count").textContent = `${rows.length} result${rows.length === 1 ? "" : "s"}`;
}

function render(snapshot, source) {
  const stamp = snapshot && snapshot.readAt ? new Date(snapshot.readAt) : null;
  const when = stamp && !Number.isNaN(stamp.getTime()) ? stamp.toISOString().replace("T", " ").slice(0, 19) + " UTC" : "unknown";
  const label = source === "live" ? "Live read" : source === "cache" ? "Last saved read" : "Build snapshot";
  $("data-stamp").textContent = `${label} · ${when}`;
  renderStandings(snapshot && snapshot.standings);
  renderPodium(snapshot && snapshot.medals, snapshot && snapshot.season);
  renderFeed(snapshot && snapshot.results);
  const stats = snapshot && snapshot.stats;
  if (stats) $("result-count").textContent = `${stats.results || 0} results in ${stats.seasons || 0} season(s)`;
}

async function loadLive(preferredSeasonId) {
  const [seasons, stats] = await Promise.all([read("list_seasons"), read("stats")]);
  const list = Array.isArray(seasons) ? seasons : [];
  const season = list.find((s) => s.season_id === preferredSeasonId) || list[list.length - 1] || null;
  let standings = [];
  let rows = [];
  let medals = null;
  if (season) {
    const triple = await Promise.all([
      read("get_standings", [season.season_id]),
      read("results_of", [season.season_id]),
      read("medals", [season.season_id]),
    ]);
    standings = triple[0] || [];
    rows = triple[1] || [];
    medals = triple[2];
  }
  const snapshot = { readAt: new Date().toISOString(), season, standings, results: rows, medals, stats };
  localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
  return snapshot;
}

async function refresh(preferredSeasonId) {
  try {
    const snapshot = await loadLive(preferredSeasonId);
    hideBanner();
    render(snapshot, "live");
    return snapshot;
  } catch (error) {
    const message = String((error && error.message) || error);
    if (RATE_LIMIT.test(message)) {
      showBanner("The public Studio RPC is rate limited. Showing the last saved read; try again later.");
    } else {
      showBanner(`Live read failed: ${message.slice(0, 180)}`);
    }
    const cached = readCached();
    if (cached) render(cached, "cache");
    return null;
  }
}

function leaderFailed(receipt) {
  const leader = (receipt && receipt.consensus_data && receipt.consensus_data.leader_receipt) || [];
  return String(leader[0] && leader[0].execution_result).toUpperCase() === "ERROR";
}

async function submitWrite(name, args) {
  const line = $("tx-line");
  line.textContent = `Waiting for ${name} to finalize on Studio…`;
  const hash = await client.writeContract({ address: ADDRESS, functionName: name, args, value: 0n });
  line.textContent = `Submitted ${hash}. Waiting for FINALIZED…`;
  const receipt = await client.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 160, interval: 5000 });
  if (leaderFailed(receipt)) throw new Error(`${name} was refused by the contract`);
  const link = document.createElement("a");
  link.href = explorerTx(hash);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = `${name} tx ${hash.slice(0, 12)}… ↗`;
  clear(line);
  line.appendChild(document.createTextNode("Last write: "));
  line.appendChild(link);
  return hash;
}

function wireForm(id, handler) {
  const form = $(id);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(form).entries());
      await handler(values, form);
    } catch (error) {
      showBanner(`Write failed: ${String((error && error.message) || error).slice(0, 200)}`);
    } finally {
      button.disabled = false;
    }
  });
}

wireForm("register-form", async (values) => {
  const teams = values.teams.split(",").map((part) => part.trim()).filter(Boolean);
  await submitWrite("register_season", [values.seasonId.trim(), values.name.trim(), JSON.stringify(teams), 3, 1, 0, values.tie]);
  await refresh(values.seasonId.trim());
});

wireForm("result-form", async (values) => {
  await submitWrite("submit_result", [
    values.seasonId.trim(), values.matchId.trim(), values.home.trim(), values.away.trim(), values.url.trim(),
  ]);
  await refresh(values.seasonId.trim());
});

$("retry").addEventListener("click", () => refresh());

$("contract-chip").textContent = `contract ${ADDRESS.slice(0, 8)}…${ADDRESS.slice(-6)}`;
$("explorer-link").href = `https://explorer-studio.genlayer.com/address/${ADDRESS}`;
$("account-line").textContent = `Desk account: ${desk.address}`;

const snapshot = window.LEAGUE_LEDGER_SNAPSHOT;
if (snapshot) render(snapshot, "snapshot");
refresh(snapshot && snapshot.season && snapshot.season.season_id);
