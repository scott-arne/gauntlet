# Gauntlet tutorial — runnable scaffolding

This folder is the data side of [`docs/tutorial.md`](../../docs/tutorial.md).
Read the tutorial doc first; it walks you through five stories
across the CLI, TUI, and Web adapters. The files here are what
those stories read.

```
.gauntlet/
  context/
    profiles/
      fred/
        profile.md               primary persona — uses cookies
        cookies.yaml             session cookie for the local webapp
      deborah/
        profile.md               friend of Fred — uses username+password
      quinn/
        profile.md               Fred's nemesis — uses username+password
  stories/
    01-npm-init.md               CLI
    02-bun-init.md               TUI
    03-vim-split.md              TUI
    04-login-credentials.md      Web — sign in by username+password (Deborah)
    05-login-cookies.md          Web — sign in by cookie (Fred)
    06-post-and-verify.md        Web — friends-only + cross-identity check
webapp/
  server.ts                      local Bun social-network for Web stories
  README.md                      "bun server.ts" — listens on :4444
notes.md                         vim story fixture (Fred's accounting notes)
setup.ts                         vim story fixture (TypeScript content)
vimrc                            vim story fixture (M-series Mac workaround)
```

For Web tutorials 4 and 5, start the webapp first:

```bash
bun webapp/server.ts
```

Then run a story:

```bash
gauntlet run .gauntlet/stories/01-npm-init.md \
  --adapter cli \
  --target "mkdir -p scratch-npm && cd scratch-npm && npm init"
```
