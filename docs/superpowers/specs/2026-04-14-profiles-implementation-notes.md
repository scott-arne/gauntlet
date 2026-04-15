---
title: Profiles — implementation notes
date: 2026-04-14
status: shipped (v1, collapsed)
---

# Profiles — implementation notes

The spec of record is `docs/profiles-spec.md`. This file captures the
implementation decisions we actually shipped, which are meaningfully
leaner than the spec's Implementation Surface. Read the spec first for
the "why"; read this for the "what now lives in the code."

## What we shipped

The v1 experiment is intentionally the smallest version we could
justify. The whole feature is **one tool, one parameter, zero schema
on the file content**. Everything else the spec described — frontmatter
parsing, `display_name`, `tags`, a rendered Keychain section in the
system prompt, a pre-loaded alias enum on the tool parameter — is
*not* in the code.

The core question we want to answer with this implementation:

> Given only a story card saying "log in as matt" and a `read_profile`
> tool whose single `name: string` parameter is unconstrained, will
> the model notice the tool in the tools array, guess the right
> profile name, call the tool, parse the returned file, and use the
> credentials? Or does it need more scaffolding?

Every piece of "help" we remove is a thing we no longer have to
justify if the answer is yes. Every piece we'd have to add back is
something we learn about model capability if the answer is no.

## The flow, in concepts

**Run starts.** Each adapter is constructed with an optional
`profilesDir` option. On construction it runs `listProfiles(dir)`;
if the directory exists and contains at least one `.md` file, the
adapter splices a `read_profile` tool into its `toolDefinitions()`.
Otherwise the tool is invisible — the agent never knows profiles
could have existed.

**Agent sees the world.** The system prompt is unchanged from pre-v1.
There is no Keychain section, no alias list, no mention of profiles.
The model's only signal that `read_profile` exists is the tool list
it receives on every turn.

**Agent acts.** When the story card references a profile by name
("log in as matt"), the model is expected to connect the name to
the `read_profile` tool and call it with `{ name: "matt" }`.

**Tool executes.** The adapter's handler calls `readProfile(dir, name)`,
which reads `<dir>/<name>.md` off disk and returns its contents
verbatim. No frontmatter split, no parsing, no structure assumed.
The full file contents — whatever the author wrote — lands in the
message stream as a tool result.

**Agent reads and acts.** From there, the model parses the returned
prose itself and uses the existing browser tools (`navigate`, `type`,
`click`) to act on the credentials it found. There is no auto-fill,
no session injection, no structured credential object — it's all
reading comprehension.

**Miss cases** return helpful errors. No `name` argument, unknown
name, and path-escape names all yield a tool result of the form
`Error: ... Available: alice, bob, matt` — the available list is
built at error-time from a fresh `listProfiles` call, so freshly
added profiles show up even when the model's first guess missed.

## Code surface

| File | Change |
|---|---|
| `src/format/profile.ts` | **NEW.** Two functions: `listProfiles(dir): string[]` and `readProfile(dir, name): string`. No types, no interfaces. |
| `src/adapters/profile-tool.ts` | **NEW.** `buildReadProfileTool(profilesDir): ProfileTool \| null`. Returns `null` when the directory has no `.md` files so callers skip registration cleanly. |
| `src/adapters/web/adapter.ts` | Accepts `{ profilesDir }`. Builds the tool in the constructor, conditionally splices it into `toolDefinitions()`, dispatches `read_profile` in `executeTool()`. |
| `src/adapters/cli/adapter.ts` | Same. Newly gains a constructor. |
| `src/adapters/tui/adapter.ts` | Same. Newly gains a constructor. |
| `src/cli/run.ts` | Starts consulting `config.dataDir`. Passes `${dataDir}/profiles` as `profilesDir` to whichever adapter it constructs. |
| `src/api/routes/run.ts` | Same on the serve path. |
| `src/adapters/adapter.ts` | **UNCHANGED** in v1. No `keychain()` method, no profile surface on the interface — profiles live entirely inside individual adapters. |
| `src/agent/prompts.ts` | **UNCHANGED** in v1. No Keychain section, no profile list. |
| `src/agent/agent.ts` | **UNCHANGED** in v1. |

