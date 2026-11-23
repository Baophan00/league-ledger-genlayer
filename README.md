# LeagueLedger

A public tournament ledger where the table is not typed in by an administrator.
An organizer registers a season with its teams, its points rule and its tie-break
order. Each result is **one GenLayer consensus round** that reads a live scoreboard
page as untrusted material and extracts only a coarse bucket — `HOME_WIN`, `DRAW`
or `AWAY_WIN` — plus two whole goal counts. Points, head-to-head, goal difference,
the recorded-first rule and the medals are computed **in contract code** from the
stored results. The model never ranks a team, chooses a champion or moves money.

No funds, no token, no voting, no generic "does this page say X" oracle question.
This is a scorekeeper with a reproducible table.

## Why this is not a tender, a vote, or an oracle demo

| Other project shapes | LeagueLedger |
| --- | --- |
| Tender / procurement: validators judge whether a bid meets a rubric and the contract pays out. | No payments, no bids, no rubric. The contract records a result and derives a table. |
| Voting / governance: validators or token holders pick between options. | Nobody votes on the winner. Two teams play, a scoreboard states the score, arithmetic decides the table. |
| Generic web oracle: a page is fetched and a fact is attested. | The fetched page is only one input to a state machine with registration, duplicate guards, standings, tie-break paths and season closure. |
| A backend that computes standings off-chain and posts them. | The standings function lives in the contract; every reader can re-derive the table from the stored results. |

The consensus boundary is deliberately narrow: a validator agrees on a bucket and
two integers, not on an opinion. The prompt treats the page as untrusted material,
and the equivalence principle binds the canonical JSON of the reading. Anything
missing, malformed, internally inconsistent or out of range is refused and stores
nothing.

## Use case

A league publishes scores on ordinary static web pages — a federation site, a club
blog, a municipal sports desk. LeagueLedger turns those pages into a tamper-evident
league record: a reader can check the exact page behind every result and recompute
the table from the on-chain inputs. The scoreboard page can lie or go offline; it
cannot make the contract award points for a score that was never stated.

## Architecture

```
 static scoreboard pages (surge)
        │  fetched independently by every validator
        ▼
 gl.nondet.web.render(url, mode="text")     ← inside the consensus callback
 gl.nondet.exec_prompt(..., response_format="json")
        │  canonical {valid, outcome, home_goals, away_goals}
        ▼
 gl.eq_principle.prompt_comparative(ask, principle=...)
        │  strict parse + range/consistency checks in the contract
        ▼
 TreeMap storage: seasons, results, scoreboard URL index
        │  _compute_table(): points → H2H → GD → first recorded
        ▼
 views: get_standings / results_of / medals / list_seasons / stats
        │
        ▼
 browser app (genlayer-js, bundled with esbuild) on surge
```

Two tie-break orders are fixed at registration:

- `H2H_GD_EARLIEST`: points → head-to-head points → head-to-head goal difference → overall goal difference → first recorded → team name.
- `GD_H2H_EARLIEST`: points → overall goal difference → head-to-head points → head-to-head goal difference → first recorded → team name.

The "first recorded" step uses a global monotonic result sequence, so ids never
restart across seasons and the ordering cannot be changed by rewriting a page.

## Contract API

| Method | Kind | Arguments | Returns |
| --- | --- | --- | --- |
| `register_season` | write | `season_id, name, teams_json, win_points, draw_points, loss_points, tie_order` | Season record with rules and status |
| `submit_result` | write | `season_id, match_id, home, away, scoreboard_url` | Stored result with consensus reading |
| `close_season` | write | `season_id` | Medals plus frozen standings |
| `get_season` | view | `season_id` | Season record |
| `get_result` | view | `season_id, match_id` | One recorded result |
| `results_of` | view | `season_id` | Results in recorded order |
| `get_standings` | view | `season_id` | Full derived table with ranks |
| `medals` | view | `season_id` | Champion, silver, bronze (and table once closed) |
| `list_seasons` | view | — | All seasons |
| `stats` | view | — | Season and result counters |

Guards: season id and team names are bounded; 2–8 distinct teams; win > draw >
loss with all points in 0–100; one of the two documented tie orders; one write per
match id; one scoreboard URL per season; only the organizer closes; no writes after
closure. The frontend uses a locally generated Studio account for its writes.

## Live artifacts

