# AGENTS_CHECKLIST.md - 5IVE Delivery Gates

Use this checklist during execution. Do not skip gates.

## A) Scope and Plan Gate

1. Restate requested business behavior before coding.
2. Define required instructions, account models, events, and invariants.
3. Lock units/scales up front:
- time in seconds
- USD/price scale (for example `1e6`)
- rate scale (for example `1e9`)
4. Decide one-shot target: contract + tests + minimal SDK client flow.
5. Decide execution mode:
- online mode: use docs/examples as supplemental context
- offline mode: rely on CLI help, `five.toml`, compile errors, ABI, and tx logs
6. For Anchor ports:
- inventory instructions, account constraints, PDA seeds, CPIs, and sysvar dependencies
- define exact parity expectations before rewriting syntax

## B) Authoring Gate

1. Account schemas:
- every field ends with `;`
- include authority fields where auth exists
- include status/version fields for state machines when needed
2. Init/account attributes:
- canonical order: `Type @mut @init(payer=..., space=...) @signer`
- payer is `account @mut @signer`
3. Auth and guards:
- signer params are `account @signer`
- verify owner/authority with `.ctx.key`
- include amount/range/state checks
4. Local variables:
- `let` for immutable
- `let mut` for reassignment
5. No stubs:
- no fake clock, fake rate, fake auth bypass
6. Stdlib/module imports:
- use `use <module path>;`
- call imported interfaces as `module_alias::Interface::method(...)`
- full path calls are allowed
- prefer `Interface::method(...)` for locally declared interfaces (legacy dot-call may still compile)
- mark interface authority slots with `@authority`
- prefer caller-side `account @pda(seeds=[...])` metadata over explicit `invoke_signed(...)` seed arrays
7. Crypto/auth-sensitive logic:
- build byte preimages explicitly with `bytes_concat(...)`
- hash into fixed `[u8; 32]` buffers
- require Ed25519/sysvar verification before accepting authenticated entropy/messages
- keep static signatures/messages as fixed `[u8; N]` literals when useful
8. Anchor migration parity:
- map every Anchor `require!()` to `require(...)`
- preserve signer checks and counter/state semantics exactly
- preserve instruction sysvar verification when present upstream

## C) Compile Gate

Use the installed `5ive` CLI / bundled SDK compiler as the public validation path. Do not assume access to maintainer-only compilers.

1. Run:
```bash
5ive build
```
2. If compile fails, fix in this order:
- missing semicolons in account fields
- wrong attribute stack order
- immutable variable reassignment
- wrong signer type (`pubkey @signer`)
- stale key access (`account.key`) instead of `account.ctx.key`
- inconsistent zero-pubkey sentinel usage (standardize on `0`)
- CPI account type/mutability mismatch
- unresolved module alias errors (add the missing `use <module>;` import)
- wrong call form for imported vs local interfaces
3. Re-run compile until clean.
4. Capture artifact path and byte size changes.
5. For Anchor ports, compile after each instruction/helper migration instead of batching the whole rewrite blindly.

## D) One-Shot Recovery Gate (When Errors Persist)

1. Keep full requested behavior intact.
2. Isolate the smallest failing section (single instruction or account block).
3. Patch only the failing section.
4. Recompile immediately.
5. Repeat until green.
6. Do not rewrite to a toy contract unless user asks.

## E) Test Gate

1. Run sdk/local tests:
```bash
5ive test --sdk-runner
```
2. Run focused tests:
```bash
5ive test --filter "test_*" --verbose
```
3. Add tests for every guard path and at least one happy path per public instruction.
4. Required negative tests:
- unauthorized signer
- invalid state transition
- zero/invalid amount or boundary values
- CPI account mismatch or missing account (if CPI is used)
- legacy object-style interface call fails with migration guidance
- alias call without import fails with missing-import guidance
5. For Anchor ports, add deterministic parity tests for:
- canonical preimage bytes
- hash output vectors
- counter increments / no-increment-on-failure
- sysvar/CPI proof failures
6. Record pass/fail evidence.

## F) Security Gate

1. Access control:
- every privileged path validates authority/signer
- authority rotation/revocation paths are explicit
2. State machine safety:
- valid status transitions only
- one-time init or replay-sensitive flows guarded
3. Arithmetic and limits:
- no unchecked overflow/underflow behavior in critical math
- units/scales applied consistently
4. CPI safety (if used):
- interface program IDs and discriminators validated
- writable/signer account constraints enforced
- automatic signed CPI paths prove the authority is either a tx signer or a declared PDA
5. Crypto safety (if used):
- Ed25519 verification is fail-closed
- no placeholder entropy or fallback randomness paths remain
6. Anchor parity (if porting):
- no dropped instruction, helper, or guard without explicit user approval
7. Security test evidence recorded.

## G) Deploy and Execute Gate (If In Scope)

1. Resolve program ID/target explicitly with precedence:
- `--program-id`
- `five.toml [deploy].program_id`
- CLI config target
- `FIVE_PROGRAM_ID`
2. Deploy with explicit target.
3. Execute instruction.
4. Confirm `meta.err == null`.
5. Record:
- signature
- confirmed `meta.err`
- compute units consumed

## H) SDK Client Gate

1. Build a client call for each public instruction needed by the user flow.
2. Ensure `.accounts(...)`, `.args(...)`, signer list, and payer are complete.
3. Add one script that runs the happy path end-to-end.
4. Include error logging that prints transaction signature, confirmation status, and on-chain logs.

## I) Final Output Gate

Unless user asks for another format, output must contain:
1. Scope implemented and files changed.
2. Build/test commands and results.
3. Security checks and results.
4. Deployment/execute proof (if requested): target, program ID, signatures, `meta.err`, compute units.
5. SDK client snippet or runnable script path.
6. Remaining risks and next steps.

## J) Quick Triage Map

1. Parser error near account block:
- check missing `;` first.
2. Attribute/init parse error:
- enforce `Type @mut @init(...) @signer`.
3. Signer/key access errors:
- switch to `account @signer` and use `.ctx.key`.
4. CPI failures:
- check interface discriminator/serializer/account types/mutability.
5. Anchor port mismatch:
- compare against upstream instruction semantics, byte layout, and auth path before changing the 5IVE code again.
6. Execution failed:
- inspect tx logs, guard conditions, and account ordering.