| Test file | Coverage |
|---|---|
| `test/format/profile.test.ts` | `listProfiles` on missing/empty/populated dirs; `readProfile` returns file contents verbatim; refuses path traversal and subdirectory access. |
| `test/adapters/profile-tool.test.ts` | Helper returns `null` when dir is empty; tool has no `enum` on its `name` parameter; `execute` hit returns contents verbatim; misses, empty names, and path-escape names all return structured errors listing available names. |
| `test/adapters/{web,cli,tui}/adapter.test.ts` | Each adapter omits `read_profile` when no `profilesDir` is set *and* when `profilesDir` is empty; includes it when the directory has at least one file. CLI test also covers the `executeTool("read_profile")` dispatch path. |

## What's deliberately missing

All of the following appeared in either the spec or an earlier draft
of the implementation, and were removed on purpose. Listed here so a
future Bob doesn't re-add them by reflex.

- **Frontmatter parsing.** Profiles can have frontmatter; we ignore it.
  The model sees whatever is in the file.
- **`display_name`, `tags`, `Profile` interface, `KeychainEntry`.** None
  of these exist in the codebase. There is no structured profile type.
- **Alias enum on the tool parameter.** The `name` parameter is a bare
  string. The model does not see a list of valid names in the tool
  schema; it has to guess from the story card.
- **Keychain section in the system prompt.** There is no prompt-level
  disclosure that profiles exist. The tool definition is the entire
  discovery surface.
- **Eager content loading.** Profile files are only read off disk when
  the tool is actually called. The `listProfiles` call at construction
  time is a directory listing, not file reads.
- **Auto-created `profiles/.gitignore`.** Deferred; easy follow-up if
  people ask for it.
- **Smoke test against a seeded Express app.** Deferred; we'll add once
  we have seen the feature used in anger.

## Passkey support (added as a follow-up)

The same day we shipped `read_profile`, we extended the profiles feature
with a second tool: `install_passkey`. This is a separate capability
with its own plumbing; the two tools share only the `profilesDir`
configuration. Either, both, or neither may be registered depending on
what files exist on disk.

### File layout — profiles can now be files *or* directories

A profile can take one of two shapes, and they coexist in the same
`profilesDir`:

- **Flat markdown**: `profiles/<name>.md` — consumed by `read_profile`
- **Directory**: `profiles/<name>/passkey.json` — consumed by
  `install_passkey`

Nothing stops a profile from having both (markdown file at
`profiles/matt.md` *and* a directory at `profiles/matt/passkey.json`),
but the tools don't know about each other. A future generalization
could unify the shapes under a single profile-directory model, but
that migration isn't justified yet.

### What `install_passkey` does

When the agent calls `install_passkey("matt")`, the tool:

1. Reads `profiles/matt/passkey.json` and validates its shape
   (required: `credentialId`, `rpId`, `privateKey`; optional:
   `isResidentCredential`, `userHandle`, `signCount`).
2. **On the first call of the run**, enables the `WebAuthn` CDP
   domain on the current target and creates a virtual authenticator
   with `protocol: ctap2`, `transport: internal`, `hasResidentKey`,
   `hasUserVerification`, and `isUserVerified` all set to true. This
   means the virtual authenticator auto-approves user-verification
   challenges — no real UI prompt, no OS keychain involvement.
3. Adds the credential from the JSON to the virtual authenticator.
4. Returns a success message identifying the profile and its `rpId`.

From that point forward, any `navigator.credentials.get(...)` call
made by a page on the same target is answered by the virtual
authenticator, which holds the stored credential. The site sees a
valid signed assertion and cannot distinguish it from hardware. The
agent only has to click the site's "Sign in with passkey" button.

