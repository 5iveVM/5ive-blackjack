# 5IVE Standard Library (Bundled v1)

The compiler provides stdlib modules from a bundled source registry.
Declare stdlib explicitly in `five.toml`:

```toml
schema_version = 1

[dependencies]
std = { package = "@5ive/std", version = "0.1.0", source = "bundled", link = "inline" }
```

## Included modules

1. `std::prelude`
2. `std::builtins`
3. `std::types`
4. `std::interfaces::spl_token`
5. `std::interfaces::system_program`

## Import style (explicit)

```v
use std::builtins::{now_seconds};
use std::interfaces::spl_token;
use std::interfaces::system_program;

pub transfer_tokens(
  source: account @mut,
  destination: account @mut,
  authority: account @signer,
) {
  spl_token::transfer(source, destination, authority, 1);
}
```

Also supported:

```v
use std::builtins;
let now = builtins::now_seconds();
```

Documented import forms:

1. `use std::builtins::{now_seconds};` then call `now_seconds()`
2. `use std::builtins;` then call `builtins::now_seconds()`
3. `use std::interfaces::spl_token;` then call `spl_token::...`
4. `use std::interfaces::system_program;` then call `system_program::...`
5. Full path calls are also supported, e.g. `std::interfaces::spl_token::transfer(...)`

Legacy interface object calls like `SPLToken.transfer(...)` are not supported.

Use these forms as canonical stdlib module paths.

## Migration path

Current mode is bundled/inlined stdlib.
Future mode may support external dependency linkage.

## Troubleshooting

If your globally installed `5ive` binary behaves differently from the local monorepo code, run the local CLI dist directly:

```bash
node ./five-cli/dist/index.js <command>
```
