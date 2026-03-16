# 5ive Blackjack

Single-player blackjack on 5IVE VM using mock-chip wagers (MVP).

## Scope (v1)

- Single player vs house
- Single hand only
- Hit / stand only
- Dealer draws to 17 (configurable soft-17 hit)
- Mock chips only (no SOL/SPL token custody)

## Contract Accounts

- `BlackjackTable`: table config and betting limits
- `PlayerState`: player chips, active bet, totals, status/outcome, delegated session nonce
- `RoundState`: deterministic deck seed, cursor, draw metadata

## Public Functions

- `init_table(table, authority, min_bet, max_bet, dealer_soft17_hits)`
- `init_player(player, owner, initial_chips)`
- `start_round(table, player, round, owner, bet, seed)`
- `hit(player, round, owner)`
- `stand_and_settle(table, player, round, owner)`
- `get_player_chips(player)`
- `get_round_status(player)`
- `get_last_outcome(player)`

## Build and Test

```bash
npm run build
npm test
```

## On-Chain Paths

```bash
# Local validator
npm run test:onchain:local
npm run client:run:local
npm run client:test:journey:localnet
npm run client:journey:localnet

# Devnet
npm run test:onchain:devnet
npm run client:run:devnet

# Mainnet preflight only
npm run test:onchain:mainnet:preflight

# Live mainnet transactions (explicit opt-in)
ALLOW_MAINNET_TESTS=1 npm run test:onchain:mainnet
```

## Client Configuration

Set real account addresses in `client/main.ts`:

- `ACCOUNT_OVERRIDES.init_table.table`
- `ACCOUNT_OVERRIDES.init_player.player`
- `ACCOUNT_OVERRIDES.start_round.table|player|round`
- `ACCOUNT_OVERRIDES.hit.player|round`
- `ACCOUNT_OVERRIDES.stand_and_settle.table|player|round`
- getter account mappings (`player`)

Set script account via env or deployment config:

- `FIVE_SCRIPT_ACCOUNT`, or
- `deployment-config.<network>.json` -> `blackjackScriptAccount`

Optional runtime env:

- `FIVE_NETWORK=localnet|devnet|mainnet`
- `FIVE_BET`, `FIVE_SEED`, `FIVE_INITIAL_CHIPS`
- `FIVE_MIN_BET`, `FIVE_MAX_BET`
- `FIVE_DEALER_SOFT17_HITS=1`
- `FIVE_DO_HIT=0` to skip hit before settle
- `FIVE_SESSION_MANAGER_SCRIPT_ACCOUNT` optional override (defaults to canonical `session_v1` PDA)
- `FIVE_SESSION_TTL_SLOTS` session lifetime in slots (default `3000`)

Sessionized gameplay flow:
1. Create session sidecar account and call `create_session`.
2. Call delegated `hit` and/or `stand_and_settle`; the delegate key is passed in the `owner` slot and the compiler-injected `__session` account is auto-wired by the client/sdk.
3. Increment `player.session_nonce` in program logic each delegated action.
4. Revoke with `revoke_session` when done (web UI includes this control).

## Notes

- Randomness is deterministic and non-cryptographic (MVP only).
- Payout is even-money (`1x`) for wins.
- No split, double down, insurance, or surrender in v1.

## Localnet Journey Prereqs

- local validator running at `http://127.0.0.1:8899`
- Five VM program deployed locally (or set `FIVE_VM_PROGRAM_ID` to the deployed address)
- payer key available at `~/.config/solana/id.json` (or set `SOLANA_KEYPAIR_PATH`)
