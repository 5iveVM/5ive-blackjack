# 5ive Blackjack Client

On-chain runner for the blackjack MVP flow:

1. `init_table`
2. `init_player`
3. `start_round`
4. create delegated session (`create_session`)
5. optional delegated `hit`
6. delegated `stand_and_settle`
6. getter calls (`get_player_chips`, `get_round_status`, `get_last_outcome`)

## Run

```bash
# from project root
npm run build
npm run client:run:local
npm run client:test:localnet
npm run client:test:journey:localnet
npm run client:journey:localnet
```

## Required setup

- Set real table/player/round account pubkeys in `client/main.ts` `ACCOUNT_OVERRIDES`.
- Set script account with `FIVE_SCRIPT_ACCOUNT` or `deployment-config.<network>.json`.
- Optional session manager override: `FIVE_SESSION_MANAGER_SCRIPT_ACCOUNT`.
- Optional session TTL slots: `FIVE_SESSION_TTL_SLOTS` (default `3000`).

Prereqs for journey:
- local validator running at `http://127.0.0.1:8899`
- Five VM program deployed on that validator (or set `FIVE_VM_PROGRAM_ID` to the deployed address)
- payer key available at `~/.config/solana/id.json` (or `SOLANA_KEYPAIR_PATH`)
