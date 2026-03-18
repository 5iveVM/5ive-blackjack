# 5ive Blackjack Web

Standalone web app for blackjack, scaffolded from `five-templates/web-starter`.

## Local development

From `5ive-blackjack/`:

```bash
npm run build
npm run web:install
cp web/.env.example web/.env.local
npm run web:dev
```

Then open `http://localhost:3000` (or the next available port).

## Notes

- This app is intentionally separate from `five-frontend`.
- Use the navbar network toggle to switch devnet/mainnet at runtime.
- Set per-network script accounts in `web/.env.local`:
  - `NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT_DEVNET`
  - `NEXT_PUBLIC_FIVE_SCRIPT_ACCOUNT_MAINNET`
- `NEXT_PUBLIC_RPC_URL` is still supported as a fallback/default RPC.
- Session creation/revoke uses the canonical `@5ive-tech/sdk` `SessionClient` flow (no custom app-side session-manager ABI encoding).
- Switching the navbar network toggle resets volatile runtime state (accounts/session/tx list/round state) to avoid cross-network stale data.
- The web UI executes `init_table`, `init_player`, and `start_round` directly.
- `hit`/`stand_and_settle` support both:
  - delegated session flow (`Create Session`, then delegated signer + session sidecar), and
  - direct owner flow (no active session required; implicit session accounts alias to owner).
- If you do not set fixed table/player/round accounts in env, use the `Provision Accounts` button.
- Session config env:
  - `NEXT_PUBLIC_SESSION_MANAGER_SCRIPT_ACCOUNT` optional override for session manager script account.
  - `NEXT_PUBLIC_SESSION_TTL_SLOTS` optional session lifetime in slots (default `3000`).

## Cloudflare Pages

From `5ive-blackjack/web`:

```bash
npm run build
npm run deploy:pages
```

Current Pages project target: `5iveblackjack`.
