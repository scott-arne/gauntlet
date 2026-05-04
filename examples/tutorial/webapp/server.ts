// Tutorial webapp — a tiny social network for the Web tutorials
// in docs/tutorial.md. Pre-seeded users (Fred / Deborah / Quinn),
// hardcoded friend graph, in-memory posts, sessions trusted at
// face value.
//
// DO NOT use this code as a template for a real app. The "auth"
// check is `cookie.value in USERS`. There is no CSRF protection,
// no rate limiting, no input sanitization beyond HTML escaping,
// no real session storage. Passwords are in source. It exists
// to give the Web tutorials a deterministic target.

interface User {
  username: string;
  displayName: string;
  title: string;
}

const USERS: Record<string, User> = {
  fred: { username: "fred", displayName: "Fred", title: "Vampire Accountant" },
  deborah: { username: "deborah", displayName: "Deborah", title: "Ancient Vampire" },
  quinn: { username: "quinn", displayName: "Quinn", title: "Vampire" },
};

// Plain-text passwords. This is fine for a tutorial fixture and
// inappropriate for anything else.
const PASSWORDS: Record<string, string> = {
  fred: "vampire-tax-1099",
  deborah: "centuries-of-patience",
  quinn: "ambition-and-spite",
};

// Friend graph. Symmetric for honesty even though we only ever
// look at it from one direction.
const FRIENDS: Record<string, Set<string>> = {
  fred: new Set(["deborah"]),
  deborah: new Set(["fred"]),
  quinn: new Set(),
};

type Visibility = "public" | "friends";

interface Post {
  id: number;
  authorId: string;
  body: string;
  visibility: Visibility;
}

let posts: Post[] = [];
let nextPostId = 1;

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

function viewer(req: Request): User | null {
  const session = getCookie(req, "session");
  if (!session) return null;
  return USERS[session] ?? null;
}

function canSee(post: Post, viewerId: string | null): boolean {
  if (post.visibility === "public") return true;
  if (!viewerId) return false;
  if (post.authorId === viewerId) return true;
  return FRIENDS[post.authorId]?.has(viewerId) ?? false;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}

function pageShell(title: string, v: User | null, bodyHtml: string): string {
  const nav = v
    ? `<nav>@${v.username} · <a href="/signout">logout</a></nav>`
    : `<nav>not signed in · <a href="/login">sign in</a></nav>`;
  return `<!DOCTYPE html>
<html><head><title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2em auto; padding: 0 1em; }
  nav { background: #f0f0f0; padding: 0.75em 1em; margin-bottom: 1.5em; border-radius: 4px; }
  nav a { margin-left: 0.75em; }
  .post { border: 1px solid #ddd; padding: 0.75em 1em; margin-bottom: 0.75em; border-radius: 4px; }
  .post-meta { color: #666; font-size: 0.85em; }
  .visibility-friends { color: #b91c1c; font-weight: 600; }
  .visibility-public { color: #555; }
  .relation { color: #555; font-style: italic; margin-bottom: 1em; }
  .error { color: #b91c1c; font-weight: 600; }
  textarea, input[type="text"], input[type="password"] { width: 100%; box-sizing: border-box; }
  input[type="radio"] { margin-right: 0.4em; }
  label { display: block; margin: 0.5em 0; }
  fieldset { border: none; padding: 0; margin: 0.5em 0; }
  fieldset label { display: block; margin: 0.25em 0; }
  fieldset legend { padding: 0; font-weight: 600; margin-bottom: 0.25em; }
  form { margin: 1em 0; padding: 1em; background: #fafafa; border-radius: 4px; }
</style></head>
<body>
${nav}
${bodyHtml}
</body></html>`;
}

function renderPost(p: Post): string {
  return `<div class="post">
<div class="post-meta"><a href="/profile/${p.authorId}">@${p.authorId}</a></div>
<div>${escapeHtml(p.body)}</div>
<div class="visibility-${p.visibility}">${p.visibility === "friends" ? "🔒 Friends Only" : "Public"}</div>
</div>`;
}

