/**
 * dsh-status-balance — Host half.
 *
 * Owns the DeepSeek account-balance lookup: resolves the API key through
 * `ctx.credentials`, calls the upstream balance endpoint, and serves a
 * display-safe JSON snapshot (balance + list-price table) on a same-origin
 * web route. The browser half renders the wallet balance and estimates this
 * session's spend beside the composer.
 *
 * The API key never leaves this process: the route returns only balance
 * display fields and list prices, and nothing here logs or echoes the secret.
 */

/** Plugin name used by the Loader row (`name: dsh-status-balance`). */
export const name = 'dsh-status-balance';

/** Required services; Cordis keeps `apply` pending until both are available. */
export const inject = ['webServer', 'credentials'];

/** Overridable through the patch row's `config`. */
const DEFAULTS = {
  routePath: '/plugin/dsh-status-balance',
  apiKeyRef: 'DEEPSEEK_API_KEY',
  balanceUrl: 'https://api.deepseek.com/user/balance',
  cacheTtlMs: 30000,
  failureBackoffMs: 15000,
  staleMaxMs: 300000,
  timeoutMs: 8000,
  minRefreshMs: 10000,
};

/**
 * List prices per 1M tokens in CNY (the Reasonix provider defaults). DeepSeek
 * does not return a per-request cost, so the client estimates session spend
 * from these numbers; the whole table is overridable through `config.prices`.
 */
const DEFAULT_PRICES = {
  currency: 'CNY',
  symbol: '¥',
  perMillion: true,
  cacheWriteUsesInput: true,
  models: {
    'deepseek-flash': { input: 1, cacheHit: 0.02, output: 2 },
    'deepseek-v4-flash': { input: 1, cacheHit: 0.02, output: 2 },
    'deepseek-v4-flash-1017': { input: 1, cacheHit: 0.02, output: 2 },
    'deepseek-v4-pro': { input: 3, cacheHit: 0.025, output: 6 },
    'deepseek-v4-pro-0813': { input: 3, cacheHit: 0.025, output: 6 },
  },
  default: { input: 1, cacheHit: 0.02, output: 2 },
};

/** Keep a numeric override only when it is a finite non-negative number. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Keep a string override only when it is non-empty. */
function stringOr(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** Merge one price row over its fallback; missing/invalid fields keep the fallback. */
function priceRow(value, fallback) {
  const row = value !== null && typeof value === 'object' ? value : {};
  const base = fallback !== null && typeof fallback === 'object' ? fallback : {};
  const result = {
    input: numberOr(row.input, numberOr(base.input, 0)),
    cacheHit: numberOr(row.cacheHit, numberOr(base.cacheHit, 0)),
    output: numberOr(row.output, numberOr(base.output, 0)),
  };
  // Only spelled out when configured; `cacheWriteUsesInput` covers the default.
  if (row.cacheWrite !== undefined || base.cacheWrite !== undefined) {
    result.cacheWrite = numberOr(row.cacheWrite, numberOr(base.cacheWrite, 0));
  }
  return result;
}

/**
 * Deep-merge `config.prices` over {@link DEFAULT_PRICES}: scalars override,
 * model rows merge field-by-field, and unknown model ids join the table.
 */
function normalizePrices(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const sourceModels = source.models !== null && typeof source.models === 'object' ? source.models : {};
  const models = {};
  for (const [name, row] of Object.entries(DEFAULT_PRICES.models)) {
    models[name] = priceRow(sourceModels[name], row);
  }
  for (const [name, row] of Object.entries(sourceModels)) {
    if (Object.prototype.hasOwnProperty.call(models, name)) continue;
    models[name] = priceRow(row, DEFAULT_PRICES.default);
  }
  return {
    currency: stringOr(source.currency, DEFAULT_PRICES.currency),
    symbol: typeof source.symbol === 'string' ? source.symbol : DEFAULT_PRICES.symbol,
    perMillion: source.perMillion !== false,
    cacheWriteUsesInput: source.cacheWriteUsesInput !== false,
    models,
    default: priceRow(source.default, DEFAULT_PRICES.default),
  };
}

/** Merge a row's plain-object `config` over the defaults. */
function normalizeConfig(config) {
  const input = config !== null && typeof config === 'object' ? config : {};
  const routePath = stringOr(input.routePath, DEFAULTS.routePath);
  return {
    routePath: routePath.startsWith('/') ? routePath : `/${routePath}`,
    apiKeyRef: stringOr(input.apiKeyRef, DEFAULTS.apiKeyRef),
    balanceUrl: stringOr(input.balanceUrl, DEFAULTS.balanceUrl),
    cacheTtlMs: numberOr(input.cacheTtlMs, DEFAULTS.cacheTtlMs),
    failureBackoffMs: numberOr(input.failureBackoffMs, DEFAULTS.failureBackoffMs),
    staleMaxMs: numberOr(input.staleMaxMs, DEFAULTS.staleMaxMs),
    timeoutMs: numberOr(input.timeoutMs, DEFAULTS.timeoutMs),
    minRefreshMs: numberOr(input.minRefreshMs, DEFAULTS.minRefreshMs),
    prices: normalizePrices(input.prices),
  };
}

/** Display-only provider label: the balance endpoint's host. */
function providerOf(balanceUrl) {
  try {
    return new URL(balanceUrl).host;
  } catch {
    return 'api.deepseek.com';
  }
}

/** Coerce an upstream decimal field to a string; empty when absent. */
function decimalText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * Normalize the upstream body. Returns null for a shape we cannot display;
 * balance strings stay strings so the browser formats them exactly.
 */
function normalizeUpstream(payload, provider) {
  if (payload === null || typeof payload !== 'object') return null;
  const infos = payload.balance_infos;
  if (!Array.isArray(infos)) return null;
  const balances = [];
  for (const info of infos) {
    if (info === null || typeof info !== 'object') return null;
    balances.push({
      currency: typeof info.currency === 'string' ? info.currency : '',
      total: decimalText(info.total_balance),
      granted: decimalText(info.granted_balance),
      toppedUp: decimalText(info.topped_up_balance),
    });
  }
  return { isAvailable: payload.is_available === true, balances, provider };
}

/** Abort after `timeoutMs` when the runtime supports `AbortSignal.timeout`. */
function timeoutSignal(timeoutMs) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(timeoutMs);
    }
  } catch {
    // Fall through: no signal is better than failing the lookup.
  }
  return undefined;
}

