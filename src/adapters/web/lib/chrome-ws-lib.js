// Forked from https://github.com/obra/superpowers-chrome
// Original author: Jesse Vincent
//
// See docs/upstream-sync.md for the sync protocol, last-synced upstream
// commit, and the full list of intentional Gauntlet divergences. Grep for
// "GAUNTLET DIVERGENCE" in this file to locate the regions a sync must
// preserve or hand-port rather than blindly copy from upstream.

/**
 * Chrome WebSocket Library - Core CDP automation functions
 * Used by both CLI and MCP server
 *
 * Fixes implemented:
 * - JRV-130: Connection pooling for persistent focus
 * - JRV-127: keyboard_press action for special keys
 * - JRV-123: React-compatible input via Input.insertText
 * - JRV-124: React-compatible click via Input.dispatchMouseEvent
 * - JRV-125: Tab key handling (via keyboard_press)
 * - JRV-126: Better eval return handling
 * - JRV-128: SPA navigation support
 * - JRV-129: Multi-element selector warnings
 */

// PRI-1436: per-session imports moved inside `createSession()` below.
// `hostOverride` and `activePort` are now per-instance — see the
// `GAUNTLET DIVERGENCE: createSession() factory` block.
const { createOverride } = require('./host-override');

// ===== GAUNTLET DIVERGENCE START: pickFreePort import =====
// Free-port picker used in launch mode. When no endpoint is configured
// via CHROME_WS_PORT or createSession({host, port}), we let the OS
// assign an ephemeral port for --remote-debugging-port so multiple
// Gauntlet instances (and co-tenants on 9222) don't collide. Upstream
// uses findAvailablePort() scanning 9222..12111 instead — see the
// same divergence marker inside startChrome() for where this is
// consumed.
const { pickFreePort } = require('../../../util/pick-free-port');
// ===== GAUNTLET DIVERGENCE END =====

// ===== GAUNTLET DIVERGENCE START: silence per-run lifecycle banners =====
// Upstream prints "Chrome started in <mode> mode (PID: ..., port: ...,
// profile: ...)" and similar per-run banners on stderr. In Gauntlet those
// fire once per card during a `gauntlet batch` run and clutter the output
// without buying anything actionable (the same info is in profile-meta.json
// and the run_start event). Silenced by default; set GAUNTLET_CHROME_VERBOSE=1
// to restore the banners for debugging chrome startup.
const CHROME_VERBOSE = !!process.env.GAUNTLET_CHROME_VERBOSE;
// ===== GAUNTLET DIVERGENCE END =====

// ===== GAUNTLET DIVERGENCE START: WebSocketClient (standard WebSocket API) =====
// Upstream uses Node's http.request + 'upgrade' event with a hand-rolled
// frame parser. We use the standard WebSocket API (works in both Node and
// Bun). All upstream features above this class call high-level helpers
// (sendCdpCommand et al.) that don't touch raw WS internals, so upstream
// changes rarely need to reach into this class. When syncing, preserve this
// class body verbatim — do not attempt to `git apply` upstream diffs onto
// it.
class WebSocketClient {
  constructor(url) {
    this.url = url;
    this.callbacks = {};
    this.ws = null;
    this.connected = false;
  }

  on(event, callback) {
    this.callbacks[event] = callback;
  }

  isConnected() {
    return this.connected && this.ws !== null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.addEventListener('open', () => {
        this.connected = true;
        if (this.callbacks.open) this.callbacks.open();
        resolve();
      });

      this.ws.addEventListener('message', (event) => {
        if (this.callbacks.message) {
          const data = typeof event.data === 'string' ? event.data : event.data.toString('utf8');
          this.callbacks.message(data);
        }
      });

      this.ws.addEventListener('error', (event) => {
        this.connected = false;
        if (this.callbacks.error) this.callbacks.error(event);
        reject(event);
      });

      this.ws.addEventListener('close', () => {
        this.connected = false;
        if (this.callbacks.close) this.callbacks.close();
      });
    });
  }

  send(data) {
    if (!this.ws || !this.connected) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(data);
  }

  close() {
    this.connected = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
// ===== GAUNTLET DIVERGENCE END =====

// Module-level registry of active session-cleanup callbacks.
// Per-session initializeSession adds its bound cleanup to the set;
// cleanupSession removes itself when it runs.
//
// Process exit handlers are registered exactly once for the whole module
// (not per session), so multiple ChromeSession instances in one process
// don't accumulate N×3 handlers. Hand-ported from upstream 2f28325 — the
// per-session createSession() factory turned each session's
// initializeSession() into a fresh process-handler registration; with
// `gauntlet serve` running multiple stories that's N×3 handlers per
// run. Now the handlers are registered once at module scope and iterate
// the set.
const activeCleanups = new Set();
let processHandlersRegistered = false;

function ensureProcessHandlersRegistered() {
  if (processHandlersRegistered) return;
  processHandlersRegistered = true;
  const runAll = () => { for (const fn of activeCleanups) fn(); };
  process.on('exit', runAll);
  process.on('SIGINT', () => { runAll(); process.exit(0); });
  process.on('SIGTERM', () => { runAll(); process.exit(0); });
}

// ===== GAUNTLET DIVERGENCE START: createSession() factory =====
// PRI-1436: Wraps the entire file body in a factory so each WebAdapter gets
// a private state-bag — fixes concurrent web runs in `gauntlet serve` that
// were sharing module-level globals (activePort, chromeProcess, profile
// name, connection pool, console messages, hostOverride). Future upstream
// syncs: paste upstream changes inside this closure. The internal API
// shape is unchanged from upstream — `module.exports` at the bottom is now
// `return { ... }` with the same flat shape, and the factory itself is the
// sole top-level export.
//
// Indentation: the closure body is intentionally NOT reindented. Diff
// readability against upstream matters more than indentation cosmetics —
// the closure's `{` and `}` sit at column 0 and the body keeps its
// original indentation. When syncing, paste upstream changes inside this
// closure exactly as they appear upstream.
function createSession({ host, port } = {}) {
const hostOverride = createOverride({ host, port });
const { rewriteWsUrl } = hostOverride;

// Dynamic port: updated by startChrome() when Chrome launches or reconnects.
// Defaults to host-override's port (which itself defaults to env or 9222).
let activePort = hostOverride.getPort();

// =============================================================================
// CONNECTION POOL (JRV-130: Fix focus lost between eval calls)
// =============================================================================

// Connection pool: maintains persistent WebSocket connections per tab
const connectionPool = new Map(); // wsUrl -> { ws: WebSocketClient, pendingRequests: Map, messageIdCounter: number }

/**
 * Get or create a pooled connection for a tab
 */
async function getPooledConnection(wsUrl) {
  let conn = connectionPool.get(wsUrl);

  if (conn && conn.ws.isConnected()) {
    return conn;
  }

  // Create new connection
  const ws = new WebSocketClient(wsUrl);
  conn = {
    ws,
    pendingRequests: new Map(), // id -> { resolve, reject, timeout }
    messageIdCounter: 1
  };

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.id !== undefined) {
        const pending = conn.pendingRequests.get(data.id);
        if (pending) {
          clearTimeout(pending.timeout);
          conn.pendingRequests.delete(data.id);
          if (data.error) {
            pending.reject(new Error(data.error.message || JSON.stringify(data.error)));
          } else {
            pending.resolve(data.result);
          }
        }
      }
      // Handle events (console messages, etc.)
      if (data.method && conn.eventHandler) {
        conn.eventHandler(data);
      }
    } catch (e) {
      console.error('Error processing CDP message:', e);
    }
  });

  ws.on('close', () => {
    connectionPool.delete(wsUrl);
    // Reject all pending requests
    for (const [id, pending] of conn.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    conn.pendingRequests.clear();
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });

  await ws.connect();
  connectionPool.set(wsUrl, conn);

  return conn;
}

/**
 * Send CDP command using pooled connection (maintains focus/state)
 */
async function sendCdpCommandPooled(wsUrl, method, params = {}, timeout = 30000) {
  const conn = await getPooledConnection(wsUrl);
  const id = conn.messageIdCounter++;

  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      conn.pendingRequests.delete(id);
      reject(new Error(`CDP command timeout: ${method}`));
    }, timeout);

    conn.pendingRequests.set(id, { resolve, reject, timeout: timeoutHandle });
    conn.ws.send(JSON.stringify({ id, method, params }));
  });
}

/**
 * Close pooled connection for a tab
 */
function closePooledConnection(wsUrl) {
  const conn = connectionPool.get(wsUrl);
  if (conn) {
    conn.ws.close();
    connectionPool.delete(wsUrl);
  }
}

/**
 * Close all pooled connections
 */
function closeAllConnections() {
  for (const [wsUrl, conn] of connectionPool) {
    conn.ws.close();
  }
  connectionPool.clear();
}

// HTTP helper with explicit host/port — used for probing ports before setting activePort
async function chromeHttpAt(host, port, path, method = 'GET') {
  const url = `http://${host}:${port}${path}`;
  const res = await fetch(url, { method });
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch (e) { return { message: text }; }
}

// Helper to make HTTP requests to Chrome on the active port
async function chromeHttp(path, method = 'GET') {
  return chromeHttpAt(hostOverride.getHost(), activePort, path, method);
}

// Console message storage per tab
const consoleMessages = new Map();

// Session management - uses XDG cache directories
let sessionDir = null;
let captureCounter = 0;

// Chrome process management
let chromeProcess = null;
let chromeHeadless = true; // Default to headless mode
let chromeUserDataDir = null;
// Intentional divergence from upstream obra/superpowers-chrome (which defaults
// to 'superpowers-chrome'): gauntlet must not share a profile dir with the
// upstream MCP, or test-run state bleeds into the user's interactive Chrome
// (and vice versa). See PRI-1444. Keep this comment when re-syncing upstream.
let chromeProfileName = 'gauntlet'; // Default profile name

// Helper to resolve tab index or ws URL to actual ws URL
async function resolveWsUrl(wsUrlOrIndex) {
  // If it's already a WebSocket URL, rewrite and return it
  if (typeof wsUrlOrIndex === 'string' && wsUrlOrIndex.startsWith('ws://')) {
    return rewriteWsUrl(wsUrlOrIndex, hostOverride.getHost(), activePort);
  }

  // If it's a number (tab index), resolve it
  const index = typeof wsUrlOrIndex === 'number' ? wsUrlOrIndex : parseInt(wsUrlOrIndex);
  if (!isNaN(index)) {
    const tabs = await chromeHttp('/json');
    if (!Array.isArray(tabs)) {
      throw new Error('Chrome DevTools returned an invalid response — is Chrome running?');
    }
    const pageTabs = tabs.filter(t => t.type === 'page');

    // Auto-create tab if none exist (similar to auto-start Chrome behavior)
    if (pageTabs.length === 0) {
      const newTabInfo = await newTab();
      return newTabInfo.webSocketDebuggerUrl;
    }

    if (index < 0 || index >= pageTabs.length) {
      throw new Error(`Tab index ${index} out of range (0-${pageTabs.length - 1})`);
    }
    return pageTabs[index].webSocketDebuggerUrl;
  }

  throw new Error(`Invalid tab specifier: ${wsUrlOrIndex}`);
}

// Message ID counter for legacy single-use connections
let messageIdCounter = 1;

