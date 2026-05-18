# Error-handling policy

This codebase uses three error-handling styles. To prevent the trio
from drifting further apart, new code picks from the following rules.

## The rules

**Expected failures use `ParseResult<T>`.** Anything where failure is a
normal outcome — parsing, validation, lookups, optional credential
fetches — returns `{ ok: true; value: T } | { ok: false; reason: string }`.
Use the `ParseResult<T>` shape from `src/agent/validators.ts`.

**Exceptional failures throw.** Disk I/O, network failures, programmer
errors, anything the caller cannot meaningfully recover from. Catch at
process boundaries (route handlers, CLI dispatchers) and convert to a
clean exit / error response.

**The `{ error: string }` discriminated-union shape is retired** for
new code. Existing usage is being migrated to `ParseResult`.

## Why these rules

`ParseResult` makes the success path the un-narrowed value (you write
`if (!r.ok) return r.reason; return useValue(r.value)`), which keeps
the happy path linear and the failure path one-line-explicit. The
ad-hoc `LLMClient | { error: string }` shape conflated "success" with
a discriminator-less union — every caller had to use `"error" in x`
property-existence checks, which is fragile under refactoring.

Throwing for exceptional failures is fine because the catch boundaries
already exist: every HTTP route is wrapped in `try/catch`, every CLI
dispatcher exits non-zero on unhandled rejection. Funneling expected
failures through the same channel collapses the signal — the catch
block can't tell "user typoed a model name" from "disk is full".

## Worked example

Before:

```ts
function resolveClient(...): LLMClient | { error: string } { ... }

const r = resolveClient(...);
if ("error" in r) return c.json({ error: r.error }, 400);
// r is now LLMClient
useClient(r);
```

After:

```ts
function resolveClient(...): ParseResult<LLMClient> { ... }

const r = resolveClient(...);
if (!r.ok) return c.json({ error: r.reason }, 400);
// r.value is LLMClient
useClient(r.value);
```

The HTTP JSON response shape (`{ error: "..." }`) is unchanged — that's
the wire format, a separate concern from the in-memory representation.
