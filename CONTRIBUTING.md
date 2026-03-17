# Contributing

Thanks for your interest in improving `5ive-blackjack`.

## Development Workflow
1. Fork the repo and create a feature branch.
2. Make focused changes with clear commit messages.
3. Run local checks before opening a PR:

```bash
npm run build
npm test
```

If you changed web UI:

```bash
npm run web:install
npm run web:build
```

## Pull Request Guidelines
- Keep PRs small and purpose-specific.
- Include a short summary of behavior changes.
- Add/adjust tests when logic changes.
- For UI changes, include screenshots or short video clips.

## Contract Safety Expectations
- Avoid changing account layouts without explicit migration notes.
- Document any on-chain compatibility implications.
- Do not commit private keys, secrets, or local `.env` files.

## Good First Areas
- Documentation improvements
- Test coverage and scenario scripts
- UX polish in `web/`
- Developer ergonomics in `client/` scripts
