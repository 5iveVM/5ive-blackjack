# 5ive Blackjack Client

On-chain runner for the blackjack MVP flow:

1. `init_table`
2. `init_player`
3. `start_round`
4. optional `hit`
5. `stand_and_settle`
6. getter calls (`get_player_chips`, `get_round_status`, `get_last_outcome`)

## Run

```bash
# from project root
npm run build
npm run client:run:local
npm run client:test:localnet
npm run client:test:journey:localnet
npm run client:journey:localnet
npm run client:gui:localnet
```

## Required setup

- Set real table/player/round account pubkeys in `client/main.ts` `ACCOUNT_OVERRIDES`.
- Set script account with `FIVE_SCRIPT_ACCOUNT` or `deployment-config.<network>.json`.

## GUI (Localnet)

`npm run client:gui:localnet` starts a local server at `http://127.0.0.1:4177`.

It auto-deploys script bytecode (unless `FIVE_SCRIPT_ACCOUNT` is set), provisions fresh on-chain table/player/round accounts, and lets you play rounds (`init`, `start`, `hit`, `stand`) from the browser.

GUI mode is strict wallet-only:
- connect Phantom and sign/send all action transactions in browser
- server only handles `state`, `ready`, `build-wallet-action`, and `commit-wallet-action`
- no mock wallet, no fallback/server-side signing paths

Prereqs for journey/GUI:
- local validator running at `http://127.0.0.1:8899`
- Five VM program deployed on that validator (or set `FIVE_VM_PROGRAM_ID` to the deployed address)
- payer key available at `~/.config/solana/id.json` (or `SOLANA_KEYPAIR_PATH`)