// ===== GAUNTLET DIVERGENCE START: parseContains + :contains() support =====
// Upstream has no :contains() helper. We added one because LLM agents reach
// for jQuery-style `button:contains('Log in')` anyway, and a silent CSS
// syntax error wastes turns. getElementSelector / getElementSelectorAll
// below consume this — both have matching Gauntlet-only branches.
// Parse a :contains('text') / :contains("text") clause at the end of a
// selector. Returns { base, text } or null if the selector doesn't use
// :contains. The base may be empty (meaning "match any element"); we
// turn that into "*".
function parseContains(selector) {
  const m = selector.match(/^(.*?):contains\(\s*(['"])(.*?)\2\s*\)\s*$/);
  if (!m) return null;
  const base = m[1].trim();
  return { base: base || '*', text: m[3] };
}
// ===== GAUNTLET DIVERGENCE END =====

// Helper to generate element selection code (supports CSS, XPath, and
// jQuery-style :contains('text')). Prefers visible elements (non-zero
// bounding rect) over hidden ones; falls back to the first DOM match with
// a console.warn if all candidates are zero-sized. For XPath with
// text()='...', also tries normalize-space() fallback for mixed content
// elements.
function getElementSelector(selector) {
  if (selector.startsWith('/') || selector.startsWith('//')) {
    // XPath selector - collect all matches, prefer visible. For text()='...'
    // patterns, also tries normalize-space() fallback for mixed content
    // elements (e.g., <a><svg/>Settings</a> won't match text()='Settings'
    // but will match normalize-space()='Settings').
    const hasTextEquals = /text\(\)\s*=\s*['"]/.test(selector);
    const xpaths = [JSON.stringify(selector)];
    if (hasTextEquals) {
      const fallbackSelector = selector.replace(/text\(\)\s*=\s*(['"])(.*?)\1/g, "normalize-space()=$1$2$1");
      xpaths.push(JSON.stringify(fallbackSelector));
    }
    return `(() => {
      var all = [];
      var seen = new Set();
      [${xpaths.join(', ')}].forEach(function(xpath) {
        var iter = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
        var node;
        while (node = iter.iterateNext()) {
          if (!seen.has(node)) { seen.add(node); all.push(node); }
        }
      });
      if (all.length === 0) return null;
      var visible = all.find(function(el) {
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (visible) return visible;
      console.warn('[superpowers-chrome] All ' + all.length + ' elements matching XPath have zero dimensions; using first match');
      return all[0];
    })()`;
  }

  // jQuery-style :contains('text') — translate to a querySelectorAll walk.
  // Prefer visible matches, consistent with the CSS and XPath branches.
  const contains = parseContains(selector);
  if (contains) {
    return `(() => {
      var all = Array.from(document.querySelectorAll(${JSON.stringify(contains.base)})).filter(function(_el) {
        var _t = (_el.textContent || '').replace(/\\s+/g, ' ').trim();
        return _t.includes(${JSON.stringify(contains.text)});
      });
      if (all.length === 0) return null;
      var visible = all.find(function(el) {
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (visible) return visible;
      console.warn('[superpowers-chrome] All ' + all.length + ' elements matching :contains() have zero dimensions; using first match');
      return all[0];
    })()`;
  }

  // CSS selector - prefer visible elements
  return `(() => {
    var all = document.querySelectorAll(${JSON.stringify(selector)});
    if (all.length === 0) return null;
    var visible = Array.from(all).find(function(el) {
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (visible) return visible;
    console.warn('[superpowers-chrome] All ' + all.length + ' elements matching ' + ${JSON.stringify(JSON.stringify(selector))} + ' have zero dimensions; using first match');
    return all[0];
  })()`;
}

// Helper to get all matching elements (for JRV-129 warnings)
// For XPath with text()='...', also tries normalize-space() fallback for mixed content elements
function getElementSelectorAll(selector) {
  if (selector.startsWith('/') || selector.startsWith('//')) {
    // XPath - get all matches, with fallback for text()='...' patterns
    const hasTextEquals = /text\(\)\s*=\s*['"]/.test(selector);
    if (hasTextEquals) {
      const fallbackSelector = selector.replace(/text\(\)\s*=\s*(['"])(.*?)\1/g, "normalize-space()=$1$2$1");
      return `(() => {
        const result = [];
        const seen = new Set();
        for (const xpath of [${JSON.stringify(selector)}, ${JSON.stringify(fallbackSelector)}]) {
          const iterator = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
          let node;
          while (node = iterator.iterateNext()) {
            if (!seen.has(node)) { seen.add(node); result.push(node); }
          }
        }
        return result;
      })()`;
    }
    return `(() => {
      const result = [];
      const iterator = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
      let node;
      while (node = iterator.iterateNext()) result.push(node);
      return result;
    })()`;
  }

  // jQuery-style :contains('text')
  const contains = parseContains(selector);
  if (contains) {
    return `(() => {
      const _els = document.querySelectorAll(${JSON.stringify(contains.base)});
      const _want = ${JSON.stringify(contains.text)};
      return Array.from(_els).filter((_el) => {
        const _t = (_el.textContent || '').replace(/\\s+/g, ' ').trim();
        return _t.includes(_want);
      });
    })()`;
  }

  // CSS selector
  return `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`;
}

/**
 * Send CDP command using pooled connection (default - maintains focus)
 * Falls back to single-use connection if pool fails
 */
async function sendCdpCommand(wsUrl, method, params = {}, timeout = 30000) {
  try {
    return await sendCdpCommandPooled(wsUrl, method, params, timeout);
  } catch (e) {
    // Fallback to single-use connection for reliability
    console.error('Pooled connection failed, using single-use:', e.message);
    return await sendCdpCommandSingle(wsUrl, method, params, timeout);
  }
}

/**
 * Legacy single-use connection (for backwards compatibility)
 */
async function sendCdpCommandSingle(wsUrl, method, params = {}, timeout = 30000) {
  const ws = new WebSocketClient(wsUrl);

  return new Promise((resolve, reject) => {
    const id = messageIdCounter++;
    let resolved = false;

    ws.on('message', (msg) => {
      const data = JSON.parse(msg);
      if (data.id === id) {
        resolved = true;
        ws.close();
        if (data.error) {
          reject(new Error(data.error.message || JSON.stringify(data.error)));
        } else {
          resolve(data.result);
        }
      }
    });

    ws.on('error', (err) => {
      if (!resolved) {
        reject(err);
      }
    });

    ws.connect()
      .then(() => {
        ws.send(JSON.stringify({ id, method, params }));
      })
      .catch(reject);

    setTimeout(() => {
      if (!resolved) {
        ws.close();
        reject(new Error('CDP command timeout'));
      }
    }, timeout);
  });
}

// =============================================================================
// KEY NAME MAPPINGS (JRV-127: keyboard.press support)
// =============================================================================

// Map common key names to CDP key codes
// Keys with 'text' property will trigger native browser behaviors (form submit, etc.)
const KEY_DEFINITIONS = {
  // Navigation keys - text property needed for Enter/Tab to trigger native behaviors
  'Tab': { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  'Enter': { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
  'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  'Delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
  'Space': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },

  // Arrow keys
  'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },

  // Modifier keys
  'Shift': { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  'Control': { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  'Alt': { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  'Meta': { key: 'Meta', code: 'MetaLeft', keyCode: 91 },

  // Function keys
  'F1': { key: 'F1', code: 'F1', keyCode: 112 },
  'F2': { key: 'F2', code: 'F2', keyCode: 113 },
  'F3': { key: 'F3', code: 'F3', keyCode: 114 },
  'F4': { key: 'F4', code: 'F4', keyCode: 115 },
  'F5': { key: 'F5', code: 'F5', keyCode: 116 },
  'F6': { key: 'F6', code: 'F6', keyCode: 117 },
  'F7': { key: 'F7', code: 'F7', keyCode: 118 },
  'F8': { key: 'F8', code: 'F8', keyCode: 119 },
  'F9': { key: 'F9', code: 'F9', keyCode: 120 },
  'F10': { key: 'F10', code: 'F10', keyCode: 121 },
  'F11': { key: 'F11', code: 'F11', keyCode: 122 },
  'F12': { key: 'F12', code: 'F12', keyCode: 123 },

  // Other
  'Home': { key: 'Home', code: 'Home', keyCode: 36 },
  'End': { key: 'End', code: 'End', keyCode: 35 },
  'PageUp': { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  'PageDown': { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  'Insert': { key: 'Insert', code: 'Insert', keyCode: 45 },
};

// API Functions

async function getTabs() {
  const tabs = await chromeHttp('/json');
  if (!Array.isArray(tabs)) {
    return [];
  }
  return tabs
    .filter(tab => tab.type === 'page')
    .map(tab => ({
      ...tab,
      webSocketDebuggerUrl: rewriteWsUrl(tab.webSocketDebuggerUrl, hostOverride.getHost(), activePort)
    }));
}

async function newTab(url = 'about:blank') {
  const encoded = encodeURIComponent(url);
  const tab = await chromeHttp(`/json/new?${encoded}`, 'PUT');
  if (tab && typeof tab === 'object') {
    tab.webSocketDebuggerUrl = rewriteWsUrl(tab.webSocketDebuggerUrl, hostOverride.getHost(), activePort);
  }
  return tab;
}

async function closeTab(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const tabs = await chromeHttp('/json');
  if (!Array.isArray(tabs)) return;
  // PRI-1439: callers (e.g., WebAdapter's side-trip stack) cache the
  // *rewritten* WS URL — the one getTabs() returns after host-override.
  // Chrome's raw /json reports its own internal WS URL, which under a
  // remote-host override is different from what we cached. Compare on
  // the rewritten form so the find succeeds.
  const tab = tabs.find(t => {
    if (!t.webSocketDebuggerUrl) return false;
    const rewritten = rewriteWsUrl(t.webSocketDebuggerUrl, hostOverride.getHost(), activePort);
    return rewritten === wsUrl || t.webSocketDebuggerUrl === wsUrl;
  });
  if (tab) {
    await chromeHttp(`/json/close/${tab.id}`, 'GET');
  }
}

async function navigate(tabIndexOrWsUrl, url, autoCapture = false) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  // Clear previous console messages if auto-capture is on
  const startTime = new Date();
  if (autoCapture) {
    await clearConsoleMessages(tabIndexOrWsUrl);
  }

  // Navigate and wait for page load on a single connection to avoid race conditions.
  // Page.enable must be sent before Page.navigate on the same connection so the
  // Page.loadEventFired event is received.
  const NAVIGATE_TIMEOUT_MS = 30000;
  const CONSOLE_LINGER_MS = 1000;
  const navigateId = 9997;
  const result = await new Promise((resolve, reject) => {
    const ws = new WebSocketClient(wsUrl);
    let pageLoaded = false;
    let settled = false; // guard against double-resolve from race between events
    let navigateResult = {};

    function settle(action) {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (_e) { /* ignore */ }
      action();
    }

    // Listener WS errors / unexpected close → reject the navigate. Without
    // this, a dropped WS mid-flight hangs until the hard-cap timeout.
    ws.on('error', (err) => {
      settle(() => reject(new Error(`navigate listener WebSocket error: ${err && err.message || err}`)));
    });
    ws.on('close', () => {
      if (!pageLoaded) {
        settle(() => reject(new Error('navigate listener WebSocket closed before Page.loadEventFired')));
      }
    });

    ws.on('message', (msg) => {
      const data = JSON.parse(msg);

      // Capture the Page.navigate response (contains frameId)
      if (data.id === navigateId) {
        if (data.error) {
          settle(() => reject(new Error(`Page.navigate failed: ${data.error.message || JSON.stringify(data.error)}`)));
          return;
        }
        if (data.result) {
          navigateResult = data.result;
        }
      }

      if (data.method === 'Page.loadEventFired' && !pageLoaded) {
        pageLoaded = true;
        // Keep connection alive a bit longer for console messages if auto-capture is on
        if (autoCapture) {
          setTimeout(() => settle(() => resolve(navigateResult)), CONSOLE_LINGER_MS);
        } else {
          settle(() => resolve(navigateResult));
        }
      }

      // Capture console messages during navigation if auto-capture is on
      if (autoCapture && data.method === 'Runtime.consoleAPICalled') {
        const entry = data.params;
        const timestamp = new Date().toISOString();
        const level = entry.type || 'log';
        const args = entry.args || [];

        // Extract text from arguments
        const text = args.map(arg => {
          if (arg.type === 'string') return arg.value;
          if (arg.type === 'number') return String(arg.value);
          if (arg.type === 'boolean') return String(arg.value);
          if (arg.type === 'object') return arg.description || '[Object]';
          return String(arg.value || arg.description || arg.type);
        }).join(' ');

        const messages = consoleMessages.get(wsUrl) || [];
        messages.push({
          timestamp,
          level,
          text
        });
        consoleMessages.set(wsUrl, messages);
      }
    });

    ws.connect().then(() => {
      // Enable Page domain and navigate on THIS connection so we receive load events.
      // CDP processes messages in order per connection, so Page.enable takes effect
      // before Page.navigate begins.
      ws.send(JSON.stringify({ id: 9999, method: 'Page.enable', params: {} }));
      if (autoCapture) {
        ws.send(JSON.stringify({ id: 9998, method: 'Runtime.enable', params: {} }));
      }
      ws.send(JSON.stringify({ id: navigateId, method: 'Page.navigate', params: { url } }));
    }).catch((err) => settle(() => reject(err)));

    // Hard cap on the wait — slow servers, hung pages. Reject (don't
    // silently resolve) so the caller knows the page never loaded.
    setTimeout(() => {
      if (!pageLoaded) {
        settle(() => reject(new Error(`navigate timeout: ${url} did not fire Page.loadEventFired within ${NAVIGATE_TIMEOUT_MS}ms`)));
      }
    }, NAVIGATE_TIMEOUT_MS);
  });

  // Auto-capture if requested
  if (autoCapture) {
    try {
      const artifacts = await capturePageArtifacts(tabIndexOrWsUrl, 'navigate');

      // TODO: Fix console logging - currently returns empty array
      // The console logging needs a persistent WebSocket connection which
      // conflicts with the current single-use connection pattern
      const consoleLog = []; // Placeholder for now

      return {
        frameId: result.frameId,
        url,
        pageSize: artifacts.pageSize,
        capturePrefix: artifacts.capturePrefix,
        sessionDir: artifacts.sessionDir,
        files: artifacts.files,
        domSummary: artifacts.domSummary,
        consoleLog
      };
    } catch (error) {
      // If auto-capture fails, still return success but with error note
      return {
        frameId: result.frameId,
        url,
        error: `Auto-capture failed: ${error.message}`
      };
    }
  }

  return result.frameId;
}

// =============================================================================
// CLICK FUNCTION (JRV-124: Now uses CDP mouse events by default)
// =============================================================================

/**
 * Click element using CDP mouse events (works with React and all frameworks)
 * Falls back to el.click() if CDP approach fails
 */
async function click(tabIndexOrWsUrl, selector) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  // First: find the element and get its bounding box. This evaluation also
  // covers any syntax errors in the selector (which surface as exception
  // details on the result). We distinguish three outcomes:
  //   - element found and measured → mouse events path
  //   - element not found          → throw a clear "not found" error
  //   - selector syntax error      → throw the JS error text
  const findJs = `
    (() => {
      try {
        const el = ${getElementSelector(selector)};
        if (!el) return { found: false };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        return {
          found: true,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height,
        };
      } catch (err) {
        return { found: false, error: String(err && err.message || err) };
      }
    })()
  `;

  const findResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: findJs,
    returnByValue: true,
  });
  throwIfExceptionDetails(findResult);

  const value = findResult && findResult.result && findResult.result.value;
  if (!value || !value.found) {
    const reason = value && value.error
      ? ` (${value.error})`
      : '';
    throw new Error(`Element not found: ${selector}${reason}`);
  }

  const { x, y, width, height } = value;
  if (!width || !height) {
    // Element exists but has no layout box (display:none, hidden, detached).
    // Fall back to el.click() — the native click handler may still fire.
    const clickJs = `${getElementSelector(selector)}?.click()`;
    const fallbackResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', { expression: clickJs });
    throwIfExceptionDetails(fallbackResult);
    return { clicked: true, fallback: 'zero-size' };
  }

  try {
    // Send real mouse events (works with React synthetic events and
    // Phoenix LiveView's document-level delegated `phx-click` listener).
    await sendCdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1,
    });
    await sendCdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
    });
    return { clicked: true, x, y };
  } catch (e) {
    // Mouse events themselves failed (rare — Input domain unreachable etc.).
    // Fall back to el.click() but report we did so.
    const clickJs = `${getElementSelector(selector)}?.click()`;
    const fallbackResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', { expression: clickJs });
    throwIfExceptionDetails(fallbackResult);
    return { clicked: true, fallback: 'mouse-event-error' };
  }
}

// Legacy alias for backwards compatibility
const cdpClick = click;

// =============================================================================
// HOVER FUNCTION - CDP mouse move to element
// =============================================================================

/**
 * Hover over an element using CDP mouse events.
 * Triggers CSS :hover, mouseenter/mouseover events, tooltips, dropdown menus.
 */
async function hover(tabIndexOrWsUrl, selector) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  const js = `
    (() => {
      const el = ${getElementSelector(selector)};
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        found: true
      };
    })()
  `;

  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  throwIfExceptionDetails(result);

  if (!result.result.value || !result.result.value.found) {
    throw new Error(`Element not found: ${selector}`);
  }

  const { x, y } = result.result.value;

  await sendCdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y
  });

  return { hovered: true, x, y };
}

// =============================================================================
// DRAG AND DROP - CDP mouse event sequence for native drag-and-drop
// =============================================================================

/**
 * Drag from source element to target element or coordinates.
 * Uses CDP Input.dispatchMouseEvent to trigger native drag-and-drop,
 * bypassing the DataTransfer restriction on synthetic JS DragEvents.
 *
 * @param {number|string} tabIndexOrWsUrl - Tab index or WebSocket URL
 * @param {string} sourceSelector - CSS/XPath selector for the drag source
 * @param {string|{x:number,y:number}} target - Target selector string or {x,y} coordinates
 * @param {object} options - Optional settings
 * @param {number} options.steps - Number of intermediate mouseMoved steps (default: 8)
 */
async function drag(tabIndexOrWsUrl, sourceSelector, target, options = {}) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const steps = options.steps || 8;

  // Resolve source element coordinates
  const sourceJs = `
    (() => {
      const el = ${getElementSelector(sourceSelector)};
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        found: true
      };
    })()
  `;

  const sourceResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: sourceJs,
    returnByValue: true
  });
  throwIfExceptionDetails(sourceResult);

  if (!sourceResult.result.value || !sourceResult.result.value.found) {
    throw new Error(`Source element not found: ${sourceSelector}`);
  }

  const src = sourceResult.result.value;

  // Resolve target coordinates (selector string or {x,y} object)
  let dst;
  if (typeof target === 'object' && target.x !== undefined && target.y !== undefined) {
    dst = { x: target.x, y: target.y };
  } else {
    const targetJs = `
      (() => {
        const el = ${getElementSelector(target)};
        if (!el) return { found: false };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          found: true
        };
      })()
    `;

    const targetResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression: targetJs,
      returnByValue: true
    });
    throwIfExceptionDetails(targetResult);

    if (!targetResult.result.value || !targetResult.result.value.found) {
      throw new Error(`Target element not found: ${target}`);
    }

    dst = { x: targetResult.result.value.x, y: targetResult.result.value.y };
  }

  // 1. Press at source
  await sendCdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: src.x,
    y: src.y,
    button: 'left',
    clickCount: 1
  });

  // 2. Move in intermediate steps (exceeds browser's ~4px drag detection threshold)
  for (let i = 1; i <= steps; i++) {
    const ratio = i / steps;
    await sendCdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(src.x + (dst.x - src.x) * ratio),
      y: Math.round(src.y + (dst.y - src.y) * ratio),
      button: 'left'
    });
  }

  // 3. Brief pause for apps that process drag events asynchronously
  await new Promise(resolve => setTimeout(resolve, 50));

  // 4. Release at target
  await sendCdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(dst.x),
    y: Math.round(dst.y),
    button: 'left',
    clickCount: 1
  });

  return { dragged: true, from: { x: src.x, y: src.y }, to: { x: dst.x, y: dst.y }, steps };
}

