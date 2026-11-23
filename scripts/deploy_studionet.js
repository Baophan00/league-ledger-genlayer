#!/usr/bin/env node
/**
 * Deploy LeagueLedger to GenLayer Studio Network and verify the bytecode.
 *
 *   node scripts/deploy_studionet.js
 *
 * The deploy key is generated once into scripts/.league-ledger-keys.json with
 * mode 0600. That file is gitignored and is never read into the log.
 * The full receipt is persisted to artifacts/deploy.json: stdout is not a
 * durable evidence store during a long run.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { createClient, createAccount, generatePrivateKey } = require("genlayer-js");
const { studionet } = require("genlayer-js/chains");

const ROOT = path.resolve(__dirname, "..");
const KEY_PATH = path.join(__dirname, ".league-ledger-keys.json");
const SOURCE_PATH = path.join(ROOT, "contracts", "league_ledger.py");
const ARTIFACT_PATH = path.join(ROOT, "artifacts", "deploy.json");
const RATE_LIMIT = /rate limit|-32029/i;
const HICCUP = /DOCTYPE|fetch failed|ECONNRESET|timeout|temporarily unavailable|not available/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadKey() {
  if (fs.existsSync(KEY_PATH)) {
    const saved = JSON.parse(fs.readFileSync(KEY_PATH, "utf8"));
    if (!saved.creator) throw new Error("key file is missing the creator field");
    return saved.creator;
  }
  const fresh = { creator: generatePrivateKey() };
  fs.writeFileSync(KEY_PATH, JSON.stringify(fresh, null, 2), { mode: 0o600 });
  fs.chmodSync(KEY_PATH, 0o600);
  return fresh.creator;
}

async function retrying(label, fn, attempts = 30) {
  let last;
  for (let n = 0; n < attempts; n += 1) {
    try {
      return await fn();
    } catch (error) {
      const message = String((error && error.message) || error);
      if (RATE_LIMIT.test(message)) {
        console.log(`  ${label}: studio rate limit reached, stopping retries`);
        throw error;
      }
      if (!HICCUP.test(message)) throw error;
      last = error;
      console.log(`  ${label}: rpc hiccup, retry ${n + 1} in 5s`);
      await sleep(5000);
    }
  }
  throw last;
}

function stripWrapper(text) {
  const marker = '# { "Depends"';
  const at = text.indexOf(marker);
  if (at < 0) return text.trim();
  return text.slice(at).replace(/\s+$/, "");
}

function deployedCode(address) {
  const raw = execFileSync("genlayer", ["code", address], {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stripWrapper(raw);
}

async function explorerStatus(address) {
  for (let n = 0; n < 6; n += 1) {
    try {
      const response = await fetch(`https://explorer-studio.genlayer.com/address/${address}`, {
        redirect: "follow",
      });
      if (response.status === 200) return 200;
      if (response.status === 429 || response.status === 503) {
        await sleep(8000 * (n + 1));
        continue;
      }
      throw new Error(`explorer returned HTTP ${response.status}`);
    } catch (error) {
      if (n === 5) throw error;
      await sleep(8000);
    }
  }
  throw new Error("explorer did not return HTTP 200");
}

(async () => {
  const source = fs.readFileSync(SOURCE_PATH, "utf8");
  const account = createAccount(loadKey());
  const client = createClient({ chain: studionet, account });
  console.log("creator", account.address);

  const code = new Uint8Array(fs.readFileSync(SOURCE_PATH));
  const hash = await retrying("deploy", () => client.deployContract({ code, args: [] }));
  console.log("deploy tx", hash);

  const receipt = await retrying("receipt", () =>
    client.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 200, interval: 3000 })
  );
  const address =
    receipt.data?.contract_address ||
    receipt.txDataDecoded?.contractAddress ||
    receipt.data?.contractAddress;
  if (!address) throw new Error("no contract address in the deploy receipt");

  const stats = await retrying("stats", () =>
    client.readContract({ address, functionName: "stats", args: [] })
  );
  console.log("contract", address);
  console.log("stats   ", JSON.stringify(stats));

  const status = await explorerStatus(address);
  const onChain = deployedCode(address);
  const matches = onChain === stripWrapper(source);
  if (!matches) {
    const a = stripWrapper(source);
    let at = 0;
    while (at < Math.min(a.length, onChain.length) && a[at] === onChain[at]) at += 1;
    throw new Error(`deployed source differs from local source at byte ${at}`);
  }

  const artifact = {
    address,
    deployTx: hash,
    explorerUrl: `https://explorer-studio.genlayer.com/address/${address}`,
    explorerStatus: status,
    sourceSha256: crypto.createHash("sha256").update(source).digest("hex"),
    codeMatchesLocalSource: matches,
    deployedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`RESULT deploy_ok address=${address} tx=${hash} explorer=${status} code=match`);
})().catch((error) => {
  console.error("FAILED:", error.message);
  if (error.cause) console.error(String(error.cause).slice(0, 600));
  process.exit(1);
});
