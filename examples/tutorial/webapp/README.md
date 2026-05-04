# Tutorial webapp

A tiny social network for the Web tutorials in `docs/tutorial.md`.

```bash
bun server.ts
```

Listens on `http://localhost:4444`. Pre-seeded users:

- `fred` — vampire accountant. Friends with Deborah.
- `deborah` — ancient vampire. Friends with Fred.
- `quinn` — Fred's nemesis. Friends with no one.

Sessions, posts, and friend graph are all in process memory.
Restart the server to reset state.

## Don't use this for anything real

The "auth" check is `cookie.value in USERS`. There is no CSRF
protection, no rate limiting, no input sanitization beyond
HTML escaping, no real session storage. It exists to give the
Web tutorials a deterministic target. Treat the source as a
fixture, not a starter.
