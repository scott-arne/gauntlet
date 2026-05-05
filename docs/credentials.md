# Credentials in Gauntlet

When Gauntlet drives a real web app, it often needs to be
*already authenticated* before the test can do useful work.
Three paths cover the common cases:

- **Username and password** (most apps) — the agent reads the
  credentials from the user's profile and types them into the
  sign-in form using the regular browser tools. No special
  install tool is needed.
- **`install_cookies`** — set browser cookies before navigating
  to a cookie-gated origin. Useful when you have a session
  cookie in hand and want to skip the sign-in form entirely.
- **`install_passkey`** — register a virtual WebAuthn credential
  in the browser so passkey sign-ins succeed without a
  user-presence prompt.

The two install tools read their inputs from YAML files in your
project's `.gauntlet/context/` tree. The tool descriptions the
agent sees at runtime are authoritative; this document is the
human-facing reference that mirrors them.

## Username and password

The most common case. Most apps have a sign-in form; the agent
already knows how to find a form and type into it. There is no
`install_credentials` tool because there does not need to be
one — the profile supplies the values and the regular browser
tools do the rest.

A typical profile:

```markdown
# Alice

Marketing manager at Acme. Likes detailed UIs; hates modal dialogs.

## Credentials
- Username: alice@acme.test
- Password: hunter2-test
```

