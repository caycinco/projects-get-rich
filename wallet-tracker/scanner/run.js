import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RPC } from "../lib/limits.js";
import { emptyState } from "../lib/feed.js";
import { validateCohort } from "../lib/validate.js";
import { createDexLookup } from "./dex.js";
import { createRpc } from "./rpc.js";
import { runScan } from "./scan.js";
import { writeFeed } from "./build.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");

function readJson(name, fallback) {
  const file = path.join(dataDir, name);
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(name, value) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

const source = JSON.parse(fs.readFileSync(path.join(root, "source/fomolens-top30-2026-11-07.json"), "utf8"));
const cohort = validateCohort(source);
if (cohort.counts.quarantine) {
  console.error(`quarantine ${cohort.counts.quarantine}; those addresses will not be scanned`);
}

const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC;
let rpcHost = "unknown";
try {
  rpcHost = new URL(rpcUrl).host;
} catch {
  console.error("SOLANA_RPC_URL is not a URL");
  process.exit(1);
}

const state = readJson("state.json", emptyState());
state.rpc_url_host = rpcHost;
const entries = readJson("entries.json", []);
const holdings = readJson("holdings.json", { baseline: {}, latest: {} });
const pools = readJson("pools.json", {});
const rpc = createRpc({ url: rpcUrl });
const dexLookup = createDexLookup();

function flush(result) {
  writeJson("state.json", result.state);
  writeJson("entries.json", result.entries);
  writeJson("holdings.json", result.holdings);
  writeJson("pools.json", result.pools);
  writeFeed({ ...result, cohort, nowMs: Date.parse(result.state.last_attempt_at) });
}

const result = await runScan({
  cohort,
  state,
  entries,
  holdings,
  pools,
  rpc,
  dexLookup,
  onProgress: (snapshot) => flush({ state, entries: snapshot.entries, holdings, pools }),
});
flush(result);
const failed = Object.values(result.state.wallets).filter((wallet) => wallet.last_error).length;
console.log(JSON.stringify({
  status: result.state.last_run_status,
  rpc_host: rpcHost,
  buys: result.entries.length,
  wallets_failed: failed,
  last_error: result.state.last_error,
  requests: rpc.requests,
}));