function renderLoginForm(opts: { username?: string; error?: string } = {}): string {
  return `<h1>Sign in</h1>
<form method="POST" action="/login">
<label>Username: <input type="text" name="username" value="${escapeHtml(opts.username ?? "")}" autofocus required></label>
<label>Password: <input type="password" name="password" required></label>
<button type="submit">Sign in</button>
</form>
${opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : ""}`;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function redirect(to: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 303,
    headers: { location: to, ...extraHeaders },
  });
}

const PORT = 4444;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const v = viewer(req);

    if (url.pathname === "/" && req.method === "GET") {
      const visible = posts.filter((p) => canSee(p, v?.username ?? null));
      const composer = v
        ? `<form method="POST" action="/post">
<textarea name="body" rows="3" placeholder="Share something..." required></textarea>
<fieldset>
  <legend>Visibility</legend>
  <label><input type="radio" name="visibility" value="public" checked> Public</label>
  <label><input type="radio" name="visibility" value="friends"> Friends Only</label>
</fieldset>
<button type="submit">Post</button>
</form>`
        : `<p><a href="/login">Sign in</a> with username + password, or install a session cookie. Available users: <code>fred</code>, <code>deborah</code>, <code>quinn</code>.</p>`;
      return html(
        pageShell(
          "Feed",
          v,
          `<h1>Feed</h1>${composer}<h2>Posts</h2>${
            visible.length === 0 ? "<p>No posts yet.</p>" : visible.map(renderPost).join("\n")
          }`,
        ),
      );
    }

    const profileMatch = url.pathname.match(/^\/profile\/([^/]+)$/);
    if (profileMatch && req.method === "GET") {
      const target = USERS[profileMatch[1]!];
      if (!target) {
        return html(pageShell("Not found", v, "<h1>404 — no such user</h1>"), 404);
      }
      let relation = "Stranger";
      if (v) {
        if (v.username === target.username) relation = "(this is you)";
        else if (FRIENDS[target.username]?.has(v.username)) relation = "Friend";
        else relation = "Not a friend";
      }
      const visible = posts.filter(
        (p) => p.authorId === target.username && canSee(p, v?.username ?? null),
      );
      return html(
        pageShell(
          `@${target.username}`,
          v,
          `<h1>@${target.username}</h1>
<p><strong>${escapeHtml(target.displayName)}</strong> — ${escapeHtml(target.title)}</p>
<p class="relation">${relation}</p>
<h2>Posts</h2>
${visible.length === 0 ? "<p>No posts visible to you.</p>" : visible.map(renderPost).join("\n")}`,
        ),
      );
    }

    if (url.pathname === "/signin" && req.method === "GET") {
      return redirect("/login");
    }

    if (url.pathname === "/login" && req.method === "GET") {
      return html(pageShell("Sign in", v, renderLoginForm()));
    }

    if (url.pathname === "/login" && req.method === "POST") {
      const form = await req.formData();
      const username = String(form.get("username") ?? "").trim().toLowerCase();
      const password = String(form.get("password") ?? "");
      if (PASSWORDS[username] !== undefined && PASSWORDS[username] === password) {
        return redirect("/", {
          "set-cookie": `session=${username}; Path=/; HttpOnly`,
        });
      }
      return html(
        pageShell(
          "Sign in",
          v,
          renderLoginForm({ username, error: "Wrong username or password." }),
        ),
        401,
      );
    }

    if (url.pathname === "/post" && req.method === "POST") {
      if (!v) return new Response("sign in first", { status: 403 });
      const form = await req.formData();
      const body = String(form.get("body") ?? "").trim();
      const visibility: Visibility = form.get("visibility") === "friends" ? "friends" : "public";
      if (body) {
        posts.unshift({ id: nextPostId++, authorId: v.username, body, visibility });
      }
      return redirect("/");
    }

    if (url.pathname === "/signout" && req.method === "GET") {
      return redirect("/", { "set-cookie": "session=; Path=/; Max-Age=0" });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`Tutorial webapp listening on http://localhost:${PORT}`);
console.log(`Pre-seeded users: fred, deborah, quinn`);
console.log(`Friend graph: fred ↔ deborah; quinn alone`);