// =============================================================================
// MOUSE MOVE - Raw coordinate mouse movement
// =============================================================================

/**
 * Move mouse to specific coordinates with optional intermediate steps.
 * Useful for: pre-click mouse patterns (bot detection), captcha puzzles,
 * hover effects on coordinate-based targets.
 *
 * @param {number|string} tabIndexOrWsUrl - Tab index or WebSocket URL
 * @param {number} x - Target X coordinate (CSS pixels)
 * @param {number} y - Target Y coordinate (CSS pixels)
 * @param {object} options
 * @param {number} options.steps - Intermediate steps for smooth movement (default: 1)
 * @param {number} options.fromX - Starting X for interpolation
 * @param {number} options.fromY - Starting Y for interpolation
 */
async function mouseMove(tabIndexOrWsUrl, x, y, options = {}) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const steps = options.steps || 1;

  if (steps <= 1 || (options.fromX === undefined && options.fromY === undefined)) {
    await sendCdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x),
      y: Math.round(y)
    });
  } else {
    const startX = options.fromX || 0;
    const startY = options.fromY || 0;
    for (let i = 1; i <= steps; i++) {
      const ratio = i / steps;
      await sendCdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(startX + (x - startX) * ratio),
        y: Math.round(startY + (y - startY) * ratio)
      });
    }
  }

  return { moved: true, x, y };
}

// =============================================================================
// SCROLL - Mouse wheel events
// =============================================================================

/**
 * Scroll using CDP mouse wheel events.
 * Simulates real mouse wheel input (vs. JavaScript scrollTo which bot detectors flag).
 *
 * @param {number|string} tabIndexOrWsUrl - Tab index or WebSocket URL
 * @param {object} options
 * @param {string} options.selector - Optional element to scroll within
 * @param {number} options.deltaX - Horizontal scroll amount (positive = right)
 * @param {number} options.deltaY - Vertical scroll amount (positive = down)
 */
async function scroll(tabIndexOrWsUrl, options = {}) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  // Determine mouse position for the wheel event
  let x = options.x || 100;
  let y = options.y || 100;

  if (options.selector) {
    const js = `
      (() => {
        const el = ${getElementSelector(options.selector)};
        if (!el) return { found: false };
        const rect = el.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          found: true
        };
      })()
    `;
    const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression: js,
      returnByValue: true
    });
    throwIfExceptionDetails(result);
    if (result.result.value && result.result.value.found) {
      x = result.result.value.x;
      y = result.result.value.y;
    }
  }

  await sendCdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(x),
    y: Math.round(y),
    deltaX: options.deltaX || 0,
    deltaY: options.deltaY || 0
  });

  return { scrolled: true, x, y, deltaX: options.deltaX || 0, deltaY: options.deltaY || 0 };
}

// =============================================================================
// DOUBLE CLICK - clickCount: 2
// =============================================================================

/**
 * Double-click an element using CDP mouse events.
 * Fires mousedown, mouseup, click, mousedown, mouseup, click, dblclick.
 */
async function doubleClick(tabIndexOrWsUrl, selector) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  const js = `
    (() => {
      const el = ${getElementSelector(selector)};
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        found: true
      };
    })()
  `;

  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  throwIfExceptionDetails(result);

  if (!result.result.value || !result.result.value.found) {
    throw new Error(`Element not found: ${selector}`);
  }

  const { x, y } = result.result.value;

  // First click
  await sendCdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1
  });
  await sendCdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1
  });

  // Second click (clickCount: 2 triggers dblclick)
  await sendCdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 2
  });
  await sendCdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 2
  });

  return { doubleClicked: true, x, y };
}

// =============================================================================
// RIGHT CLICK - button: 'right', contextmenu
// =============================================================================

/**
 * Right-click an element using CDP mouse events.
 * Fires mousedown (button 2), mouseup (button 2), contextmenu.
 */
async function rightClick(tabIndexOrWsUrl, selector) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  const js = `
    (() => {
      const el = ${getElementSelector(selector)};
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        found: true
      };
    })()
  `;

  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  throwIfExceptionDetails(result);

  if (!result.result.value || !result.result.value.found) {
    throw new Error(`Element not found: ${selector}`);
  }

  const { x, y } = result.result.value;

  await sendCdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'right', clickCount: 1
  });
  await sendCdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'right', clickCount: 1
  });

  return { rightClicked: true, x, y };
}

// =============================================================================
// HUMAN TYPE - Realistic character-by-character keyboard input
// =============================================================================

// Map characters to their physical key representations for CDP
// Uppercase letters and shifted symbols need Shift modifier
const SHIFT_SYMBOLS = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5',
  '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\',
  ':': ';', '"': "'", '<': ',', '>': '.', '?': '/',
  '~': '`',
};

function charToKeyDef(char) {
  // Special characters handled by keyboardPress
  if (char === '\n') return { special: 'Enter' };
  if (char === '\t') return { special: 'Tab' };

  // Space
  if (char === ' ') {
    return { key: ' ', code: 'Space', keyCode: 32, text: ' ', shift: false };
  }

  // Uppercase letter
  if (char >= 'A' && char <= 'Z') {
    return {
      key: char,
      code: 'Key' + char,
      keyCode: char.charCodeAt(0),
      text: char,
      shift: true
    };
  }

  // Lowercase letter
  if (char >= 'a' && char <= 'z') {
    return {
      key: char,
      code: 'Key' + char.toUpperCase(),
      keyCode: char.toUpperCase().charCodeAt(0),
      text: char,
      shift: false
    };
  }

  // Digit
  if (char >= '0' && char <= '9') {
    return {
      key: char,
      code: 'Digit' + char,
      keyCode: char.charCodeAt(0),
      text: char,
      shift: false
    };
  }

  // Shifted symbol
  if (SHIFT_SYMBOLS[char]) {
    const baseChar = SHIFT_SYMBOLS[char];
    let code;
    if (baseChar >= '0' && baseChar <= '9') {
      code = 'Digit' + baseChar;
    } else {
      // Punctuation keys
      const punctCodes = {
        '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
        '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote',
        ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote',
      };
      code = punctCodes[baseChar] || 'Unidentified';
    }
    return {
      key: char,
      code,
      keyCode: baseChar.charCodeAt(0),
      text: char,
      shift: true
    };
  }

  // Unshifted punctuation
  const punctCodes = {
    '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
    '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote',
    ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote',
  };
  if (punctCodes[char]) {
    return {
      key: char,
      code: punctCodes[char],
      keyCode: char.charCodeAt(0),
      text: char,
      shift: false
    };
  }

  // Fallback: use the character directly
  return {
    key: char,
    code: 'Unidentified',
    keyCode: char.charCodeAt(0),
    text: char,
    shift: false
  };
}

/**
 * Type text character-by-character using individual keyDown/keyUp events
 * with realistic inter-key timing. Simulates hardware keyboard input
 * that bypasses bot detection (vs. Input.insertText which is instant).
 *
 * @param {number|string} tabIndexOrWsUrl - Tab index or WebSocket URL
 * @param {string|null} selector - Element to focus first (null = current focus)
 * @param {string} text - Text to type
 * @param {object} options
 * @param {number} options.delay - Base delay between keystrokes in ms (default: 80)
 * @param {number} options.jitter - Random jitter range in ms (default: 80, so 80-160ms total)
 */
async function humanType(tabIndexOrWsUrl, selector, text, options = {}) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const delay = options.delay !== undefined ? options.delay : 80;
  const jitter = options.jitter !== undefined ? options.jitter : 80;

  // Click to focus if selector provided
  if (selector) {
    await click(tabIndexOrWsUrl, selector);
  }

  for (const char of text) {
    const keyDef = charToKeyDef(char);

    // Handle special keys (Enter, Tab)
    if (keyDef.special) {
      await keyboardPress(tabIndexOrWsUrl, keyDef.special);
    } else {
      // In headed mode, send full keyDown/keyUp events (fires JS keyboard events
      // for bot detection). In headless mode, rawKeyDown triggers Chrome browser
      // shortcuts that navigate away from the page, so we skip key events and
      // rely on insertText + per-character timing for bot-detection resistance.
      const sendKeyEvents = !chromeHeadless;
      const modifiers = keyDef.shift ? 8 : 0; // 8 = Shift

      if (sendKeyEvents) {
        // Press Shift if needed
        if (keyDef.shift) {
          await sendCdpCommand(wsUrl, 'Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'Shift',
            code: 'ShiftLeft',
            windowsVirtualKeyCode: 16,
            nativeVirtualKeyCode: 16,
            modifiers
          });
        }

        // keyDown
        await sendCdpCommand(wsUrl, 'Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: keyDef.key,
          code: keyDef.code,
          windowsVirtualKeyCode: keyDef.keyCode,
          nativeVirtualKeyCode: keyDef.keyCode,
          modifiers
        });
      }

      // insertText for reliable character insertion (works in both modes)
      await sendCdpCommand(wsUrl, 'Input.insertText', {
        text: keyDef.text
      });

      if (sendKeyEvents) {
        // keyUp
        await sendCdpCommand(wsUrl, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: keyDef.key,
          code: keyDef.code,
          windowsVirtualKeyCode: keyDef.keyCode,
          nativeVirtualKeyCode: keyDef.keyCode,
          modifiers
        });

        // Release Shift if needed
        if (keyDef.shift) {
          await sendCdpCommand(wsUrl, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Shift',
            code: 'ShiftLeft',
            windowsVirtualKeyCode: 16,
            nativeVirtualKeyCode: 16,
            modifiers: 0
          });
        }
      }
    }

    // Variable delay between keystrokes
    if (delay > 0 || jitter > 0) {
      const wait = delay + Math.random() * jitter;
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }

  return { typed: text, chars: text.length };
}

// =============================================================================
// FILE UPLOAD - Set files on input[type=file] elements
// =============================================================================

/**
 * Upload files to an input[type=file] element using DOM.setFileInputFiles.
 * This is the only way to programmatically set files on a file input
 * (security restrictions prevent JavaScript from doing it).
 *
 * @param {number|string} tabIndexOrWsUrl - Tab index or WebSocket URL
 * @param {string} selector - CSS/XPath selector for the file input
 * @param {string[]} filePaths - Array of absolute file paths to upload
 */