**Subsequent `install_passkey` calls in the same run** (for different
profiles) reuse the existing virtual authenticator and just add more
credentials. One authenticator per run, many credentials.

**Teardown.** On `WebAdapter.close()`, if a virtual authenticator was
created, it's removed via `WebAuthn.removeVirtualAuthenticator`
before Chrome is killed. For locally-spawned Chrome this is a no-op
in practice (the process dies anyway), but for remote Chrome it
prevents authenticator state from leaking between runs.

### Threat model note

The virtual authenticator is scoped to the CDP target — it exists
only for the lifetime of the run and disappears when the adapter
closes. No state touches the OS keychain or Chrome's real passkey
store. The credential material that *does* persist is whatever the
author put in `passkey.json` on local disk, plus whatever the LLM
provider logs and evidence logs contain on the tool-call result
(just the success message — the tool result *never* includes the
private key). The same "use throwaway credentials, gitignore the
profiles directory" advice from the original spec applies
unchanged.

### Code surface (passkey addition)

| File | Change |
|---|---|
| `src/adapters/web/lib/chrome-ws-lib.js` | +`webAuthnOpenSession(tabIndexOrWsUrl)` — opens a dedicated WebSocket outside the connection pool, calls `WebAuthn.enable` on it once, and returns a session object with `addVirtualAuthenticator`, `addCredential`, `removeVirtualAuthenticator`, and `close` methods that all ride the same socket. The pinned-session shape is mandatory: CDP's WebAuthn domain is scoped to the DevTools session that enabled it, and virtual authenticators disappear when that session closes. Flat per-call wrappers (the first shape we tried) fail because `sendCdpCommand`'s pool-fallback-single-use path lets subsequent commands land on a fresh socket that never saw `enable`. |
| `src/format/profile.ts` | +`listPasskeyProfiles(dir)` — scans `dir/*/passkey.json`. +`readPasskey(dir, name)` — reads and validates the JSON. +`PasskeyCredential` interface. |
| `src/adapters/passkey-tool.ts` | **NEW.** `buildInstallPasskeyTool(profilesDir, tab, driver)` returns `{definition, execute, teardown} \| null`. Holds a lazy `WebAuthnSession` and `authenticatorId` in a closure: the first `execute` call asks the driver to open a session, adds a virtual authenticator, and adds the credential; subsequent calls reuse the session and authenticator, adding more credentials to the same authenticator. Teardown closes the session, which implicitly disposes any virtual authenticators (Chrome guarantees this on session disconnect). Accepts an injectable `WebAuthnDriver` for testability. |
| `src/adapters/web/adapter.ts` | Defines a default `WebAuthnDriver` whose single `openSession(tab)` method delegates to `chrome.webAuthnOpenSession`, passes the driver to `buildInstallPasskeyTool` in the constructor, splices the tool into `toolDefinitions()`, dispatches `install_passkey` in `executeTool`, and calls `teardown()` in `close()` before killing Chrome. |
| `src/cli/run.ts`, `src/api/routes/run.ts` | **UNCHANGED.** The profilesDir wiring added for `read_profile` already carries passkey support — no new plumbing. |
| `src/adapters/{cli,tui}/adapter.ts` | **UNCHANGED.** No browser, no WebAuthn. The tool is web-only. |

| Test file | Coverage |
|---|---|
| `test/format/profile.test.ts` | `listPasskeyProfiles` on missing/empty/populated dirs; coexistence with flat markdown profiles; `readPasskey` parses valid JSON, rejects malformed, rejects missing fields, rejects path-escape names. |
| `test/adapters/passkey-tool.test.ts` | `buildInstallPasskeyTool` returns null when no passkeys exist; tool has no `enum` on its `name` parameter; first execute enables + adds authenticator + adds credential; subsequent executes reuse the authenticator; driver failures surface as tool-result errors; missing/unknown names return helpful errors listing available passkeys; teardown removes the authenticator when one was created and swallows errors. |
| `test/adapters/web/adapter.test.ts` | `install_passkey` is omitted when no passkey files exist and registered when at least one subdir has `passkey.json`. |

