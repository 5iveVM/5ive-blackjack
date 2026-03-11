# Node Client Starter

This client is designed for on-chain execution on devnet/mainnet using `FiveProgram` + ABI from `../build/main.five`.

## Quickstart

```bash
# From project root
npm run build
cd client
npm install
npm run run
```

The starter is self-contained:
1. Uses a default devnet RPC URL in code.
2. Creates `client/script-account.json` on first run.
3. Uses `~/.config/solana/id.json` if available, otherwise creates `client/payer.json`.

## Notes

1. `client/main.ts` demonstrates instruction building for your starter contract.
2. It sends and confirms on-chain transactions, then prints signature, `meta.err`, and CU.
3. For account-required functions, set account mappings directly in `ACCOUNT_OVERRIDES` in `client/main.ts`.
4. Expand this file as your contract grows; keep it aligned with `tests/main.test.v`.