async function fileUpload(tabIndexOrWsUrl, selector, filePaths) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  // Get the DOM node ID for the file input
  const docResult = await sendCdpCommand(wsUrl, 'DOM.getDocument', {});
  const rootNodeId = docResult.root.nodeId;

  // Find the element
  let nodeId;
  if (selector.startsWith('/') || selector.startsWith('//')) {
    // XPath
    const searchResult = await sendCdpCommand(wsUrl, 'DOM.performSearch', {
      query: selector
    });
    if (searchResult.resultCount === 0) {
      throw new Error(`File input not found: ${selector}`);
    }
    const nodesResult = await sendCdpCommand(wsUrl, 'DOM.getSearchResults', {
      searchId: searchResult.searchId,
      fromIndex: 0,
      toIndex: 1
    });
    nodeId = nodesResult.nodeIds[0];
  } else {
    // CSS selector
    const queryResult = await sendCdpCommand(wsUrl, 'DOM.querySelector', {
      nodeId: rootNodeId,
      selector: selector
    });
    nodeId = queryResult.nodeId;
  }

  if (!nodeId) {
    throw new Error(`File input not found: ${selector}`);
  }

  // Set the files
  await sendCdpCommand(wsUrl, 'DOM.setFileInputFiles', {
    files: filePaths,
    nodeId: nodeId
  });

  return { uploaded: true, files: filePaths.length };
}

// =============================================================================
// TYPE FUNCTION - Smart text input with Tab/Enter handling
// =============================================================================

/**
 * Type text into current focus (or focus selector first if provided).
 * Routes through humanType() so text input gets realistic per-character
 * keystroke timing by default (hand-ported from upstream's v1.12.0
 * "merge human_type into type").
 *
 * Special characters:
 *   \t = Tab (moves to next field)
 *   \n = Enter (submits form; in a textarea, Enter inserts a newline)
 *
 * Examples:
 *   fill(0, null, "hello")                    // type into current focus
 *   fill(0, "#email", "user@example.com")     // focus #email, then type
 *   fill(0, "#email", "user@example.com\tpassword\n")  // type, tab, type, submit
 */
async function fill(tabIndexOrWsUrl, selector, value) {
  // Convert literal escape sequences to actual characters
  // (payloads from JSON/CLI may contain literal \t and \n rather than
  // actual tab/newline). humanType treats '\t' and '\n' as Tab/Enter.
  const processedValue = value
    .replace(/\\t/g, '\t')
    .replace(/\\n/g, '\n');

  const result = await humanType(tabIndexOrWsUrl, selector || null, processedValue);
  return { typed: true, value, chars: result.chars };
}

// Legacy alias
const insertText = fill;

/**
 * Press a special key using CDP Input.dispatchKeyEvent (JRV-127, JRV-125)
 * Supports: Tab, Enter, Escape, Arrow keys, F1-F12, etc.
 */
async function keyboardPress(tabIndexOrWsUrl, keyName, modifiers = {}) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  const keyDef = KEY_DEFINITIONS[keyName];
  if (!keyDef) {
    throw new Error(`Unknown key: ${keyName}. Supported keys: ${Object.keys(KEY_DEFINITIONS).join(', ')}`);
  }

  // Calculate modifier flags
  let modifierFlags = 0;
  if (modifiers.alt) modifierFlags |= 1;
  if (modifiers.ctrl) modifierFlags |= 2;
  if (modifiers.meta) modifierFlags |= 4;
  if (modifiers.shift) modifierFlags |= 8;

  // Send keyDown (include text property if defined - needed for form submission, etc.)
  await sendCdpCommand(wsUrl, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: keyDef.key,
    code: keyDef.code,
    windowsVirtualKeyCode: keyDef.keyCode,
    nativeVirtualKeyCode: keyDef.keyCode,
    modifiers: modifierFlags,
    ...(keyDef.text && { text: keyDef.text })
  });

  // Send keyUp
  await sendCdpCommand(wsUrl, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyDef.key,
    code: keyDef.code,
    windowsVirtualKeyCode: keyDef.keyCode,
    nativeVirtualKeyCode: keyDef.keyCode,
    modifiers: modifierFlags
  });

  return { pressed: keyName, modifiers };
}

/**
 * Type text character by character using CDP (for complex input scenarios)
 */
async function keyboardType(tabIndexOrWsUrl, text) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  for (const char of text) {
    if (char === '\n') {
      await keyboardPress(tabIndexOrWsUrl, 'Enter');
    } else if (char === '\t') {
      await keyboardPress(tabIndexOrWsUrl, 'Tab');
    } else {
      // Regular character - use insertText
      await sendCdpCommand(wsUrl, 'Input.insertText', { text: char });
    }
  }

  return { typed: text };
}

// =============================================================================
// SELECT FUNCTION (JRV-129: Multi-element warning)
// =============================================================================

/**
 * Select dropdown option(s).
 *
 * `value` is a string or array of strings. Each entry matches an <option> by
 * value attribute first, then by trimmed visible label. Arrays require
 * <select multiple>. Replaces the current selection (does not append).
 */
async function selectOption(tabIndexOrWsUrl, selector, value, index = 0) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const values = Array.isArray(value) ? value : [value];

  // Check how many elements match and warn if multiple
  const countJs = `${getElementSelectorAll(selector)}.length`;
  const countResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: countJs,
    returnByValue: true
  });
  throwIfExceptionDetails(countResult);
  const matchCount = countResult.result.value || 0;

  let warning = null;
  if (matchCount > 1) {
    warning = `Selector "${selector}" matches ${matchCount} elements. Using element at index ${index}. Use a more specific selector or pass index parameter.`;
    console.error(`WARNING: ${warning}`);
  }

  const js = `
    (() => {
      const elements = ${getElementSelectorAll(selector)};
      const el = elements[${index}];
      if (!el) return { success: false, error: 'Element not found at index ${index}' };
      if (el.tagName !== 'SELECT') return { success: false, error: 'Element is not a SELECT' };

      const requested = ${JSON.stringify(values)};
      if (requested.length > 1 && !el.multiple) {
        return { success: false, error: 'Cannot select multiple values on a non-multiple <select>' };
      }

      const options = Array.from(el.options);
      const matched = [];
      const unmatched = [];
      for (const v of requested) {
        const opt = options.find(o => o.value === v) ||
                    options.find(o => o.textContent.trim() === v);
        if (opt) matched.push(opt);
        else unmatched.push(v);
      }
      if (unmatched.length) {
        return { success: false, error: 'No matching option for: ' + JSON.stringify(unmatched) };
      }

      for (const o of options) o.selected = false;
      for (const o of matched) o.selected = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));

      return {
        success: true,
        matchCount: elements.length,
        matched: matched.map(o => ({ value: o.value, text: o.textContent.trim() }))
      };
    })()
  `;

  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  throwIfExceptionDetails(result);

  const resultValue = result.result.value;
  if (!resultValue.success) {
    throw new Error(resultValue.error);
  }

  return {
    success: true,
    matchCount: resultValue.matchCount,
    matched: resultValue.matched,
    warning,
    selectedIndex: index
  };
}

// =============================================================================
// EVALUATE FUNCTIONS (JRV-126: Better return value handling)
// =============================================================================

/**
 * Inspect a CDP `Runtime.evaluate` reply and throw if the page-side JS threw
 * or a Promise rejected. Without this, callers silently see `undefined`
 * instead of the actual error — which has caused real bugs (waitForElement
 * timeouts swallowed, evaluate returning {} for thrown errors). Use after
 * every `sendCdpCommand(...,'Runtime.evaluate',...)`.
 */
function throwIfExceptionDetails(result) {
  if (!result || !result.exceptionDetails) return;
  const desc = result.exceptionDetails.exception?.description
    || result.exceptionDetails.text
    || 'unknown evaluation error';
  throw new Error(`evaluate failed: ${desc}`);
}

/**
 * Legacy evaluate - may return undefined for complex objects.
 * Awaits promises so async expressions (fetch, async IIFEs) resolve before
 * returning — matches evaluateJson()'s behavior.
 */
async function evaluate(tabIndexOrWsUrl, expression) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  throwIfExceptionDetails(result);
  return result.result.value;
}

/**
 * Enhanced evaluate with automatic JSON serialization (JRV-126)
 * Handles complex objects, arrays, DOM nodes better
 */
async function evaluateJson(tabIndexOrWsUrl, expression) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  // Wrap in JSON.stringify to handle complex return values
  const wrappedExpression = `
    (() => {
      try {
        const result = ${expression};
        if (result === undefined) return { __type: 'undefined' };
        if (result === null) return null;
        if (result instanceof Element) {
          return {
            __type: 'Element',
            tagName: result.tagName,
            id: result.id,
            className: result.className,
            textContent: result.textContent?.slice(0, 100)
          };
        }
        if (typeof result === 'function') {
          return { __type: 'function', name: result.name || 'anonymous' };
        }
        return result;
      } catch (e) {
        return { __type: 'error', message: e.message };
      }
    })()
  `;

  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: wrappedExpression,
    returnByValue: true,
    awaitPromise: true
  });
  throwIfExceptionDetails(result);
  return result.result.value;
}

/**
 * Get raw CDP result including type information
 */
async function evaluateRaw(tabIndexOrWsUrl, expression) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression,
    returnByValue: false
  });
  throwIfExceptionDetails(result);
  return result.result;
}

// =============================================================================
// NAVIGATION FUNCTIONS (JRV-128: SPA navigation support)
// =============================================================================

/**
 * SPA-compatible navigation using history.pushState (JRV-128)
 * Doesn't reload the page, works with client-side routers
 */
async function spaNavigate(tabIndexOrWsUrl, path, options = {}) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  const { state = {}, title = '', dispatchPopstate = true } = options;

  const js = `
    (() => {
      const path = ${JSON.stringify(path)};
      const state = ${JSON.stringify(state)};
      const title = ${JSON.stringify(title)};

      // Use pushState for SPA navigation
      history.pushState(state, title, path);

      // Dispatch popstate event so React Router / Vue Router / etc. picks it up
      ${dispatchPopstate ? `window.dispatchEvent(new PopStateEvent('popstate', { state }));` : ''}

      return {
        success: true,
        path,
        href: window.location.href
      };
    })()
  `;

  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  throwIfExceptionDetails(result);

  return result.result.value;
}

/**
 * Navigate using location.href (triggers page reload)
 */
async function hrefNavigate(tabIndexOrWsUrl, url) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  const js = `
    (() => {
      window.location.href = ${JSON.stringify(url)};
      return { navigating: true, url: ${JSON.stringify(url)} };
    })()
  `;

  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  throwIfExceptionDetails(result);

  return result.result.value;
}

async function extractText(tabIndexOrWsUrl, selector) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const js = `${getElementSelector(selector)}?.textContent`;
  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  throwIfExceptionDetails(result);
  return result.result.value;
}

async function getHtml(tabIndexOrWsUrl, selector = null) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const js = selector
    ? `${getElementSelector(selector)}?.innerHTML`
    : 'document.documentElement.outerHTML';
  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  throwIfExceptionDetails(result);
  return result.result.value;
}

async function getAttribute(tabIndexOrWsUrl, selector, attrName) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const js = `${getElementSelector(selector)}?.getAttribute(${JSON.stringify(attrName)})`;
  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  throwIfExceptionDetails(result);
  return result.result.value;
}

async function waitForElement(tabIndexOrWsUrl, selector, timeout = 5000) {
  const js = `
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('waitForElement timeout: ' + ${JSON.stringify(selector)})), ${timeout});
      const check = () => {
        if (${getElementSelector(selector)}) {
          clearTimeout(t);
          resolve(true);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    })
  `;
  await evaluate(tabIndexOrWsUrl, js);
}

async function waitForText(tabIndexOrWsUrl, text, timeout = 5000) {
  const js = `
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('waitForText timeout: ' + ${JSON.stringify(text)})), ${timeout});
      const check = () => {
        if (document.body.textContent.includes(${JSON.stringify(text)})) {
          clearTimeout(t);
          resolve(true);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    })
  `;
  await evaluate(tabIndexOrWsUrl, js);
}

// GAUNTLET DIVERGENCE (PRI-1517): optional opts.timeoutMs threads to
// Page.captureScreenshot's CDP timeout. Default behavior unchanged for
// callers that pass nothing.
async function screenshot(tabIndexOrWsUrl, filename, selector = null, fullPage = false, opts = {}) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  let clip = undefined;
  if (fullPage) {
    // Full-page capture: get total content dimensions via layout metrics,
    // then capture beyond the visible viewport.
    const metrics = await sendCdpCommand(wsUrl, 'Page.getLayoutMetrics');
    const { width, height } = metrics.contentSize;
    clip = { x: 0, y: 0, width, height, scale: 1 };
  } else if (selector) {
    // Element capture: use element's CSS bounding rect
    const js = `
      (() => {
        const el = ${getElementSelector(selector)};
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          scale: 1
        };
      })()
    `;
    const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression: js,
      returnByValue: true
    });
    throwIfExceptionDetails(result);
    clip = result.result.value;
  } else {
    // Viewport capture: explicitly clip to CSS pixel dimensions.
    // Without an explicit clip, Chrome uses its internal (DPI-scaled) dimensions,
    // which produces oversized screenshots on Linux HiDPI displays.
    const vpResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression: '({ width: window.innerWidth, height: window.innerHeight })',
      returnByValue: true
    });
    throwIfExceptionDetails(vpResult);
    const { width, height } = vpResult.result.value;
    clip = { x: 0, y: 0, width, height, scale: 1 };
  }

  const result = await sendCdpCommand(wsUrl, 'Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: fullPage,
    clip
  }, opts.timeoutMs);

  const fs = require('fs');
  const path = require('path');
  const buffer = Buffer.from(result.data, 'base64');
  fs.writeFileSync(filename, buffer);

  // Auto-downscale if image exceeds safe dimensions for Claude API
  // (Claude's many-image mode limits to 2000px max dimension)
  await downscaleImageIfNeeded(filename, 1800);

  // Return absolute path so caller knows exactly where file is
  return path.resolve(filename);
}