/**
 * Host half body. All mutable state is per plugin activation.
 * @param ctx - Cordis context owning the web route.
 * @param config - patch row config (plain object, all keys optional).
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const provider = providerOf(cfg.balanceUrl);

  let webServer;
  try {
    webServer = ctx.webServer;
  } catch {
    return; // Service not active in this composition; stay inert.
  }
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
    return;
  }

  /** Last successful normalized snapshot, or null. */
  let lastSuccess = null;
  /** Last failure `{ code, message, status? }`, or null after a success. */
  let lastError = null;
  /** Timestamp of the last failure (drives the backoff window). */
  let lastErrorAt = 0;
  /** Timestamp of the last fetch start (drives the explicit-refresh floor). */
  let lastFetchStartedAt = 0;
  /** Single-flight promise; concurrent requests share one upstream call. */
  let inFlight = null;

  const successBody = (success) => ({
    ok: true,
    fetchedAt: success.fetchedAt,
    stale: false,
    isAvailable: success.isAvailable,
    balances: success.balances,
    provider: success.provider,
    prices: cfg.prices,
  });

  /**
   * Error body. When a last-known snapshot exists and is younger than
   * staleMaxMs, attach it so the client can keep showing the amount with a
   * stale marker instead of a blank strip.
   */
  const errorBody = (error, stale) => {
    const body = {
      ok: false,
      code: error !== null && typeof error === 'object' ? error.code : 'network',
      message: error !== null && typeof error === 'object' ? error.message : 'balance unavailable',
      prices: cfg.prices,
    };
    if (error !== null && typeof error === 'object' && error.status !== undefined) body.status = error.status;
    if (stale !== null && stale !== undefined) {
      body.fetchedAt = stale.fetchedAt;
      body.stale = true;
      body.isAvailable = stale.isAvailable;
      body.balances = stale.balances;
      body.provider = stale.provider;
    }
    return body;
  };

  /** Best currently available answer without touching the network. */
  const cachedOrError = (now) => {
    if (lastSuccess !== null && now - lastSuccess.fetchedAt < cfg.cacheTtlMs) return successBody(lastSuccess);
    if (lastSuccess !== null && now - lastSuccess.fetchedAt <= cfg.staleMaxMs) return errorBody(lastError, lastSuccess);
    return errorBody(lastError, null);
  };

  /** Record a failure and answer with the best stale data still allowed. */
  const fail = (error) => {
    lastError = error;
    lastErrorAt = Date.now();
    const stale = lastSuccess !== null && lastErrorAt - lastSuccess.fetchedAt <= cfg.staleMaxMs
      ? lastSuccess
      : null;
    return errorBody(error, stale);
  };

  /** One upstream lookup; never rejects (all failure paths become bodies). */
  const fetchBalance = async () => {
    lastFetchStartedAt = Date.now();
    try {
      let resolved;
      try {
        resolved = await ctx.credentials.resolve(cfg.apiKeyRef);
      } catch {
        return fail({ code: 'no-credential', message: 'credential lookup failed' });
      }
      if (resolved === undefined || resolved === null || typeof resolved.value !== 'string' || resolved.value.length === 0) {
        return fail({ code: 'no-credential', message: `credential ${cfg.apiKeyRef} is not configured` });
      }
      if (typeof fetch !== 'function') {
        return fail({ code: 'network', message: 'fetch is unavailable in this runtime' });
      }

      let response;
      try {
        response = await fetch(cfg.balanceUrl, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${resolved.value}`,
            accept: 'application/json',
          },
          signal: timeoutSignal(cfg.timeoutMs),
        });
      } catch (error) {
        const timedOut = error !== null && typeof error === 'object'
          && (error.name === 'TimeoutError' || error.name === 'AbortError');
        return fail({
          code: 'network',
          message: timedOut ? 'upstream request timed out' : 'upstream request failed',
        });
      }

      if (!response.ok) {
        return fail({
          code: 'upstream-status',
          status: response.status,
          message: `upstream returned HTTP ${response.status}`,
        });
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        return fail({ code: 'parse', message: 'upstream response was not valid JSON' });
      }
      const normalized = normalizeUpstream(payload, provider);
      if (normalized === null) {
        return fail({ code: 'parse', message: 'upstream response had an unexpected shape' });
      }

      lastSuccess = { ...normalized, fetchedAt: Date.now() };
      lastError = null;
      lastErrorAt = 0;
      return successBody(lastSuccess);
    } catch {
      return fail({ code: 'internal', message: 'balance lookup failed' });
    }
  };

  /**
   * Resolve one request: cache hit, single-flight join, throttle/backoff
   * short-circuit, or a fresh fetch. `force` comes from `?refresh=1` and only
   * bypasses the TTL, never the minRefreshMs floor.
   */
  const readBalance = (force) => {
    const now = Date.now();
    const fresh = lastSuccess !== null && now - lastSuccess.fetchedAt < cfg.cacheTtlMs;
    if (fresh && !force) return Promise.resolve(successBody(lastSuccess));
    if (inFlight !== null) return inFlight;

    if (force && now - lastFetchStartedAt < cfg.minRefreshMs) return Promise.resolve(cachedOrError(now));
    if (!force && lastError !== null && now - lastErrorAt < cfg.failureBackoffMs) {
      return Promise.resolve(cachedOrError(now));
    }

    const pending = fetchBalance();
    inFlight = pending;
    const settle = () => {
      if (inFlight === pending) inFlight = null;
    };
    pending.then(settle, settle);
    return pending;
  };

  /** Write one JSON response; the route owns the whole response lifecycle. */
  const respond = (res, status, body, extraHeaders) => {
    res.statusCode = status;
    if (extraHeaders !== undefined && extraHeaders !== null) {
      for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
    }
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  };

  const handler = async (req, res) => {
    try {
      if (req.method !== 'GET') {
        respond(res, 405, {
          ok: false,
          code: 'method-not-allowed',
          message: 'only GET is supported',
          prices: cfg.prices,
        }, { allow: 'GET' });
        return;
      }
      let force = false;
      try {
        force = new URL(String(req.url ?? '/'), 'http://localhost').searchParams.get('refresh') === '1';
      } catch {
        force = false;
      }
      respond(res, 200, await readBalance(force));
    } catch {
      // Last-resort guard: a route must always answer.
      try {
        respond(res, 200, { ok: false, code: 'internal', message: 'balance lookup failed', prices: cfg.prices });
      } catch {
        // The response is already gone; nothing left to do.
      }
    }
  };

  ctx.effect(
    () => webServer.register({ kind: 'exact', path: cfg.routePath, handler }),
    `status-balance: GET ${cfg.routePath}`,
  );
}