All tests use a synthetic fixture (`rpId: example.test`, placeholder
private key, obviously-fake credential ID) — no real credential
material ever enters the test tree.

### The tab-scoping gotcha

Virtual authenticators are scoped to a CDP target, which in our case
means tab 0 (the adapter hard-codes tab 0 in every chrome call). If
the agent opens a second tab mid-run and tries to authenticate
there, the authenticator won't be present on the new tab and the
login will fail silently. This isn't worth solving for v1 — single
tab is the universal pattern in Gauntlet — but it's worth writing
down.

## Chrome CDP WebAuthn gotchas (none of these are documented)

We hit three surprises getting passkey support working against a real
Chrome. Each cost at least one exploration round to find, and each
contradicts (or goes beyond) the published CDP docs. Writing them down
here so the next person doesn't re-derive them.

### 1. `WebAuthn.addCredential` wants standard base64, not base64url

The [CDP docs][cdp-webauthn] annotate `credentialId`, `privateKey`, and
`userHandle` as `base64url`-encoded. That's a lie — or at least, not
what Chrome 147 enforces. When you pass base64url (with `-`/`_`, no
padding), Chrome returns:

```
Failed to deserialize params.credential.credentialId - BINDINGS: invalid
base64 string at position N
```

Chrome's binding layer uses a strict base64 decoder that rejects the
base64url alphabet. Standard base64 (with `+`/`/` and `=` padding)
works cleanly. We normalize all three byte fields at the `readPasskey`
layer via `toStandardBase64` so a caller's JSON can be either flavor
and still pass Chrome's validator.

Discovered by reproducing locally, dropping down to a hand-rolled
WebSocket to get the full CDP error's `data` field (which was being
stripped by the pool wrapper), and reading the position number.

[cdp-webauthn]: https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/

### 2. Every WebAuthn call must ride a single pinned WebSocket

`WebAuthn.enable` and the virtual authenticator state it creates are
scoped to the specific DevTools session (WebSocket) they were called
on. The chrome-ws-lib connection pool silently opens new connections
and falls back to single-use WebSockets on timeouts, which means a
subsequent `addVirtualAuthenticator` or `addCredential` call can land
on a connection that never saw `enable`. Chrome then returns:

```
The Virtual Authenticator Environment has not been enabled for this session
```

The fix is `chrome-ws-lib.webAuthnOpenSession(tab)`, a dedicated
pinned-WebSocket helper that bypasses the pool and keeps one socket
alive for the full `enable → addVirtualAuthenticator → addCredential`
ceremony. The passkey-tool uses it exclusively; the rest of the
adapter's browser traffic still goes through the pool.

Discovered after the first flat-wrapper implementation failed against
live Chrome with the "not enabled" error — the pooled `send` was
randomly succeeding or failing depending on whether the pool happened
to have a cached connection that had seen `enable`.

### 3. Virtual authenticators die on every page navigation

Even though `webAuthnOpenSession` gives us a stable pinned WebSocket
that outlives navigations (same TargetID, same wsUrl, same open
socket on our side), **Chrome clears the WebAuthn domain state on
every same-target navigation**. After any `Page.navigate`, calling
`WebAuthn.getCredentials` on the same pinned session returns:

```
The Virtual Authenticator Environment has not been enabled for this session
```

Same error text as gotcha #2, different cause. Re-running `WebAuthn.enable`
makes the session "enabled" again, but the previously-created authenticator
ID is gone:

```
Could not find a Virtual Authenticator matching the ID
```