/**
 * Downscale image if any dimension exceeds maxDimension
 * Uses platform-native tools (sips on macOS, ImageMagick on Linux)
 * @param {string} filepath - Path to image file
 * @param {number} maxDimension - Maximum allowed dimension (default 1800)
 */
async function downscaleImageIfNeeded(filepath, maxDimension = 1800) {
  const { execSync } = require('child_process');
  const os = require('os');
  const fs = require('fs');

  // Read image dimensions using platform-native tools
  const platform = os.platform();

  try {
    let width, height;

    if (platform === 'darwin') {
      // macOS: use sips to get dimensions
      const output = execSync(`sips -g pixelWidth -g pixelHeight "${filepath}" 2>/dev/null`, { encoding: 'utf8' });
      const widthMatch = output.match(/pixelWidth:\s*(\d+)/);
      const heightMatch = output.match(/pixelHeight:\s*(\d+)/);
      width = widthMatch ? parseInt(widthMatch[1]) : 0;
      height = heightMatch ? parseInt(heightMatch[1]) : 0;
    } else if (platform === 'linux') {
      // Linux: try ImageMagick identify
      try {
        const output = execSync(`identify -format "%w %h" "${filepath}" 2>/dev/null`, { encoding: 'utf8' });
        [width, height] = output.trim().split(' ').map(Number);
      } catch {
        // ImageMagick not available, skip downscaling
        return;
      }
    } else {
      // Windows or other: skip for now
      return;
    }

    // Check if downscaling is needed
    if (width <= maxDimension && height <= maxDimension) {
      return; // No downscaling needed
    }

    // Downscale to fit within maxDimension box
    if (platform === 'darwin') {
      // macOS: sips -Z scales to fit in a square box
      execSync(`sips -Z ${maxDimension} "${filepath}" 2>/dev/null`);
    } else if (platform === 'linux') {
      // Linux: ImageMagick convert with resize
      execSync(`convert "${filepath}" -resize ${maxDimension}x${maxDimension}\\> "${filepath}" 2>/dev/null`);
    }
  } catch (e) {
    // Silently ignore downscaling failures - better to have large image than no image
    // Could log to stderr for debugging: console.error(`Downscaling failed: ${e.message}`);
  }
}

/**
 * Build the Chrome CLI args for a given port/profile/mode. Pure — no side
 * effects, no reliance on module-level state beyond `process.env`.
 *
 * Reads CHROME_EXTRA_ARGS from the environment: whitespace-separated tokens
 * appended to the base args, e.g. for software WebGL in headless containers:
 *   CHROME_EXTRA_ARGS="--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader"
 */
function buildChromeArgs({ chosenPort, chromeUserDataDir, chromeHeadless }) {
  const args = [
    `--remote-debugging-port=${chosenPort}`,
    `--user-data-dir=${chromeUserDataDir}`,
    // Pin the browser window so headed runs and the initial headless
    // framebuffer land at a desktop-typical size. Per-run viewport
    // overrides via Emulation.setDeviceMetricsOverride still take
    // precedence for what the page itself sees.
    '--window-size=1440,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-features=TranslateUI',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--force-color-profile=srgb',
    '--metrics-recording-only',
    '--no-sandbox',
    '--safebrowsing-disable-auto-update',
    '--disable-blink-features=AutomationControlled'
  ];

  if (chromeHeadless) {
    args.push('--headless=new');
  }

  // CHROME_EXTRA_ARGS: whitespace-separated extra flags to append.
  const extraArgs = process.env.CHROME_EXTRA_ARGS;
  if (extraArgs) {
    const tokens = extraArgs.split(/\s+/).filter(Boolean);
    args.push(...tokens);
  }

  return args;
}

async function startChrome(headless = null, profileName = null, port = null) {
  const { spawn } = require('child_process');
  const { existsSync, mkdirSync } = require('fs');
  const os = require('os');

  // Use provided headless parameter, or fall back to current mode
  if (headless !== null) {
    chromeHeadless = headless;
  }

  // Use provided profile name, or fall back to current profile
  if (profileName !== null) {
    chromeProfileName = profileName;
  }

  // --- Step 1: Check meta.json for an already-running Chrome on this profile ---
  // This enables reconnection after MCP restart while Chrome is still alive.
  if (!port) {
    const meta = readProfileMeta(chromeProfileName);
    if (meta && meta.port) {
      if (await isPortAlive(hostOverride.getHost(), meta.port, meta.pid)) {
        activePort = meta.port;
        if (CHROME_VERBOSE) console.error(`Reconnected to existing Chrome (port: ${meta.port}, PID: ${meta.pid}, profile: ${chromeProfileName})`);
        return;
      }
      // Stale meta.json — Chrome died without cleanup
      clearProfileMeta(chromeProfileName);
    }
  }

  // --- Step 2: Find Chrome binary ---
  const chromePaths = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium'
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ]
  };

  const platform = os.platform();
  const paths = chromePaths[platform] || [];

  let chromePath = null;
  for (const path of paths) {
    if (existsSync(path)) {
      chromePath = path;
      break;
    }
  }

  if (!chromePath) {
    throw new Error(`Chrome not found. Searched: ${paths.join(', ')}`);
  }

  // Set up profile directory (persistent across sessions)
  if (!chromeUserDataDir) {
    chromeUserDataDir = getChromeProfileDir(chromeProfileName);
    mkdirSync(chromeUserDataDir, { recursive: true });
  }

  // Spawn Chrome on the given port, wait for it to come up, and verify
  // /json/version responds. Returns the proc on success, null if the
  // port was already in use (Chrome failed to bind — DevTools port is
  // taken). Throws on any other error.
  const trySpawn = async (listenPort) => {
    const args = buildChromeArgs({
      chosenPort: listenPort,
      chromeUserDataDir,
      chromeHeadless,
    });
    const proc = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore'
    });
    proc.unref();

    // Wait for Chrome to initialize (or fail). The prior fixed 2s sleep
    // is kept so slower startups still succeed; isPortAlive is the real
    // liveness gate.
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (await isPortAlive(hostOverride.getHost(), listenPort, proc.pid)) {
      return proc;
    }
    // Chrome did not come up on the port. Most likely cause: another
    // process is already bound to it (TOCTOU window, or CHROME_WS_PORT
    // was pointed at an occupied port). Kill anything still running and
    // report failure up to the caller.
    try { process.kill(proc.pid, 'SIGTERM'); } catch { /* already gone */ }
    return null;
  };

  // ===== GAUNTLET DIVERGENCE START: port strategy via pickFreePort =====
  // Upstream scans findAvailablePort(PORT_RANGE_START..END). We use
  // pickFreePort() (OS-assigned ephemeral) because fixed-range scanning
  // raced with co-tenants on 9222. When syncing upstream startChrome
  // changes, port this decision block by hand — the Chrome args
  // assembly and trySpawn callback above/below can usually be merged
  // cleanly, but this block must not be overwritten.
  // - Explicit port arg (e.g. from showBrowser()/hideBrowser() which
  //   preserve the in-use port across restarts) → use it as-is.
  // - CHROME_WS_PORT env → attach/launch on that port as configured.
  // - Otherwise: let the OS assign a free ephemeral port via
  //   pickFreePort(). If the TOCTOU window loses, retry once with a
  //   fresh pick before giving up.
  const HAS_ENV_PORT = process.env.CHROME_WS_PORT !== undefined;
  let proc = null;
  let chosenPort;
  if (port) {
    chosenPort = port;
    proc = await trySpawn(chosenPort);
    if (!proc) {
      throw new Error(`Chrome failed to start on port ${chosenPort} (port in use?)`);
    }
  } else if (HAS_ENV_PORT) {
    chosenPort = hostOverride.getPort();
    proc = await trySpawn(chosenPort);
    if (!proc) {
      throw new Error(`Chrome failed to start on CHROME_WS_PORT=${chosenPort} (port in use?)`);
    }
  } else {
    chosenPort = await pickFreePort();
    proc = await trySpawn(chosenPort);
    if (!proc) {
      // TOCTOU — another process grabbed the port between close() and
      // spawn(). Pick a new one and retry once.
      chosenPort = await pickFreePort();
      proc = await trySpawn(chosenPort);
      if (!proc) {
        throw new Error(`Chrome failed to start on dynamically-picked port ${chosenPort} after retry`);
      }
    }
  }
  // ===== GAUNTLET DIVERGENCE END =====

  chromeProcess = proc;
  activePort = chosenPort;

  // --- Step 4: Persist port assignment in meta.json ---
  writeProfileMeta(chromeProfileName, {
    port: chosenPort,
    pid: proc.pid,
    headless: chromeHeadless,
    profileName: chromeProfileName,
    userDataDir: chromeUserDataDir,
    startedAt: new Date().toISOString()
  });

  const mode = chromeHeadless ? 'headless' : 'headed';
  if (CHROME_VERBOSE) console.error(`Chrome started in ${mode} mode (PID: ${proc.pid}, port: ${chosenPort}, profile: ${chromeProfileName})`);
}

async function killChrome() {
  // Determine which PID to kill.
  // - If we launched Chrome ourselves, use chromeProcess.pid.
  // - If we reconnected to a Chrome started by a previous session
  //   (chromeProcess === null but activePort is alive), look up the
  //   PID holding that port via findPidOnPort. Without this fallback,
  //   showBrowser/hideBrowser on a reconnected session left the old
  //   Chrome running and the new launch failed with 'did not become
  //   ready on port X'. Hand-ported from upstream 4eb566d.
  let pidToKill = null;
  if (chromeProcess && chromeProcess.pid) {
    pidToKill = chromeProcess.pid;
  } else if (activePort) {
    pidToKill = findPidOnPort(activePort);
  }

  if (pidToKill === null) {
    // Nothing to kill. Still clear meta.json so other sessions don't
    // think there's a Chrome here, and reset the user-data-dir cache
    // (PRI-1280) so the next startChrome recomputes it.
    clearProfileMeta(chromeProfileName);
    chromeProcess = null;
    activePort = hostOverride.getPort();
    chromeUserDataDir = null;
    return;
  }

  try {
    // Try graceful shutdown first via CDP
    try {
      await chromeHttp('/json/close', 'GET');
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (e) {
      // Ignore errors, Chrome might already be dead
    }

    try {
      process.kill(pidToKill, 'SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (e) {
      // Process might already be dead
    }
  } catch (e) {
    console.error(`Error killing Chrome: ${e.message}`);
  }

  // Clean up meta.json so other sessions know this port is free
  clearProfileMeta(chromeProfileName);
  chromeProcess = null;
  activePort = hostOverride.getPort();
  // Reset so the next startChrome() with a fresh profile name recomputes
  // the user-data-dir. Without this, a long-lived process (e.g. `gauntlet
  // serve`) reuses the first run's profile dir forever and cookies leak
  // across runs. PRI-1280.
  chromeUserDataDir = null;
}

async function showBrowser() {
  if (!chromeHeadless) {
    return 'Browser is already visible';
  }

  console.error('Switching to headed mode (browser window will be visible)...');
  console.error('WARNING: This will restart Chrome and lose any POST-based page state');

  // Get current tabs before killing Chrome
  let currentTabs = [];
  try {
    const tabs = await getTabs();
    currentTabs = tabs.map(t => t.url).filter(url => url && url !== 'about:blank');
  } catch (e) {
    // Ignore errors if Chrome isn't running
  }

  // Save port so we reuse it after restart (avoid port churn)
  const savedPort = activePort;

  // Kill current Chrome instance
  await killChrome();

  // Start Chrome in headed mode on the same port
  await startChrome(false, null, savedPort);

  // Reopen tabs (Note: This will re-request pages via GET, losing POST state)
  if (currentTabs.length > 0) {
    console.error(`Reopening ${currentTabs.length} tab(s)...`);
    for (const url of currentTabs) {
      try {
        await newTab(url);
      } catch (e) {
        console.error(`Failed to reopen ${url}: ${e.message}`);
      }
    }
  }

  return 'Browser window is now visible. Note: Pages were reloaded via GET requests.';
}

async function hideBrowser() {
  if (chromeHeadless) {
    return 'Browser is already in headless mode';
  }

  console.error('Switching to headless mode (hiding browser window)...');
  console.error('WARNING: This will restart Chrome and lose any POST-based page state');

  // Get current tabs before killing Chrome
  let currentTabs = [];
  try {
    const tabs = await getTabs();
    currentTabs = tabs.map(t => t.url).filter(url => url && url !== 'about:blank');
  } catch (e) {
    // Ignore errors if Chrome isn't running
  }

  // Save port so we reuse it after restart
  const savedPort = activePort;

  // Kill current Chrome instance
  await killChrome();

  // Start Chrome in headless mode on the same port
  await startChrome(true, null, savedPort);

  // Reopen tabs (Note: This will re-request pages via GET, losing POST state)
  if (currentTabs.length > 0) {
    console.error(`Reopening ${currentTabs.length} tab(s)...`);
    for (const url of currentTabs) {
      try {
        await newTab(url);
      } catch (e) {
        console.error(`Failed to reopen ${url}: ${e.message}`);
      }
    }
  }

  return 'Browser is now in headless mode. Note: Pages were reloaded via GET requests.';
}

async function getBrowserMode() {
  return {
    headless: chromeHeadless,
    mode: chromeHeadless ? 'headless' : 'headed',
    running: chromeProcess !== null,
    pid: chromeProcess ? chromeProcess.pid : null,
    port: activePort,
    profile: chromeProfileName,
    profileDir: chromeUserDataDir
  };
}

function getChromePid() {
  return chromeProcess ? chromeProcess.pid : null;
}

function getProfileName() {
  return chromeProfileName;
}

function setProfileName(profileName) {
  if (!/^[a-zA-Z0-9_-]+$/.test(profileName)) {
    throw new Error('Invalid profile name. Only alphanumeric characters, hyphens, and underscores are allowed.');
  }
  if (chromeProcess) {
    throw new Error('Cannot change profile while Chrome is running. Kill Chrome first.');
  }
  chromeProfileName = profileName;
  chromeUserDataDir = null; // Reset so next startChrome() uses new profile
  return `Profile set to: ${profileName}`;
}

// Console logging utilities
async function enableConsoleLogging(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  // Initialize console messages array for this tab
  if (!consoleMessages.has(wsUrl)) {
    consoleMessages.set(wsUrl, []);
  }

  // Start persistent WebSocket connection for console logging
  const ws = new WebSocketClient(wsUrl);

  return new Promise((resolve, reject) => {
    let enabledRuntime = false;

    ws.on('message', (msg) => {
      const data = JSON.parse(msg);

      // Handle Runtime.enable response
      if (data.id === 999999 && !enabledRuntime) {
        enabledRuntime = true;
        // Don't close the WebSocket - keep it open for console messages
        resolve();
        return;
      }

      // Capture console messages
      if (data.method === 'Runtime.consoleAPICalled') {
        const entry = data.params;
        const timestamp = new Date().toISOString();
        const level = entry.type || 'log';
        const args = entry.args || [];

        // Extract text from arguments
        const text = args.map(arg => {
          if (arg.type === 'string') return arg.value;
          if (arg.type === 'number') return String(arg.value);
          if (arg.type === 'boolean') return String(arg.value);
          if (arg.type === 'object') return arg.description || '[Object]';
          return String(arg.value || arg.description || arg.type);
        }).join(' ');

        const messages = consoleMessages.get(wsUrl) || [];
        messages.push({
          timestamp,
          level,
          text
        });
        consoleMessages.set(wsUrl, messages);
      }
    });

    ws.on('error', (err) => {
      if (!enabledRuntime) {
        reject(err);
      }
    });

    ws.connect()
      .then(() => {
        // Enable Runtime domain to receive console messages
        ws.send(JSON.stringify({
          id: 999999, // Use fixed ID to identify this response
          method: 'Runtime.enable'
        }));
      })
      .catch(reject);

    // Timeout after 5s
    setTimeout(() => {
      if (!enabledRuntime) {
        ws.close();
        reject(new Error('Console logging enable timeout'));
      }
    }, 5000);
  });
}

async function getConsoleMessages(tabIndexOrWsUrl, sinceTime = null) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const messages = consoleMessages.get(wsUrl) || [];

  if (!sinceTime) {
    return messages;
  }

  // Filter messages since the specified time
  return messages.filter(msg => new Date(msg.timestamp) > sinceTime);
}

async function clearConsoleMessages(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  consoleMessages.set(wsUrl, []);
}

// Session and directory management
function getXdgCacheHome() {
  const os = require('os');
  const path = require('path');

  // Check XDG_CACHE_HOME environment variable first
  if (process.env.XDG_CACHE_HOME) {
    return process.env.XDG_CACHE_HOME;
  }

  // Fall back to platform-specific defaults
  const platform = os.platform();
  const homeDir = os.homedir();

  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Caches');
  } else if (platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  } else {
    // Linux and other Unix-like systems
    return path.join(homeDir, '.cache');
  }
}

