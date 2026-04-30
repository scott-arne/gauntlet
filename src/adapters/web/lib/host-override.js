// Forked from https://github.com/obra/superpowers-chrome
// Original author: Jesse Vincent
//
// GAUNTLET DIVERGENCE: upstream exports module-load constants
// (CHROME_DEBUG_HOST, CHROME_DEBUG_PORT, CHROME_DEBUG_BASE, WS_OVERRIDE_ENABLED).
// We also export mutable getters + setDefaults() so WebAdapter can point the
// library at a remote Chrome at runtime without mutating process.env.
// The upstream constant names are re-exported below as snapshots taken at
// module load — that keeps unmodified upstream code that destructures them
// working, so future syncs don't have to rewrite every `require('./host-override')`.

const DEFAULT_PORT = 9222;
const DEFAULT_HOST = '127.0.0.1';

let debugHost = process.env.CHROME_WS_HOST || DEFAULT_HOST;
let debugPort = (() => {
  const parsed = parseInt(process.env.CHROME_WS_PORT || `${DEFAULT_PORT}`, 10);
  return Number.isNaN(parsed) ? DEFAULT_PORT : parsed;
})();
let overrideEnabled =
  process.env.CHROME_WS_HOST !== undefined || process.env.CHROME_WS_PORT !== undefined;

function setDefaults(host, port) {
  debugHost = host;
  debugPort = port;
  overrideEnabled = true;
}

function getHost() {
  return debugHost;
}

function getPort() {
  return debugPort;
}

function getBase() {
  return `http://${debugHost}:${debugPort}`;
}

function isOverrideEnabled() {
  return overrideEnabled;
}

function rewriteWsUrl(originalUrl, host, port) {
  if (!originalUrl || typeof originalUrl !== 'string') {
    return originalUrl;
  }
  if (!overrideEnabled) {
    return originalUrl;
  }
  const useHost = host !== undefined ? host : debugHost;
  const usePort = port !== undefined ? port : debugPort;
  try {
    const url = new URL(originalUrl);
    url.hostname = useHost;
    url.port = `${usePort}`;
    return url.toString();
  } catch {
    return originalUrl;
  }
}

// ===== GAUNTLET DIVERGENCE START: createOverride() factory =====
// PRI-1436: WebAdapter instances each call createOverride() to get a private
// state-bag (host/port/overrideEnabled). Without this, two concurrent web
// runs in `gauntlet serve` shared the module-level `debugHost`/`debugPort`
// and stomped each other's endpoint. The legacy mutable getters above and
// the load-time snapshot constants below are kept for upstream-compat:
// unmodified upstream code that destructures `CHROME_DEBUG_HOST` etc. or
// calls the top-level `getHost()` keeps working. New Gauntlet callers
// should use `createOverride({ host, port })` and operate on the returned
// instance.
//
// Defaults: if neither `host` nor `port` is supplied, the instance seeds
// from process.env.CHROME_WS_HOST / CHROME_WS_PORT (matching the legacy
// module-level seed). If either is supplied, both are taken from the
// arguments and `overrideEnabled` is set to true (matching `setDefaults`
// semantics). The returned API mirrors the module-level shape:
// `{ getHost, getPort, getBase, isOverrideEnabled, rewriteWsUrl, setDefaults }`.
function createOverride({ host, port } = {}) {
  let instanceHost;
  let instancePort;
  let instanceOverrideEnabled;

  if (host !== undefined || port !== undefined) {
    instanceHost = host !== undefined ? host : DEFAULT_HOST;
    instancePort = port !== undefined ? port : DEFAULT_PORT;
    instanceOverrideEnabled = true;
  } else {
    instanceHost = process.env.CHROME_WS_HOST || DEFAULT_HOST;
    const parsed = parseInt(process.env.CHROME_WS_PORT || `${DEFAULT_PORT}`, 10);
    instancePort = Number.isNaN(parsed) ? DEFAULT_PORT : parsed;
    instanceOverrideEnabled =
      process.env.CHROME_WS_HOST !== undefined || process.env.CHROME_WS_PORT !== undefined;
  }

  function setDefaults(nextHost, nextPort) {
    instanceHost = nextHost;
    instancePort = nextPort;
    instanceOverrideEnabled = true;
  }

  function getHost() {
    return instanceHost;
  }

  function getPort() {
    return instancePort;
  }

  function getBase() {
    return `http://${instanceHost}:${instancePort}`;
  }

  function isOverrideEnabled() {
    return instanceOverrideEnabled;
  }

  function rewriteWsUrl(originalUrl, overrideHost, overridePort) {
    if (!originalUrl || typeof originalUrl !== 'string') {
      return originalUrl;
    }
    if (!instanceOverrideEnabled) {
      return originalUrl;
    }
    const useHost = overrideHost !== undefined ? overrideHost : instanceHost;
    const usePort = overridePort !== undefined ? overridePort : instancePort;
    try {
      const url = new URL(originalUrl);
      url.hostname = useHost;
      url.port = `${usePort}`;
      return url.toString();
    } catch {
      return originalUrl;
    }
  }

  return {
    setDefaults,
    getHost,
    getPort,
    getBase,
    isOverrideEnabled,
    rewriteWsUrl,
  };
}
// ===== GAUNTLET DIVERGENCE END =====

module.exports = {
  // Gauntlet API — runtime-mutable endpoint (legacy module-level singleton).
  setDefaults,
  getHost,
  getPort,
  getBase,
  isOverrideEnabled,
  rewriteWsUrl,

  // PRI-1436: per-instance factory. New Gauntlet callers should prefer this
  // over the module-level getters above so concurrent web runs don't share
  // host/port state.
  createOverride,

  // Upstream-compat snapshots (taken at module load). Present so that
  // unmodified upstream code like
  //   const { CHROME_DEBUG_HOST, CHROME_DEBUG_PORT } = require('./host-override');
  // keeps working during syncs. These do NOT track setDefaults() — callers
  // that need runtime-mutable values must use getHost()/getPort().
  CHROME_DEBUG_HOST: debugHost,
  CHROME_DEBUG_PORT: debugPort,
  CHROME_DEBUG_BASE: `http://${debugHost}:${debugPort}`,
  WS_OVERRIDE_ENABLED: overrideEnabled,
};