And any `navigator.credentials.get()` call the page makes after the
navigation — e.g. a Phoenix LiveView Passkey hook responding to a
server-pushed challenge — just *hangs*. It doesn't reject, doesn't
time out fast, doesn't log anything: it sits pending forever until
the caller-specified challenge timeout expires (2 minutes, in
NetworkEffect's case), by which point the agent has given up.

**The fix:** `install_passkey` fully rebuilds on every call — close
any prior session, open a new one, add the authenticator, add the
credential. The tool description tells the agent to call
`install_passkey` after every navigate and before any click that
triggers WebAuthn. Calls are cheap (~100ms of CDP round-trips) and
the agent learned the ordering from the description alone.

Discovered by building a local repro that installed an authenticator,
navigated the tab, and measured credentials.get() timings across
idle intervals and navigations. Idle had no effect; navigation broke
everything; fresh install after navigation recovered.

### Debugging infrastructure that made this findable

Two pieces of the feature paid for themselves multiple times during
this work and are worth keeping regardless of what else changes:

- **The observer session** (`chrome.openObserverSession` +
  `logger.logBrowserEvent`), which streams `Runtime.consoleAPICalled`,
  `Runtime.exceptionThrown`, `Log.entryAdded`, and `Network.webSocket*`
  events into per-category `.jsonl` files alongside the run's other
  evidence. `network-ws.jsonl` was what finally proved clicks were
  (and later weren't) reaching LiveView; `console.jsonl` surfaced
  phoenix.js transport errors we couldn't otherwise see.

- **Structured action-log entries from the passkey tool**
  (`install_passkey_ok` / `install_passkey_failed`), with a `step`
  label identifying exactly which CDP call was in flight and a
  `credential` object containing *sanitized* metadata (rpId, signCount,
  field lengths — never the credentialId or privateKey bytes). When
  Matt ran a failing session, the action log said "`step`:
  `add_credential`, error: `Invalid parameters`" and we went from
  "no idea" to "it's an encoding problem" in one message.

Neither is expensive. Both should stay.

## Follow-ups to consider after real-world use

1. **If the model reliably discovers and uses the tool**, keep it.
   We've validated the minimum experiment and can move on.
2. **If the model sometimes forgets the tool exists**, the cheapest
   next step is probably adding a one-line reminder to the system
   prompt: "Profile files are available via `read_profile`. Use it
   when a story names a user." No list, no bodies, just a nudge.
3. **If the model calls the tool but with wrong names**, re-adding
   the alias list to the tool description (or as an enum) is cheap.
4. **If credentials extraction from prose is flaky**, the author
   convention in the spec (`## Credentials` with bulleted
   `Username: ... / Password: ...` lines) is the guidance to lean on
   — document it for card authors rather than parse it in code.
5. **Path traversal** is blocked at the `readProfile` layer (rejects
   `name`s containing `/`, `\`, `..`, or a leading `.`). Still use
   throwaway credentials as the spec says; this is belt-and-suspenders,
   not a trust boundary.

## Signoff

Shipped as a single collapse from an earlier draft after a
conversation with Matt about what the spec actually needed to
become tangible. The initial deletions — frontmatter parsing,
`KeychainEntry`, the keychain-tool helper's display-name handling,
the system prompt section — were things the earlier draft had
over-built from reading the spec too literally.

A second round happened after Matt dropped a real passkey into
`.gauntlet/profiles/mhat/passkey.json` and pointed Gauntlet at
`https://networkeffect.dev`. That's the round that found the three
Chrome CDP WebAuthn gotchas above and led to the pinned-session
helper, the base64 normalization, and the rebuild-every-call passkey
tool. The observer session landed during the same round because
"the install seems to work but nothing happens" was otherwise
undebuggable.

A third round simplified: removed dead API surface, consolidated
tests, rewrote the passkey tool to flow top-to-bottom without
optimistic reuse. The tool description alone now tells the agent
everything it needs to know about when to re-call `install_passkey`
— validated by Matt's card author relaxing the procedural steps and
the agent still getting it right.

The experiment is: profiles as markdown read on demand
(`read_profile`), passkeys as JSON installed via CDP virtual
authenticator (`install_passkey`). Both tools self-document.
Debugging is backed by observer evidence files and structured
action-log entries. That's the whole thing.