function getChromeProfileDir(profileName = 'gauntlet') {
  const path = require('path');
  const cacheHome = getXdgCacheHome();
  return path.join(cacheHome, 'superpowers', 'browser-profiles', profileName);
}

// --- Dynamic port allocation and per-profile meta.json ---
//
// Each profile gets a sibling meta.json file next to its data directory:
//   ~/.cache/superpowers/browser-profiles/gauntlet/       ← profile data
//   ~/.cache/superpowers/browser-profiles/gauntlet.meta.json ← port/pid tracking
//
// This enables:
//   - Reconnection to Chrome instances started by previous sessions
//   - Multiple parallel Chrome instances (different profiles = different ports)
//   - Collision detection (port already in use by another profile or process)

function getProfileMetaPath(profileName = 'gauntlet') {
  const path = require('path');
  const cacheHome = getXdgCacheHome();
  return path.join(cacheHome, 'superpowers', 'browser-profiles', `${profileName}.meta.json`);
}

function readProfileMeta(profileName = 'gauntlet') {
  const fs = require('fs');
  try {
    const data = fs.readFileSync(getProfileMetaPath(profileName), 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function writeProfileMeta(profileName, data) {
  const fs = require('fs');
  const path = require('path');
  const metaPath = getProfileMetaPath(profileName);
  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(data, null, 2) + '\n');
}

function clearProfileMeta(profileName) {
  const fs = require('fs');
  try {
    fs.unlinkSync(getProfileMetaPath(profileName));
  } catch {
    // Already absent — nothing to do
  }
}

// Check if a port has a live Chrome DevTools instance, optionally verify PID
async function isPortAlive(host, port, expectedPid = null) {
  try {
    const data = await chromeHttpAt(host, port, '/json/version');
    // Verify it's actually Chrome (not some other service on this port)
    if (!data || !data.Browser) return false;
    // If we have an expected PID, verify the process still exists
    if (expectedPid) {
      try { process.kill(expectedPid, 0); } // signal 0 = existence check
      catch { return false; }
    }
    return true;
  } catch {
    return false;
  }
}

// Find the PID of the process holding `port`, or null if none.
// Uses platform-native tools — `lsof -ti:PORT -sTCP:LISTEN` on
// macOS/Linux (the LISTEN filter is load-bearing: without it lsof
// returns every process with an open connection to that port,
// including the caller itself), `netstat | findstr` on Windows.
// Returns null on any failure (no listener, missing tool, parse error).
//
// Hand-ported from upstream 8a130e8 + 4eb566d.
function findPidOnPort(port) {
  const { execSync } = require('child_process');
  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const out = execSync(`lsof -ti:${port} -sTCP:LISTEN`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (!out) return null;
      const first = out.split('\n')[0];
      const pid = parseInt(first, 10);
      return Number.isFinite(pid) ? pid : null;
    }
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const lines = out.split(/\r?\n/).filter(l => /LISTENING/i.test(l));
      if (!lines.length) return null;
      const cols = lines[0].trim().split(/\s+/);
      const pid = parseInt(cols[cols.length - 1], 10);
      return Number.isFinite(pid) ? pid : null;
    }
  } catch (_e) {
    return null;
  }
  return null;
}

function getActivePort() {
  return activePort;
}

function initializeSession() {
  if (!sessionDir) {
    const fs = require('fs');
    const path = require('path');

    // Create XDG cache directory structure: ~/.cache/superpowers/browser/YYYY-MM-DD/session-{timestamp}
    const cacheHome = getXdgCacheHome();
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const sessionId = `session-${Date.now()}`;

    sessionDir = path.join(cacheHome, 'superpowers', 'browser', dateStr, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    captureCounter = 0;

    if (CHROME_VERBOSE) console.error(`Browser session directory: ${sessionDir}`);

    // Register cleanup with the module-level handler set. Process handlers
    // are installed at most once for the whole module — see
    // ensureProcessHandlersRegistered() at module scope.
    ensureProcessHandlersRegistered();
    activeCleanups.add(cleanupSession);
  }
  return sessionDir;
}

function cleanupSession() {
  if (sessionDir) {
    try {
      const fs = require('fs');
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.error(`Cleaned up session directory: ${sessionDir}`);
    } catch (error) {
      console.error(`Failed to cleanup session directory: ${error.message}`);
    }
    sessionDir = null;
  }
  activeCleanups.delete(cleanupSession);
}

function createCapturePrefix(actionType = 'navigate') {
  // Ensure session is initialized
  initializeSession();

  // Create time-ordered prefix for flat file structure
  captureCounter++;
  return `${String(captureCounter).padStart(3, '0')}-${actionType}`;
}

async function generateDomSummary(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  // Smart, token-efficient DOM summary
  const js = `
    (() => {
      // Count interactive elements
      const buttons = document.querySelectorAll('button, input[type="button"], input[type="submit"]').length;
      const inputs = document.querySelectorAll('input:not([type="button"]):not([type="submit"]), textarea, select').length;
      const links = document.querySelectorAll('a[href]').length;

      // Get page structure
      const title = document.title.slice(0, 60);
      const allH1s = Array.from(document.querySelectorAll('h1')).map(h => h.textContent.trim().slice(0, 40)).filter(Boolean);
      const h1s = allH1s.slice(0, 3);
      const h1Extra = allH1s.length > 3 ? allH1s.length - 3 : 0;

      // Find main content area
      const main = document.querySelector('main, [role="main"], .main, #main, .content, #content');
      const mainTag = main ? main.tagName.toLowerCase() + (main.id ? '#' + main.id : main.className ? '.' + main.className.split(' ')[0] : '') : 'body';

      // Check for forms
      const forms = document.querySelectorAll('form');
      const formInfo = forms.length > 0 ? \`\${forms.length} form\${forms.length > 1 ? 's' : ''}\` : '';

      // Navigation elements
      const nav = document.querySelector('nav, [role="navigation"], .nav, #nav') ? 'nav' : '';

      return [
        \`\${title}\`,
        \`Interactive: \${buttons} buttons, \${inputs} inputs, \${links} links\`,
        h1s.length > 0 ? \`Headings: \${h1s.map(h => '"' + h + '"').join(', ')}\${h1Extra > 0 ? ', and ' + h1Extra + ' more' : ''}\` : '',
        \`Layout: \${nav ? 'nav + ' : ''}\${mainTag}\${formInfo ? ' + ' + formInfo : ''}\`
      ].filter(Boolean).join('\\n');
    })()
  `;

  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  throwIfExceptionDetails(result);
  return result.result.value;
}

async function getPageSize(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  const js = `({
    width: window.innerWidth,
    height: window.innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight
  })`;

  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  throwIfExceptionDetails(result);
  return result.result.value;
}

async function generateMarkdown(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  // Enhanced markdown extraction with image support
  const js = `
    (() => {
      const results = [];

      // Extract title
      const title = document.title;
      if (title) results.push(\`# \${title}\\n\`);

      // Count images for summary
      const allImages = document.querySelectorAll('img');
      const significantImages = Array.from(allImages).filter(img => {
        const rect = img.getBoundingClientRect();
        return rect.width >= 100 && rect.height >= 100;
      });

      // Add image summary at top if there are significant images
      if (significantImages.length > 0) {
        results.push(\`\\n**📷 This page contains \${significantImages.length} significant image(s). Check screenshot.png for visual content.**\\n\`);
      }

      // Extract main content elements including images
      const elements = document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, a, li, pre, code, blockquote, table, img, figure');

      for (const el of elements) {
        const tag = el.tagName.toLowerCase();
        const text = el.textContent.trim();

        if (tag === 'img') {
          const alt = el.alt || '';
          const src = el.src || '';
          const rect = el.getBoundingClientRect();
          // Only include images that are reasonably sized (not tiny icons)
          if (rect.width >= 50 && rect.height >= 50) {
            const sizeInfo = \`\${Math.round(rect.width)}x\${Math.round(rect.height)}\`;
            const description = alt ? \`"\${alt}"\` : '(no alt text)';
            results.push(\`\\n![Image: \${description} - \${sizeInfo}](\${src})\\n\`);
          }
          continue;
        }

        if (tag === 'figure') {
          const figcaption = el.querySelector('figcaption');
          if (figcaption) {
            results.push(\`\\n*Figure: \${figcaption.textContent.trim()}*\\n\`);
          }
          continue;
        }

        if (!text) continue;

        if (tag.startsWith('h')) {
          const level = parseInt(tag[1]);
          results.push(\`\${'#'.repeat(level)} \${text}\\n\`);
        } else if (tag === 'p') {
          results.push(\`\${text}\\n\`);
        } else if (tag === 'a') {
          const href = el.href;
          results.push(\`[\${text}](\${href})\`);
        } else if (tag === 'li') {
          results.push(\`- \${text}\`);
        } else if (tag === 'pre' || tag === 'code') {
          results.push(\`\\\`\\\`\\\`\\n\${text}\\n\\\`\\\`\\\`\\n\`);
        } else if (tag === 'blockquote') {
          results.push(\`> \${text}\\n\`);
        } else if (tag === 'table') {
          // Simple table extraction
          const rows = el.querySelectorAll('tr');
          if (rows.length > 0) {
            results.push('\\n| Table Content |\\n|---|');
            for (let i = 0; i < Math.min(rows.length, 10); i++) {
              const cells = rows[i].querySelectorAll('td, th');
              const cellTexts = Array.from(cells).map(cell => cell.textContent.trim()).slice(0, 3);
              if (cellTexts.length > 0) {
                results.push(\`| \${cellTexts.join(' | ')} |\`);
              }
            }
            results.push('\\n');
          }
        }
      }

      return results.join('\\n').slice(0, 50000); // Limit size
    })()
  `;

  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  throwIfExceptionDetails(result);
  return result.result.value;
}

async function capturePageArtifacts(tabIndexOrWsUrl, actionType = 'navigate') {
  const prefix = createCapturePrefix(actionType);
  const fs = require('fs');
  const path = require('path');

  // All files go in session root directory
  const dir = initializeSession();

  // Capture all artifacts in parallel
  const [html, markdown, pageSize, domSummary] = await Promise.all([
    getHtml(tabIndexOrWsUrl),
    generateMarkdown(tabIndexOrWsUrl),
    getPageSize(tabIndexOrWsUrl),
    generateDomSummary(tabIndexOrWsUrl)
  ]);

  // Save files with prefix (flat structure - all in session dir)
  const htmlPath = path.join(dir, `${prefix}.html`);
  const markdownPath = path.join(dir, `${prefix}.md`);
  const screenshotPath = path.join(dir, `${prefix}.png`);
  const consoleLogPath = path.join(dir, `${prefix}-console.txt`);

  fs.writeFileSync(htmlPath, html || '');
  fs.writeFileSync(markdownPath, markdown || '');

  // Create console log file (placeholder for now)
  fs.writeFileSync(consoleLogPath, '# Console Log\n# TODO: Console logging not yet implemented\n');

  // Take screenshot
  await screenshot(tabIndexOrWsUrl, screenshotPath);

  return {
    capturePrefix: prefix,
    sessionDir: dir,
    files: {
      html: htmlPath,
      markdown: markdownPath,
      screenshot: screenshotPath,
      consoleLog: consoleLogPath
    },
    pageSize,
    domSummary
  };
}

// =============================================================================
// AUTO-CAPTURE WITH DOM DIFF
// =============================================================================

/**
 * Line-based diff between two HTML strings using Myers' algorithm.
 * Returns a human-readable summary with REMOVED and ADDED sections,
 * capped at MAX_LINES_PER_SIDE per side with "and N more" footer. Used by
 * capturePageArtifacts to attach a diff to the captured page state.
 *
 * Myers (not set-based) so reordered identical lines are correctly
 * detected as a remove + add pair, not "no changes."
 *
 * Pure function. Hand-rolled — no npm dependency.
 */
const MAX_LINES_PER_SIDE = 50;
const MAX_LINE_LENGTH = 200;

// Myers' O((N+M)D) shortest-edit-script. Returns an array of
// { type: 'eq'|'del'|'add', value: string } operations in order.
function myersDiff(a, b) {
  const N = a.length;
  const M = b.length;
  const max = N + M;
  const v = new Array(2 * max + 1);
  const trace = [];

  v[max + 1] = 0;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[max + k - 1] < v[max + k + 1])) {
        x = v[max + k + 1];
      } else {
        x = v[max + k - 1] + 1;
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++; y++;
      }
      v[max + k] = x;
      if (x >= N && y >= M) {
        return myersBacktrack(trace, a, b, N, M, max);
      }
    }
  }
  return [];
}

