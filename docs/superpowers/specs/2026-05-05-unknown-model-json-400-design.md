# Unknown model JSON 400 — design

**Status:** approved by Matt 2026-05-05. Ready for implementation plan.
**Author:** Codex.
**Linear:** [PRI-1482](https://linear.app/prime-radiant/issue/PRI-1482)
**Related:** `src/api/routes/run.ts`, `src/models/resolve.ts`, `src/api/server.ts`, `test/api/run.test.ts`

---

## Problem

`POST /api/run/:id` treats most malformed run requests as client errors and
returns JSON 400 responses. Unknown model prefixes are the exception. A request
such as:

```json
{ "target": "http://localhost:3000", "model": "unknown-model" }
```

currently reaches `createClient(effective.model)`. `createClient` calls
`resolveProvider(model)`, and `resolveProvider` throws because the model does
not start with `claude`, `gpt`, `o1`, or `o3`. Hono catches the unhandled
exception and returns `500 text/plain`.

The verified bug is the response classification and shape: this is a bad
client request and should be a JSON 400. Local probing did not reproduce the
daemon-exit claim from the original ticket; after the bad request, the same
`Bun.serve` instance handled a later `/api/config` request.

## Goal

Return a stable JSON 400 for unsupported model prefixes before any run is
created, any client is constructed, or any run is registered.

## Non-goals

- Do not redesign model selection, model allow-lists, or provider discovery.
- Do not change CLI behavior in this ticket.
- Do not normalize every existing 400 response shape.
- Do not treat daemon survival as the primary fix. It is already true in the
  verified path; this issue fixes the bad response.

## Current request flow

The relevant `POST /api/run/:id` flow is:

1. Find the story card. Unknown card returns JSON 404.
2. Parse and validate the JSON body. `validateRunBody` throws are caught and
   returned as JSON 400.
3. Merge body config with server config. `mergeRunConfig` throws are caught and
   returned as JSON 400.
4. Enforce `GAUNTLET_MODELS` if configured. Disallowed configured models return
   JSON 400.
5. Construct an LLM client with `createClient(effective.model)`.
6. Later, pass `resolveProvider(effective.model)` into `executeRun`.

Step 5 is the failure point for unknown prefixes. Wrapping only the later
`resolveProvider` call in step 6 would not fix the observed bug.

## Design options

### Option A: catch `createClient` in the route

Wrap `createClient(effective.model)` in `try/catch` and return JSON 400 when
the thrown message matches the unknown-prefix error.

This is small, but it classifies errors by message text. It also leaves the
later `resolveProvider(effective.model)` call in place, so the route still has
two provider-resolution points.

### Option B: resolve provider once before client construction

Add a small typed error or predicate around provider resolution. The route
resolves the provider immediately after the allow-list check. Unknown prefixes
return JSON 400. Valid providers are reused for both client construction and
the `executeRun` metadata.

This is the recommended approach. It fixes the real throw site, removes
duplicate provider resolution from the route, and gives tests a stable error
classification that does not depend on message matching.

### Option C: rely on a Hono `onError` handler

Add `app.onError` and convert all unhandled exceptions to JSON 500 responses.

This improves consistency for unexpected failures, but it cannot produce the
correct 400 for unknown models by itself. It should be a backstop, not the main
fix.

## Proposed design

Use Option B, plus Option C as defense-in-depth.

### Provider classification

`src/models/resolve.ts` will expose a typed error for unknown model prefixes:

```ts
export class UnknownModelProviderError extends Error {
  readonly code = "unknown_model";
  constructor(readonly model: string) {
    super(
      `Model not supported. Supported prefixes: claude*, gpt*, o1*, o3*`,
    );
  }
}
```

`resolveProvider(model)` throws `UnknownModelProviderError` for unsupported
prefixes. The route classifies that typed error with `instanceof` and never
parses human-facing text. `resolveProvider(model)` remains the single source of
truth for prefix rules.

### Client construction

Avoid resolving the provider twice. Add a helper that accepts the provider the
route already resolved:

```ts
export function createClientForProvider(model: string, provider: Provider): LLMClient {
  switch (provider) {
    case "anthropic":
      return createAnthropicClient(model);
    case "openai":
      return createOpenAIClient(model);
  }
}

export function createClient(model: string): LLMClient {
  return createClientForProvider(model, resolveProvider(model));
}
```

This keeps existing callers working while allowing the run route to do:

```ts
let provider;
try {
  provider = resolveProvider(effective.model);
} catch (err) {
  if (err instanceof UnknownModelProviderError) {
    return c.json({
      error: "unknown_model",
      message: "Model not supported. Supported prefixes: claude*, gpt*, o1*, o3*",
    }, 400);
  }
  throw err;
}

const client = clientFactory
  ? clientFactory(effective.model)
  : createClientForProvider(effective.model, provider);
```

The route should pass the same `provider` into both solo and multi-pass
`executeRun` calls:

```ts
provider,
model: effective.model,
```

This keeps run metadata unchanged for valid models.

### Error response

Unknown model response:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "unknown_model",
  "message": "Model not supported. Supported prefixes: claude*, gpt*, o1*, o3*"
}
```

This response is intentionally more structured than older route validation
errors, which often return `{ "error": "<message>" }`. The stable
`error: "unknown_model"` code is useful for UI handling and test assertions.

### Hono error backstop

Add a top-level error handler in `src/api/server.ts`:

```ts
app.onError((err, c) => {
  return c.json({
    error: "internal",
    message: err instanceof Error ? err.message : String(err),
  }, 500);
});
```

Place this handler on the app returned by `createApp`, immediately after app
creation and before routes are mounted. It catches accidental unhandled API
exceptions and keeps response shape JSON. It is not the unknown-model fix.

For this local developer tool, the handler returns the exception message. That
matches the existing ticket language and makes test failures easier to diagnose.

## Testing

Add focused tests in `test/api/run.test.ts`.

### Unknown model returns JSON 400

Create the same minimal app used by the existing run-route tests. Post a valid
body with `model: "unknown-model"`. Assert:

- `res.status === 400`
- `content-type` includes `application/json`
- response body has `error === "unknown_model"`
- response body message mentions the supported prefixes
- no run is registered in `ActiveRunRegistry`

This test should not require a real API key because the route must reject before
client construction.

### Hono error handler returns JSON 500

Add a small server-level test near the existing API tests. Use `createApp`,
then add a minimal throwing route to the returned app:

```ts
app.get("/boom", () => {
  throw new Error("boom");
});
```

Request `/boom` and assert:

- `res.status === 500`
- `content-type` includes `application/json`
- response body has `error === "internal"`
- response body has `message === "boom"`

### Existing behavior stays intact

Keep the existing tests for:

- unknown card -> JSON 404
- missing target -> JSON 400
- disallowed allow-list model -> JSON 400
- bad adapter -> JSON 400
- successful route acknowledgement -> JSON 202

The allow-list test remains separate from unknown prefixes. A model can be a
known provider prefix and still be rejected by `GAUNTLET_MODELS`.

## Documentation updates

Update any PRI-1482 corpus/spec files that still describe unknown model as a
daemon-exit bug. The corrected wording should say:

- confirmed: bad model prefix currently returns `500 text/plain`
- expected: `400 application/json` with `error: "unknown_model"`
- unconfirmed in current app path: daemon termination

If `analysis-workspace` is not present in this checkout, leave those corpus
updates to the workspace where those files exist.

## Acceptance criteria

- Unknown model prefixes return JSON 400 before client construction.
- The response body includes stable code `unknown_model`.
- No run is registered, snapshotted, or detached for the bad request.
- Valid model flows still return 202 and carry provider/model metadata into
  `executeRun`.
- Unhandled API exceptions return JSON 500 through the app-level handler.
- Focused tests cover the unknown-model path and the JSON 500 backstop.

## Review notes

The implementation plan should keep this small. The risky part is accidentally
classifying provider-client construction failures, such as missing API keys, as
bad model requests. Only `resolveProvider` unknown-prefix failures should map to
`400 unknown_model`; everything else should remain an internal error or follow
the existing error path.