The card refers to the user by name in prose (*"Sign in as
Alice; create a draft post"*). The agent picks the profile by
inference, reads the credentials block, and signs in by
navigating to the sign-in page (or following a "Sign in" link
from the home page), typing into the username and password
fields, and submitting.

If the form layout is unusual — one combined "email or
username" field, a two-step flow with username first and
password on a separate page, an MFA challenge to skip past, a
"remember me" checkbox to leave alone — describe it in plain
English in a `HOW-TO-LOGIN.md` (or any name) at the root of
your context tree. The agent reads the whole tree as part of
its system prompt; the file just needs to exist.

Profile and `HOW-TO-LOGIN.md` files are routine context, not
secrets handled specially. Treat them like any other fixture.
The cookie and passkey YAML files below are different —
they're the only files in this doc that should be gitignored.

## Username and password

The most common case. Most apps have a sign-in form; the agent
already knows how to find a form and type into it. There is no
`install_credentials` tool because there does not need to be
one — the profile supplies the values and the regular browser
tools do the rest.

A typical profile:

```markdown
# Alice

Marketing manager at Acme. Likes detailed UIs; hates modal dialogs.

## Credentials
- Username: alice@acme.test
- Password: hunter2-test
```

The card refers to the user by name in prose (*"Sign in as
Alice; create a draft post"*). The agent picks the profile by
inference, reads the credentials block, and signs in by
navigating to the sign-in page (or following a "Sign in" link
from the home page), typing into the username and password
fields, and submitting.

If the form layout is unusual — one combined "email or
username" field, a two-step flow with username first and
password on a separate page, an MFA challenge to skip past, a
"remember me" checkbox to leave alone — describe it in plain
English in a `HOW-TO-LOGIN.md` (or any name) at the root of
your context tree. The agent reads the whole tree as part of
its system prompt; the file just needs to exist.

Profile and `HOW-TO-LOGIN.md` files are routine context, not
secrets handled specially. Treat them like any other fixture.
The cookie and passkey YAML files below are different —
they're the only files in this doc that should be gitignored.

## Where the files live

Cookies and passkeys live alongside a persona in the context
tree. A typical layout:

```
.gauntlet/context/
  profiles/
    alice/
      profile.md       prose: who Alice is
      cookies.yaml     for install_cookies
      passkey.yaml     for install_passkey
    bob/
      profile.md
      cookies.yaml
```

"Everything for one person under that person's folder" is
convention, not a requirement — the tools accept any path
under `.gauntlet/context/`. But colocation is what makes the
agent's inference work cleanly: if the story says *"as Alice"*,
the agent reads `profiles/alice/profile.md` for identity, then
finds `cookies.yaml` / `passkey.yaml` next to it for the
credentials.

## `install_cookies` · `cookies.yaml`

A YAML **list** of cookie entries. Each entry mirrors Chrome's
[`Network.setCookie`](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-setCookie)
parameters.

### Schema

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Cookie name |
| `value` | yes | Cookie value. Must be a **quoted** string in YAML — an unquoted token like `value: 12345` is rejected because YAML coerces it to a number first. |
| `url` | one of | Full URL the cookie is for. Chrome derives the cookie's domain and path from this URL — Gauntlet passes the field through to CDP unchanged. |
| `domain` | one of | Cookie's domain (e.g., `app.example.com`). Pair with `path`. |
| `path` | no | Cookie's path (default `/` when `domain` is given) |
| `secure` | no | Boolean. Required if `sameSite: None`. |
| `httpOnly` | no | Boolean. |
| `sameSite` | no | `Strict` \| `Lax` \| `None`. Case matters. |
| `expires` | no | Unix timestamp (seconds). Session cookie if omitted. |
| `priority` | no | `Low` \| `Medium` \| `High`. |
| `sameParty`, `sourceScheme`, `sourcePort` | no | CDP passthroughs; rarely needed. |

Supply *either* `url` *or* `domain`. Unknown fields are
rejected with a hint — typos like `samesite` (lowercase) get
a "did you mean `sameSite`?" message rather than being
silently dropped.

### Example

```yaml
- name: session
  value: c3RhdHVzPW9rOyBzaWQ9YWJjMTIz
  domain: networkeffect.dev
  path: /
  secure: true
  httpOnly: true
  sameSite: Lax
  expires: 1893456000  # 2030-01-01 UTC

- name: csrf
  value: kJh92h3jKdLm
  url: https://networkeffect.dev/
  secure: true
  sameSite: Strict
```

### Lifecycle

- **Install once, before navigating** to the cookie-gated origin.
- Cookies persist across same-origin navigations — you do not
  need to re-install.
- Gauntlet performs an initial `navigate` before any tool runs,
  so for apps that require a session cookie you must `navigate`
  *again* after installing.
- The tool returns a per-cookie summary: how many were accepted
  and which entries (if any) Chrome rejected and why.

## `install_passkey` · `passkey.yaml`

A YAML **mapping** describing a single WebAuthn credential.
Loaded into Chrome's virtual authenticator so the browser
answers WebAuthn challenges without a user-presence prompt.

### Schema

| Field | Required | Description |
|-------|----------|-------------|
| `credentialId` | yes | Base64 or base64url. Normalized internally. |
| `rpId` | yes | Relying-party ID (the origin's domain, e.g., `networkeffect.dev`). |
| `privateKey` | yes | Base64 or base64url. The key the authenticator signs with. |
| `signCount` | yes | Integer counter. Start at 0 unless you have history. |
| `isResidentCredential` | no | Boolean. Default false. |
| `userHandle` | no | Base64 or base64url. Required for resident-key flows. |

Both base64 and base64url encodings are accepted; Gauntlet
normalizes to standard base64 (with padding) before passing to
Chrome, working around a CDP quirk where the protocol docs
say base64url but the implementation requires standard base64.

### Example

```yaml
credentialId: AABCDDEEFGGHIJKKLLMMNN==
rpId: networkeffect.dev
privateKey: |
  MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg...
signCount: 0
isResidentCredential: true
userHandle: dXNlci0xMjM=
```

### Lifecycle

- **Re-install after every `navigate()`**, and before any
  click that triggers WebAuthn. Chrome clears virtual
  authenticators on every same-target navigation, and the
  authenticator does not survive.
- Calls are safe and cheap to repeat. The agent's tool
  description tells it this protocol explicitly, so the
  re-install behavior is automatic — but if you're debugging
  an "authenticator unavailable" error after navigation, this
  is the cause.
- The tool returns a success message naming the `rpId` on
  success; on failure, the message identifies the CDP step
  that failed.

## Obtaining the values

How do you actually get a credential or a usable cookie set?

- **Cookies** — sign in once manually in any browser, open
  DevTools → Application → Cookies, copy the values for the
  cookies you need. The CDP `setCookie` accepts the same
  fields the browser shows.
- **Passkey** — generate a credential once against your test
  account and record its bytes. This is the painful part of
  the workflow today; tooling here is evolving. Until a
  blessed path lands, the cleanest approach is to register a
  credential against the test account using a small WebAuthn
  helper script and write the resulting `credentialId` /
  `privateKey` / `signCount` into `passkey.yaml`.

**Do not commit either file.** Add `cookies.yaml` and
`passkey.yaml` to your `.gitignore`. They contain personal
auth material even for test accounts.

The run's action log (`run.jsonl`) records only the *length* of
each cookie value and never the bytes themselves; same for
passkey `credentialId` and `privateKey` fields. So the evidence
files Gauntlet writes to disk don't leak the secrets, even
though the YAML inputs do contain them.

## Lifecycle reference

|  | Cookies | Passkey |
|--|--|--|
| Persistence across navigation | Yes (same-origin) | No — cleared on every navigate |
| Install timing | Once, before first navigate | Before every WebAuthn click |
| Tool name | `install_cookies` | `install_passkey` |
| File shape | YAML list of entries | YAML mapping |

## See also

- Runtime tool descriptions in
  [`src/adapters/web/cookies.ts`](../src/adapters/web/cookies.ts)
  and [`src/adapters/web/passkey.ts`](../src/adapters/web/passkey.ts).
  These are what the agent reads at run time.
- Architecture review at
  [`docs/superpowers/plans/2026-04-15-gauntlet-v1.5-architecture-review.md`](./superpowers/plans/2026-04-15-gauntlet-v1.5-architecture-review.md)
  §3.2 (passkey) and §3.4 (cookies) for deeper rationale.