function myersBacktrack(trace, a, b, N, M, max) {
  const ops = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && v[max + k - 1] < v[max + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v[max + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'eq', value: a[x - 1] });
      x--; y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ type: 'add', value: b[y - 1] });
        y--;
      } else {
        ops.push({ type: 'del', value: a[x - 1] });
        x--;
      }
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ type: 'eq', value: a[x - 1] });
    x--; y--;
  }
  return ops.reverse();
}

function generateHtmlDiff(beforeHtml, afterHtml) {
  const beforeLines = (beforeHtml || '').split('\n');
  const afterLines = (afterHtml || '').split('\n');

  const ops = myersDiff(beforeLines, afterLines);

  const removed = ops.filter(o => o.type === 'del' && o.value.trim()).map(o => o.value);
  const added = ops.filter(o => o.type === 'add' && o.value.trim()).map(o => o.value);

  let diff = '';
  if (removed.length > 0) {
    diff += '=== REMOVED ===\n';
    diff += removed.slice(0, MAX_LINES_PER_SIDE)
      .map(l => '- ' + l.slice(0, MAX_LINE_LENGTH))
      .join('\n');
    if (removed.length > MAX_LINES_PER_SIDE) {
      diff += `\n... and ${removed.length - MAX_LINES_PER_SIDE} more removed lines`;
    }
    diff += '\n\n';
  }
  if (added.length > 0) {
    diff += '=== ADDED ===\n';
    diff += added.slice(0, MAX_LINES_PER_SIDE)
      .map(l => '+ ' + l.slice(0, MAX_LINE_LENGTH))
      .join('\n');
    if (added.length > MAX_LINES_PER_SIDE) {
      diff += `\n... and ${added.length - MAX_LINES_PER_SIDE} more added lines`;
    }
  }

  if (!diff) {
    diff = '(no changes detected)';
  }

  return diff;
}

/**
 * Capture page state before and after an action, with diff
 * @param {number|string} tabIndexOrWsUrl - Tab index or WebSocket URL
 * @param {string} actionType - Type of action (click, type, etc.)
 * @param {Function} actionFn - Async function that performs the action
 * @param {number} settleTime - Time to wait for page to settle (ms)
 */
async function captureActionWithDiff(tabIndexOrWsUrl, actionType, actionFn, settleTime = 3000) {
  const fs = require('fs');
  const path = require('path');

  const prefix = createCapturePrefix(actionType);
  const dir = initializeSession();
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  // Helper to save/restore focus around operations that might lose it (like screenshots)
  async function saveFocus() {
    const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression: `
        (() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          // Build a unique selector for the focused element
          if (el.id) return { type: 'id', value: el.id };
          if (el.name) return { type: 'name', value: el.name, tag: el.tagName.toLowerCase() };
          // Fallback: use path from body
          const path = [];
          let current = el;
          while (current && current !== document.body) {
            const parent = current.parentElement;
            if (!parent) break;
            const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
            const index = siblings.indexOf(current);
            path.unshift({ tag: current.tagName.toLowerCase(), index });
            current = parent;
          }
          return { type: 'path', value: path };
        })()
      `,
      returnByValue: true
    });
    throwIfExceptionDetails(result);
    return result.result?.value;
  }

  async function restoreFocus(focusInfo) {
    if (!focusInfo) return;
    let selector;
    if (focusInfo.type === 'id') {
      selector = `document.getElementById(${JSON.stringify(focusInfo.value)})`;
    } else if (focusInfo.type === 'name') {
      selector = `document.querySelector(${JSON.stringify(focusInfo.tag + '[name="' + focusInfo.value + '"]')})`;
    } else if (focusInfo.type === 'path') {
      selector = `(() => {
        let el = document.body;
        const path = ${JSON.stringify(focusInfo.value)};
        for (const step of path) {
          const children = Array.from(el.children).filter(c => c.tagName.toLowerCase() === step.tag);
          el = children[step.index];
          if (!el) return null;
        }
        return el;
      })()`;
    }
    if (selector) {
      const restoreResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
        expression: `(() => { const el = ${selector}; if (el) el.focus(); })()`
      });
      throwIfExceptionDetails(restoreResult);
    }
  }

  // Capture BEFORE state (save/restore focus around screenshot)
  const beforeHtml = await getHtml(tabIndexOrWsUrl);
  const focusInfo = await saveFocus();
  const beforeScreenshotPath = path.join(dir, `${prefix}-before.png`);
  await screenshot(tabIndexOrWsUrl, beforeScreenshotPath);
  await restoreFocus(focusInfo);

  // Execute the action
  const actionResult = await actionFn();

  // Wait for page to settle (React re-renders, animations, etc.)
  await new Promise(resolve => setTimeout(resolve, settleTime));

  // Capture AFTER state
  const [afterHtml, markdown, pageSize, domSummary] = await Promise.all([
    getHtml(tabIndexOrWsUrl),
    generateMarkdown(tabIndexOrWsUrl),
    getPageSize(tabIndexOrWsUrl),
    generateDomSummary(tabIndexOrWsUrl)
  ]);

  // Generate diff
  const diff = generateHtmlDiff(beforeHtml, afterHtml);

  // Save files
  const beforeHtmlPath = path.join(dir, `${prefix}-before.html`);
  const afterHtmlPath = path.join(dir, `${prefix}-after.html`);
  const diffPath = path.join(dir, `${prefix}-diff.txt`);
  const markdownPath = path.join(dir, `${prefix}.md`);
  const afterScreenshotPath = path.join(dir, `${prefix}-after.png`);

  fs.writeFileSync(beforeHtmlPath, beforeHtml || '');
  fs.writeFileSync(afterHtmlPath, afterHtml || '');
  fs.writeFileSync(diffPath, diff);
  fs.writeFileSync(markdownPath, markdown || '');
  await screenshot(tabIndexOrWsUrl, afterScreenshotPath);

  return {
    actionResult,
    capture: {
      prefix,
      sessionDir: dir,
      files: {
        beforeHtml: beforeHtmlPath,
        afterHtml: afterHtmlPath,
        diff: diffPath,
        markdown: markdownPath,
        beforeScreenshot: beforeScreenshotPath,
        afterScreenshot: afterScreenshotPath
      },
      pageSize,
      domSummary,
      diffSummary: diff.split('\n').slice(0, 5).join('\n') + (diff.split('\n').length > 5 ? '\n...' : '')
    }
  };
}

// Enhanced DOM actions with auto-capture
async function clickWithCapture(tabIndexOrWsUrl, selector) {
  await click(tabIndexOrWsUrl, selector);
  const artifacts = await capturePageArtifacts(tabIndexOrWsUrl, 'click');
  return {
    action: 'click',
    selector,
    pageSize: artifacts.pageSize,
    capturePrefix: artifacts.capturePrefix,
    sessionDir: artifacts.sessionDir,
    files: artifacts.files,
    domSummary: artifacts.domSummary,
    consoleLog: [] // Placeholder
  };
}

async function fillWithCapture(tabIndexOrWsUrl, selector, value) {
  await fill(tabIndexOrWsUrl, selector, value);
  const artifacts = await capturePageArtifacts(tabIndexOrWsUrl, 'type');
  return {
    action: 'type',
    selector,
    value,
    pageSize: artifacts.pageSize,
    capturePrefix: artifacts.capturePrefix,
    sessionDir: artifacts.sessionDir,
    files: artifacts.files,
    domSummary: artifacts.domSummary,
    consoleLog: [] // Placeholder
  };
}

async function selectOptionWithCapture(tabIndexOrWsUrl, selector, value) {
  await selectOption(tabIndexOrWsUrl, selector, value);
  const artifacts = await capturePageArtifacts(tabIndexOrWsUrl, 'select');
  return {
    action: 'select',
    selector,
    value,
    pageSize: artifacts.pageSize,
    capturePrefix: artifacts.capturePrefix,
    sessionDir: artifacts.sessionDir,
    files: artifacts.files,
    domSummary: artifacts.domSummary,
    consoleLog: [] // Placeholder
  };
}

async function evaluateWithCapture(tabIndexOrWsUrl, expression) {
  const result = await evaluate(tabIndexOrWsUrl, expression);
  const artifacts = await capturePageArtifacts(tabIndexOrWsUrl, 'eval');
  return {
    action: 'eval',
    expression,
    result,
    pageSize: artifacts.pageSize,
    capturePrefix: artifacts.capturePrefix,
    sessionDir: artifacts.sessionDir,
    files: artifacts.files,
    domSummary: artifacts.domSummary,
    consoleLog: [] // Placeholder
  };
}

// =============================================================================
// VIEWPORT/DEVICE EMULATION
// =============================================================================

/**
 * Set device viewport/emulation parameters (CDP: Emulation.setDeviceMetricsOverride)
 *
 * @param {number|string} tabIndexOrWsUrl - Tab index (0, 1, etc.) or WebSocket URL
 * @param {Object} params - Viewport parameters
 * @param {number} [params.width] - Viewport width in CSS pixels (default: 1200)
 * @param {number} [params.height] - Viewport height in CSS pixels (default: 800)
 * @param {number} [params.deviceScaleFactor=1] - DPI multiplier (1=96dpi, 2=192dpi for retina)
 * @param {boolean} [params.mobile=false] - Enable mobile emulation (touch + mobile UA string)
 * @returns {Promise<Object>} - Confirmed viewport parameters
 */
async function setViewport(tabIndexOrWsUrl, params) {
  if (!params || typeof params !== 'object') {
    throw new Error('setViewport requires a params object');
  }

  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  const viewportParams = {
    width: params.width ?? 1200,
    height: params.height ?? 800,
    deviceScaleFactor: params.deviceScaleFactor !== undefined ? params.deviceScaleFactor : 1,
    mobile: params.mobile === true
  };

  if (viewportParams.width < 320 || viewportParams.width > 7680) {
    throw new Error(`Invalid viewport width ${viewportParams.width} (must be 320-7680)`);
  }
  if (viewportParams.height < 200 || viewportParams.height > 4320) {
    throw new Error(`Invalid viewport height ${viewportParams.height} (must be 200-4320)`);
  }
  if (viewportParams.deviceScaleFactor < 0.25 || viewportParams.deviceScaleFactor > 5) {
    throw new Error(`Invalid deviceScaleFactor ${viewportParams.deviceScaleFactor} (must be 0.25-5)`);
  }

  await sendCdpCommand(wsUrl, 'Emulation.setDeviceMetricsOverride', viewportParams);

  // Mobile emulation: touch + UA string
  if (viewportParams.mobile) {
    await sendCdpCommand(wsUrl, 'Emulation.setTouchEmulationEnabled', { enabled: true });
    await sendCdpCommand(wsUrl, 'Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    });
  } else {
    // Explicitly disable mobile emulation when switching to desktop
    await sendCdpCommand(wsUrl, 'Emulation.setTouchEmulationEnabled', { enabled: false });
    // Reset UA to browser default (empty string = use default)
    await sendCdpCommand(wsUrl, 'Emulation.setUserAgentOverride', { userAgent: '' });
  }

  return { ...viewportParams, touch: viewportParams.mobile };
}

/**
 * Clear viewport emulation (reset to browser default)
 * Clears device metrics, touch emulation, and UA override
 * @param {number|string} tabIndexOrWsUrl - Tab index (0, 1, etc.) or WebSocket URL
 * @returns {Promise<void>}
 */
async function clearViewport(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  await sendCdpCommand(wsUrl, 'Emulation.clearDeviceMetricsOverride', {});
  await sendCdpCommand(wsUrl, 'Emulation.setTouchEmulationEnabled', { enabled: false });
  // Empty string resets UA to browser default (CDP convention)
  await sendCdpCommand(wsUrl, 'Emulation.setUserAgentOverride', { userAgent: '' });
}

/**
 * Get current viewport dimensions from browser
 * @param {number|string} tabIndexOrWsUrl - Tab index (0, 1, etc.) or WebSocket URL
 * @returns {Promise<Object>} - Object with innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio, orientation
 */
async function getViewport(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: `({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      devicePixelRatio: window.devicePixelRatio,
      orientation: screen.orientation ? screen.orientation.type : 'unknown'
    })`,
    returnByValue: true
  });
  throwIfExceptionDetails(result);
  return result.result?.value || {};
}

/**
 * Clear all browser cookies
 * @param {number|string} tabIndexOrWsUrl - Tab index (0, 1, etc.) or WebSocket URL
 * @returns {Promise<void>}
 */
async function clearCookies(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  await sendCdpCommand(wsUrl, 'Network.clearBrowserCookies', {});
}

