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

Then open `http://localhost:3000`.

## Notes

- This app is intentionally separate from `five-frontend`.
- Use `NEXT_PUBLIC_RPC_URL` to target localnet/devnet/mainnet RPC.
- The web UI now executes `init_table`, `init_player`, `start_round`, `hit`, and `stand_and_settle` with wallet signatures.
- If you do not set fixed table/player/round accounts in env, use the `Provision Accounts` button.

## Cloudflare Pages

From `5ive-blackjack/web`:

```bash
npm run build
npm run deploy:pages
```
