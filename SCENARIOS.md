# Scenarios

## Local Smoke

```bash
npm run smoke
```

## Local On-Chain

Prereqs:
- local validator running
- Five VM program deployed
- `deployment-config.localnet.json` updated with `blackjackScriptAccount`
- real account pubkeys set in `client/main.ts` `ACCOUNT_OVERRIDES`

```bash
npm run test:onchain:local
npm run client:run:local
npm run client:test:journey:localnet
npm run client:gui:localnet
```

## Devnet On-Chain

Prereqs:
- funded payer keypair
- `deployment-config.devnet.json` updated with `blackjackScriptAccount`
- real account pubkeys set in `client/main.ts` `ACCOUNT_OVERRIDES`

```bash
npm run test:onchain:devnet
npm run client:run:devnet
```