- App: https://leagueledger-genlayer.surge.sh
- Demo scoreboards: https://leagueledger-scores.surge.sh
- Contract: https://explorer-studio.genlayer.com/address/0x54bD8Fb18914b2ed5dEF4E91fa653aB5EA6B88Fe
- Source: https://github.com/Baophan00/league-ledger-genlayer/blob/main/contracts/league_ledger.py
- Repo: https://github.com/Baophan00/league-ledger-genlayer

## Evidence

Deployed contract: `0x54bD8Fb18914b2ed5dEF4E91fa653aB5EA6B88Fe`
Deploy tx: `0x53bb71770581b880f5dd3fa2fa8fc8a4d48ade474e5c4879a4361c81d77af40c`
`genlayer code <address>` matches `contracts/league_ledger.py` after stripping the CLI wrapper line; the explorer address page returns HTTP 200.

| # | Write | Purpose | Tx hash |
| --- | --- | --- | --- |
| 1 | `register_season` | Fix teams, 3/1/0 points, tie order | `0xdf59c8b1dbc267c7e60b0e2e237448ff9fd270d4d76ef6b18511222e83407879` |
| 2 | `submit_result` | Northside 2–0 Riverside (`HOME_WIN`) | `0x1de7b9165a6f34049c5a16b34183498e59fd66f8b582494c8d7327c77e5a52ca` |
| 3 | `submit_result` | Riverside 1–1 Eastgate (`DRAW`) | `0xdb0384b8903f2b1a9f7111b55b0e4dd4834abbd68cca891633dbf9d89aa312ab` |
| 4 | `submit_result` | Eastgate 0–3 Northside (`AWAY_WIN`) | `0x994a497d4b3160ca09d32afab10a07dd8ec31e2f5c692bdc1f0b069fe7a4c669` |
| 5 | `submit_result` | Refused: page has no final score | `0x1d794c57e6390cecf39b2427611207080c8417a759c8e8f069af79f69c64e070` |
| 6 | `submit_result` | Refused: duplicate match id | `0xd144714f80b0052a78f5bb549d875b35c5f372ffd05417bb71ec15480ba0ba2d` |
| 7 | `close_season` | Champion and medals written on chain | `0xa967c5a30c397bf6215dea45f4aa9a375eea28f654594abc907d89605cfbc086` |

Explorer links for each tx: `https://explorer-studio.genlayer.com/tx/<hash>`.

The full E2E run executed all seven writes and finalized them on Studio. A second
run hit a Studio transaction that stayed in `COMMITTING` for over fifteen minutes;
`LL_VERIFY=1 LL_SEASON=<season> LL_TXS=<comma-separated hashes> node
scripts/e2e_studionet.js` re-reads the closed season, checks the results and
medals, writes `artifacts/e2e.json` plus `app/snapshot.js`, and exits 0. That
verification read is the source of the shipped snapshot.

Live outcome: champion **Northside**, silver **Riverside**, bronze **Eastgate**
(Riverside and Eastgate both finish on 1 point and drew 1–1 head to head, so
overall goal difference — −2 versus −3 — separates them).

## Verification

- **25 direct-mode pytest tests pass.** They cover registration rules, result
  parsing, malformed / out-of-range / contradictory readings, empty pages,
  duplicate match ids and reused URLs, standings arithmetic, all tie-break
  paths, season closure, view and sequence behaviour, proof that the validator
  re-fetches the scoreboard inside the consensus callback, plus a static check
  that every contract method takes `self` and declares a return type.
- `npm run test` runs the suite with the pinned GenLayer test runner.
- `node scripts/deploy_studionet.js` deploys, waits for `FINALIZED`, reads `stats`,
  checks the explorer, compares deployed code with local source and writes
  `artifacts/deploy.json`.
- `node scripts/e2e_studionet.js <address>` publishes nothing itself: it checks the
  scoreboard URLs are live, runs seven finalized writes against the deployed
  address, confirms each write with a view read, and fails if a refusal or a
  medal is wrong. It writes `artifacts/e2e.json` and `app/snapshot.js`.

```bash
npm install
npm run test
npm run deploy
node scripts/e2e_studionet.js <contractAddress>
npm run build:app
```

Notes for operators: Studio's public RPC has an hourly limit, so the app reads on
demand and never polls. If a read fails, the app shows the last successful read
with its timestamp, or the build-time snapshot generated by the E2E run. Deploy
keys stay in `scripts/.league-ledger-keys.json` (mode `0600`, gitignored) and are
never printed.