/**
 * Install cookies into the browser, one CDP call per entry. Returns a
 * per-cookie result array so the caller (the install_cookies tool) can
 * report partial success to the agent — Chrome silently rejects cookies
 * for reasons it does not surface (third-party blocking, schemeful same-
 * site mismatches, sourcePort/sourceScheme cross-checks), and the agent
 * needs to learn which entries got in.
 *
 * Why singular `Network.setCookie` (not `setCookies`): the singular form
 * returns `{ success: boolean }` per call. The plural form swallows the
 * per-cookie status and returns nothing useful for partial-failure
 * diagnostics. The spec (§3.4) calls this out explicitly.
 *
 * Aggregation rules:
 *  - sendCdpCommand throws → success: false, errorReason = thrown message.
 *    This covers transport/protocol-level failures (WS dead, malformed
 *    params, missing required field).
 *  - response.success === false → success: false, errorReason =
 *    "chrome rejected cookie (no detail provided)". CDP does not expose
 *    a reason field on Network.setCookie; the cookie is silently dropped.
 *  - response.success === true → success: true.
 *
 * Never throws on partial failure; returns the array unconditionally.
 *
 * @param {number|string} tabIndexOrWsUrl - Tab index or WebSocket URL.
 * @param {Array<Object>} cookies - CDP CookieParam objects.
 * @returns {Promise<Array<{name: string, success: boolean, errorReason?: string}>>}
 */
async function setCookies(tabIndexOrWsUrl, cookies) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const results = [];
  for (const cookie of cookies) {
    try {
      const response = await sendCdpCommand(wsUrl, 'Network.setCookie', cookie);
      if (response && response.success === true) {
        results.push({ name: cookie.name, success: true });
      } else {
        results.push({
          name: cookie.name,
          success: false,
          errorReason: 'chrome rejected cookie (no detail provided)',
        });
      }
    } catch (err) {
      results.push({
        name: cookie.name,
        success: false,
        errorReason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

// ===== GAUNTLET DIVERGENCE START: Gauntlet-only additions =====
// Everything below this line up to the matching DIVERGENCE END marker
// is Gauntlet-specific and does not exist upstream. New upstream
// functions must NOT land inside this block — put them above it, in
// roughly the same position as their upstream counterpart, so the
// top-to-bottom layout of this file stays comparable to upstream's
// skills/browsing/chrome-ws-lib.js.
//
// Contents:
//   - clearBrowserData(tab): best-effort CDP-level state reset for the
//     remote-Chrome case (spec §5.1).
//   - webAuthnOpenSession(tab): pinned CDP session for the passkey tool
//     (WebAuthn domain is per-socket — see comment on the function).
//   - openObserverSession(tab, onEvent): streams console, exception,
//     log, and network-ws events to EvidenceLogger.
//   - onCdpEvent / offCdpEvent: raw CDP event subscription used by
//     screencast streaming.

/**
 * Best-effort reset of the given tab's browser state for the
 * remote-Chrome case where we cannot delete the `--user-data-dir`
 * ourselves. Cookies, cache, and the current origin's storage are
 * cleared. Silently swallows errors — a thrown error from any sub-step
 * is not fatal; this is a weaker reset than the local-Chrome profile-dir
 * deletion and is documented as such (spec §5.1). The local-Chrome case
 * uses profile-dir deletion instead, which is strictly stronger.
 *
 * Parameter is named `tab` (not `tabIndex`) to match its neighbors
 * (`navigate(tab, url)`, `webAuthnOpenSession(tab)`, `screenshot(tab, ...)`).
 */
async function clearBrowserData(tab) {
  try {
    const wsUrl = await resolveWsUrl(tab);
    try { await sendCdpCommand(wsUrl, 'Network.clearBrowserCookies', {}); } catch { /* best-effort */ }
    try { await sendCdpCommand(wsUrl, 'Network.clearBrowserCache', {}); } catch { /* best-effort */ }
    // Storage.clearDataForOrigin needs an origin — use the current page's
    // origin if it has one, else no-op.
    try {
      const origin = await evaluate(wsUrl, 'location.origin');
      if (origin && typeof origin === 'string' && origin !== 'null') {
        await sendCdpCommand(wsUrl, 'Storage.clearDataForOrigin', {
          origin,
          storageTypes: 'all',
        });
      }
    } catch { /* best-effort */ }
  } catch { /* best-effort */ }
}

// =============================================================================
// WebAuthn — virtual authenticator support (for installing test passkeys)
// =============================================================================
// CDP's WebAuthn domain is scoped to the specific DevTools session (WebSocket
// connection) it was enabled on. `WebAuthn.enable` must precede every other
// WebAuthn call, and all calls in a sequence must ride on the same socket —
// if we let the pool reconnect between calls, the new socket sees "not
// enabled" and any virtual authenticator from the old socket is gone.
//
// We bypass the pool entirely for WebAuthn by opening a dedicated WebSocket
// via `webAuthnOpenSession`. The returned session object stays pinned for
// its lifetime. When closed, Chrome automatically disposes any virtual
// authenticators that were created on it — no explicit teardown required.

async function webAuthnOpenSession(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const ws = new WebSocketClient(wsUrl);
  const pendingRequests = new Map();
  let messageIdCounter = 1;
  let closed = false;

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.id !== undefined) {
        const pending = pendingRequests.get(data.id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingRequests.delete(data.id);
          if (data.error) {
            pending.reject(new Error(data.error.message || JSON.stringify(data.error)));
          } else {
            pending.resolve(data.result);
          }
        }
      }
    } catch (e) {
      console.error('Error processing WebAuthn session message:', e);
    }
  });

  ws.on('close', () => {
    closed = true;
    for (const [, pending] of pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('WebAuthn session closed'));
    }
    pendingRequests.clear();
  });

  await ws.connect();

  const sendOnThisSocket = (method, params = {}, timeout = 30000) => {
    if (closed) return Promise.reject(new Error('WebAuthn session closed'));
    const id = messageIdCounter++;
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeout);
      pendingRequests.set(id, { resolve, reject, timeout: timeoutHandle });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  // Enable once at session creation. Everything downstream rides this socket.
  await sendOnThisSocket('WebAuthn.enable', { enableUI: false });

  return {
    async addVirtualAuthenticator(options) {
      const result = await sendOnThisSocket('WebAuthn.addVirtualAuthenticator', { options });
      return result.authenticatorId;
    },
    async addCredential(authenticatorId, credential) {
      return await sendOnThisSocket('WebAuthn.addCredential', { authenticatorId, credential });
    },
    async removeVirtualAuthenticator(authenticatorId) {
      return await sendOnThisSocket('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    },
    close() {
      if (closed) return;
      closed = true;
      ws.close();
    },
    isClosed() {
      return closed;
    },
  };
}

// =============================================================================
// Observer session — stream browser events to a handler for evidence logging
// =============================================================================
// Opens a dedicated WebSocket outside the pool and enables the Runtime, Log,
// and Network domains. The caller supplies an `onEvent(category, payload)`
// handler that fires for each relevant event. Returns `{ close() }` to tear
// down the session cleanly.
//
// Categories:
//   - 'console'     — Runtime.consoleAPICalled (console.log/warn/error/etc.)
//   - 'exception'   — Runtime.exceptionThrown (uncaught errors)
//   - 'log'         — Log.entryAdded (browser-level warnings: CORS, CSP, etc.)
//   - 'network-ws'  — Network.webSocket* lifecycle + frame events
//
// We deliberately do NOT subscribe to Network.requestWillBeSent or similar
// HTTP events — they're firehose-level noisy. WebSocket events only.

async function openObserverSession(tabIndexOrWsUrl, onEvent) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const ws = new WebSocketClient(wsUrl);
  const pendingRequests = new Map();
  let messageIdCounter = 1;
  let closed = false;

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);

      // Command responses
      if (data.id !== undefined) {
        const pending = pendingRequests.get(data.id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingRequests.delete(data.id);
          if (data.error) {
            pending.reject(new Error(data.error.message || JSON.stringify(data.error)));
          } else {
            pending.resolve(data.result);
          }
        }
        return;
      }

      // Events
      if (!data.method) return;
      const method = data.method;
      const params = data.params || {};

      if (method === 'Runtime.consoleAPICalled') {
        const text = (params.args || []).map((arg) => {
          if (arg.type === 'string') return arg.value;
          if (arg.type === 'number') return String(arg.value);
          if (arg.type === 'boolean') return String(arg.value);
          return arg.description || arg.value || arg.type || '';
        }).join(' ');
        onEvent('console', {
          level: params.type || 'log',
          text,
          stackTrace: params.stackTrace || null,
        });
      } else if (method === 'Runtime.exceptionThrown') {
        const details = params.exceptionDetails || {};
        onEvent('exception', {
          text: details.text || '',
          exception: details.exception ? (details.exception.description || details.exception.value || '') : '',
          url: details.url || null,
          line: details.lineNumber,
          column: details.columnNumber,
          stackTrace: details.stackTrace || null,
        });
      } else if (method === 'Log.entryAdded') {
        const entry = params.entry || {};
        onEvent('log', {
          level: entry.level,
          source: entry.source,
          text: entry.text,
          url: entry.url || null,
          line: entry.lineNumber,
        });
      } else if (method.startsWith('Network.webSocket')) {
        onEvent('network-ws', {
          event: method.slice('Network.'.length),
          ...params,
        });
      }
    } catch (e) {
      console.error('Error processing observer event:', e);
    }
  });

  ws.on('close', () => {
    closed = true;
    for (const [, pending] of pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Observer session closed'));
    }
    pendingRequests.clear();
  });

  await ws.connect();

  const sendOnThisSocket = (method, params = {}, timeout = 10000) => {
    if (closed) return Promise.reject(new Error('Observer session closed'));
    const id = messageIdCounter++;
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeout);
      pendingRequests.set(id, { resolve, reject, timeout: timeoutHandle });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  // Enable all three domains. Order matters only to the extent that events
  // fired before `enable` succeeds aren't delivered — we await each in turn.
  try {
    await sendOnThisSocket('Runtime.enable');
    await sendOnThisSocket('Log.enable');
    await sendOnThisSocket('Network.enable');
  } catch (err) {
    ws.close();
    throw err;
  }

  return {
    close() {
      if (closed) return;
      closed = true;
      ws.close();
    },
    isClosed() {
      return closed;
    },
  };
}

// Subscribe to CDP events on a tab's connection
async function onCdpEvent(tabIndex, handler) {
  const tabs = await getTabs();
  if (!tabs[tabIndex]) throw new Error(`Tab ${tabIndex} not found`);
  const wsUrl = tabs[tabIndex].webSocketDebuggerUrl;
  const conn = await getPooledConnection(wsUrl);
  conn.eventHandler = handler;
}

// Unsubscribe from CDP events
async function offCdpEvent(tabIndex) {
  const tabs = await getTabs();
  if (!tabs[tabIndex]) return;
  const wsUrl = tabs[tabIndex].webSocketDebuggerUrl;
  const conn = connectionPool.get(wsUrl);
  if (conn) conn.eventHandler = null;
}
// ===== GAUNTLET DIVERGENCE END =====

return {
  // Core browser actions (click/fill now use CDP events by default for React compatibility)
  getTabs,
  newTab,
  closeTab,
  navigate,
  click,           // Uses CDP mouse events, falls back to el.click()
  fill,            // Uses CDP insertText, falls back to el.value=
  selectOption,    // Warns if selector matches multiple elements
  evaluate,
  extractText,
  getHtml,
  getAttribute,
  waitForElement,
  waitForText,
  screenshot,

  // Mouse actions (CDP-level, bypasses synthetic event restrictions)
  hover,            // Move mouse over element (CSS :hover, tooltips)
  drag,             // Drag-and-drop via native mouse event sequence
  mouseMove,        // Raw coordinate mouse movement
  scroll,           // Mouse wheel scrolling
  doubleClick,      // Double-click with dblclick event
  rightClick,       // Right-click with contextmenu event

  // Human-like typing (individual keyDown/keyUp with realistic timing)
  humanType,

  // File upload (DOM.setFileInputFiles — can't be done via JS)
  fileUpload,

  // Keyboard support for special keys (Tab, Enter, Escape, Arrow keys, etc.)
  keyboardPress,
  KEY_DEFINITIONS,

  // Chrome lifecycle
  startChrome,
  buildChromeArgs,
  killChrome,
  showBrowser,
  hideBrowser,
  getBrowserMode,
  getChromePid,

  // Profile management
  getChromeProfileDir,
  getProfileName,
  setProfileName,

  // Console logging
  enableConsoleLogging,
  getConsoleMessages,
  clearConsoleMessages,

  // Session management
  getXdgCacheHome,
  initializeSession,
  cleanupSession,
  createCapturePrefix,

  // Auto-capture utilities
  generateDomSummary,
  getPageSize,
  generateMarkdown,
  capturePageArtifacts,
  clickWithCapture,
  fillWithCapture,
  selectOptionWithCapture,
  evaluateWithCapture,

  // DOM diff capture (before/after with diff)
  generateHtmlDiff,
  captureActionWithDiff,

  // Connection management (JRV-130)
  closePooledConnection,
  closeAllConnections,

  // Dynamic port allocation and per-profile meta.json
  getActivePort,
  getProfileMetaPath,
  readProfileMeta,
  writeProfileMeta,
  clearProfileMeta,

  // Viewport/device emulation
  setViewport,
  clearViewport,
  getViewport,

  // Cookie management
  clearCookies,
  setCookies,
  clearBrowserData,

  // WebAuthn virtual authenticator (pinned session — see comment on
  // webAuthnOpenSession for why we bypass the pool).
  webAuthnOpenSession,

  // Observer session — streams console/exception/log/network-ws events
  // to a caller-supplied handler for evidence logging.
  openObserverSession,

  // CDP raw access (for screencast streaming)
  sendCdpCommand,
  onCdpEvent,
  offCdpEvent,

  // Legacy aliases (for backwards compatibility)
  cdpClick: click,
  insertText: fill,
};
}
// ===== GAUNTLET DIVERGENCE END (createSession factory) =====

module.exports = { createSession };
