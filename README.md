# 5ive Blackjack

Teaching-friendly blackjack example built on 5IVE VM.

This repo shows how to:
- write a stateful 5IVE contract (`src/main.v`)
- deploy to Solana via 5IVE VM
- interact from both a script client and a Next.js UI
- use delegated sessions for gameplay actions

## What This Project Implements
- Single player vs house blackjack
- One hand at a time
- Actions: `hit`, `stand_and_settle`
- Configurable table limits and dealer soft-17 behavior
- Mock chips only (no token custody in this version)

## Contract Model
Accounts:
- `BlackjackTable`: table config + round nonce
- `PlayerState`: bankroll, hand state, session nonce
- `RoundState`: deterministic draw state

Public functions:
- `init_table`
- `init_player`
- `start_round`
- `hit`
- `stand_and_settle`
- `get_player_chips`
- `get_round_status`
- `get_last_outcome`

## Quick Start
From this folder (`5ive-blackjack/`):

```bash
npm run build
npm test
```

Run web app:

```bash
npm run web:install
cp web/.env.example web/.env.local
npm run web:dev
```

Open `http://localhost:3000`.

## Network Flows
Local validator:

```bash
npm run test:onchain:local
npm run client:run:local
```

Devnet:

```bash
npm run deploy:devnet
npm run test:onchain:devnet
npm run client:run:devnet
```

Mainnet preflight (no live txs):

```bash
npm run test:onchain:mainnet:preflight
```

Live mainnet path (explicit opt-in):

```bash
ALLOW_MAINNET_TESTS=1 npm run test:onchain:mainnet
```

## Web Configuration
The web app reads:
- `NEXT_PUBLIC_RPC_URL`
- `NEXT_PUBLIC_FIVE_VM_PROGRAM_ID`
- `NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT`

Optional:
- `NEXT_PUBLIC_SESSION_MANAGER_SCRIPT_ACCOUNT`
- `NEXT_PUBLIC_SESSION_TTL_SLOTS`
- fixed game accounts (`NEXT_PUBLIC_BJ_TABLE_ACCOUNT`, `NEXT_PUBLIC_BJ_PLAYER_ACCOUNT`, `NEXT_PUBLIC_BJ_ROUND_ACCOUNT`)

## Repo Structure
- `src/`: 5IVE contract source
- `tests/`: contract tests
- `client/`: scriptable on-chain runner
- `web/`: Next.js game UI
- `scripts/`: on-chain and regression helpers
- `deployment-config.*.json`: per-network deployment config

## Cloudflare Pages
From `web/`:

```bash
npm run build
npm run deploy:pages
```

## Notes for Learners
- Randomness here is deterministic and not cryptographic.
- This repo prioritizes clarity over full casino-feature completeness.
- Session mode in the UI demonstrates delegated calls cleanly.
