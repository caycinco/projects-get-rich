# FOMO cohort tracker

Read-only page for a fixed 30-handle FOMO leaderboard snapshot. It watches Solana swaps after a baseline cursor and publishes the result as static JSON on this GitHub Pages site.

The page is `wallet-tracker/index.html`. After this branch is on `main`, GitHub Pages serves it at:

https://caycinco.github.io/projects-get-rich/wallet-tracker/

Pages is already configured to publish the `main` branch from `/`. This folder does not change that source, and it does not add a paid host.

## What the scan will and will not claim

- Cohort is fixed from public FomoLens lookups on 7 Nov 2026 UTC. It is a 24h leaderboard sample, not a long-term ranking. Rank 2 CivilOpenPig and rank 4 TheMilesBron are stale samples and stay in the set. Wallet ownership is unverified.
- 29 Solana addresses decode to 32 bytes. `emptybags` is EVM-only. EVM values are a wallet family with no chain attached, so they are not scanned. Invalid addresses would be quarantined and never padded.
- A buy is a confirmed transaction where the tracked wallet signed, spent SOL, WSOL, USDC, or USDT, and received a non-quote token. Token and Token-2022 are both read. Net balance changes collapse route hops. Transfers, airdrops, failed transactions, and rent for a new token account are not buys.
- The first look at an address stores its newest signature as a cursor and does not emit older swaps. Token accounts from that first successful read are baseline holdings, not entries.
- Two or more means distinct wallets, not transaction count. Highlighting also requires a pool whose earliest returned DexScreener `pairCreatedAt` is within the display window (default 24h) and a numeric `marketCap` at or under the display cap (default $1,000,000). FDV never qualifies. Missing values stay unknown.
- Window buyers and current holders are separate. Holder state comes from the latest token-account snapshot and is labeled estimated.

## Cadence

`.github/workflows/wallet-tracker.yml` runs on GitHub-hosted `ubuntu-latest`:

- Tests on pull requests and pushes that touch this folder. `contents: read`, 5 minute timeout.
- Scan on `workflow_dispatch` and on cron `17 * * * *`. The scan job is the only job with `contents: write`. Timeout is 12 minutes. The script itself stops opening new wallets after 9 minutes and writes whatever it finished.
- The scan commits `wallet-tracker/data/*.json` back to the default branch. GitHub Pages rebuilds from that push. There is no second hosting service.

This is an hourly file publish, not a live feed. GitHub documents that scheduled workflows can start late under load, and that five minutes is only the shortest cron syntax, not a guarantee. A new swap can sit unseen until the next scheduled run finishes, and the page says so.

Public Actions minutes on a public repository are not billed. The workflow is one runner, one job, no matrix, and a hard timeout.

## First run after merge

1. Merge the pull request to `main`. Do not expect the schedule to run from the pull request branch.
2. Confirm GitHub Actions is enabled for the repository. The schedule starts only once the workflow file is on `main`.
3. Optional: set repository variable `SOLANA_RPC_URL` to another keyless public Solana HTTP RPC. Leave it unset to use `https://api.mainnet-beta.solana.com`. Do not put a key or a private URL in the workflow.
4. Actions → FOMO wallet tracker → Run workflow, or wait for minute 17 of the next hour. The run can start later than that.
5. The data commit updates the Pages site. Reload the tracker. `LAST SUCCESS` is the scan time in Europe/London. `NO SUCCESSFUL SCAN` means the file has never had a good read, and the buy count stays unknown rather than zero.

Local check, with no install:

```bash
cd wallet-tracker
node --test test/*.test.js
node scanner/build.js --check
node scanner/run.js
```

`node scanner/run.js` reads the public RPC from this machine and writes `data/`. It does not sign, trade, or read a secret.

## Known limits

- The official public RPC rate-limits shared cloud addresses. A 429 is stored on the wallet and the cursor is left where it was. The page shows partial coverage instead of a filled-in book. A repository variable can point at another public RPC if the default host keeps refusing the runner. A paid RPC would remove that limit, and this repo does not sign up for one.
- Signature history above 200 transactions per address between runs (8 pages of 25) is a gap. The cursor does not jump the gap, and those buys stay unknown.
- At most 8 associated token accounts are signature-scanned per wallet per run. Owner history is still the source for signed swaps. A capped wallet is partial coverage.
- DexScreener's documented `GET /tokens/v1/solana/{addresses}` endpoint supplies pool age, market cap, and FDV. It can omit pools, so "earliest pool" means earliest pair in that response.
- EVM activity is not available from the cohort file. `emptybags` stays unscanned until a chain is actually known.
