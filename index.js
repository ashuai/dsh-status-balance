/**
 * dsh-status-balance — Host half.
 *
 * Owns two things:
 * 1. The DeepSeek wallet balance: resolves the API key through `ctx.credentials`,
 *    calls the upstream balance endpoint, and serves a display-safe JSON snapshot
 *    on a same-origin web route.
 * 2. A local daily ledger: folds billed token usage from live and persisted
 *    sessions into `mySpendUnits`, observes wallet balance changes, and derives
 *    today's difference and a runway estimate.
 *
 * The API key never leaves this process. The ledger file contains only token
 * counts and money amounts (never prompts, messages, or credentials).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Plugin name used by the Loader row (`name: dsh-status-balance`). */
export const name = 'dsh-status-balance';

/** Required services; Cordis keeps `apply` pending until all are available. */
export const inject = ['webServer', 'credentials', 'sessions', 'sessionPersistence'];

const DAY_MS = 86400000;
const HISTORY_MAX = 14;
const MAX_BACKFILL_SESSIONS = 200;
const MAX_BACKFILL_EVENTS = 200000;
const LEDGER_VERSION = 1;
const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const BACKFILL_ROUTE_WAIT_MS = 1500;
const SAVE_DEBOUNCE_MS = 2000;

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
 * Off-peak / peak list prices per 1M tokens in CNY (Reasonix provider prices).
 * A flat row `{ input, cacheHit, output }` is still accepted and applies to both
 * slots. The whole table is overridable through `config.prices`.
 */
const DEFAULT_PRICES = {
  currency: 'CNY',
  symbol: '¥',
  perMillion: true,
  cacheWriteUsesInput: true,
  timezone: DEFAULT_TIMEZONE,
  peakWindows: [[9, 12], [14, 18]],
  weekendOffPeak: true,
  models: {
    'deepseek-flash': {
      off: { input: 1, cacheHit: 0.02, output: 4 },
      peak: { input: 2, cacheHit: 0.04, output: 8 },
    },
    'deepseek-v4-flash': {
      off: { input: 1, cacheHit: 0.02, output: 4 },
      peak: { input: 2, cacheHit: 0.04, output: 8 },
    },
    'deepseek-v4-flash-1017': {
      off: { input: 1, cacheHit: 0.02, output: 4 },
      peak: { input: 2, cacheHit: 0.04, output: 8 },
    },
    'deepseek-v4-pro': {
      off: { input: 4.5, cacheHit: 0.15, output: 13.5 },
      peak: { input: 9, cacheHit: 0.3, output: 27 },
    },
    'deepseek-v4-pro-0813': {
      off: { input: 4.5, cacheHit: 0.15, output: 13.5 },
      peak: { input: 9, cacheHit: 0.3, output: 27 },
    },
  },
  default: {
    off: { input: 1, cacheHit: 0.02, output: 4 },
    peak: { input: 2, cacheHit: 0.04, output: 8 },
  },
};

// --- plain config / value helpers -----------------------------------------

/** Keep a numeric override only when it is a finite non-negative number. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Keep a string override only when it is non-empty. */
function stringOr(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// --- time zone / peak-window helpers --------------------------------------

const formatterCache = new Map();

function partsFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function validTimeZone(timeZone) {
  try {
    partsFormatter(timeZone).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** Local wall-clock parts of one instant in `timeZone`. */
function dateParts(ms, timeZone) {
  const values = {};
  for (const part of partsFormatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: values.weekday,
  };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function localDay(ms, timeZone) {
  const parts = dateParts(ms, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** Offset of `timeZone` from UTC at one instant, in ms. */
function zoneOffset(ms, timeZone) {
  const parts = dateParts(ms, timeZone);
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUTC - Math.floor(ms / 1000) * 1000;
}

function localEpoch(year, month, day, hour, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  const offset = zoneOffset(guess, timeZone);
  let epoch = guess - offset;
  const refined = zoneOffset(epoch, timeZone);
  if (refined !== offset) epoch = guess - refined;
  return epoch;
}

function localDayStart(ms, timeZone) {
  const parts = dateParts(ms, timeZone);
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  const offset = zoneOffset(guess, timeZone);
  let start = guess - offset;
  const refined = zoneOffset(start, timeZone);
  if (refined !== offset) start = guess - refined;
  return start;
}

function addDays(year, month, day, offset) {
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function isPeakHour(hour, peakWindows) {
  for (const window of peakWindows) {
    if (hour >= window[0] && hour < window[1]) return true;
  }
  return false;
}

/** Current price slot at one instant: 'peak' or 'offpeak'. */
function slotAt(ms, prices) {
  const parts = dateParts(ms, prices.timezone);
  const weekend = parts.weekday === 'Sat' || parts.weekday === 'Sun';
  if (weekend && prices.weekendOffPeak) return 'offpeak';
  return isPeakHour(parts.hour, prices.peakWindows) ? 'peak' : 'offpeak';
}

/** First instant after `ms` where the slot changes (bounds from the windows). */
function nextSlotBoundary(ms, prices) {
  const current = slotAt(ms, prices);
  const parts = dateParts(ms, prices.timezone);
  const hours = new Set([0]);
  for (const window of prices.peakWindows) {
    hours.add(window[0]);
    hours.add(window[1]);
  }
  const ordered = [...hours].sort((left, right) => left - right);
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = addDays(parts.year, parts.month, parts.day, offset);
    for (const hour of ordered) {
      const candidate = localEpoch(date.year, date.month, date.day, hour, prices.timezone);
      if (candidate <= ms) continue;
      if (slotAt(candidate, prices) !== current) return candidate;
    }
  }
  return ms + DAY_MS;
}

// --- price table merge -----------------------------------------------------

function normalizePeakWindows(value) {
  if (!Array.isArray(value)) return DEFAULT_PRICES.peakWindows.map((window) => [...window]);
  const windows = [];
  for (const window of value) {
    if (!Array.isArray(window) || window.length !== 2) continue;
    const start = Number(window[0]);
    const end = Number(window[1]);
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= 24 && start < end) {
      windows.push([start, end]);
    }
  }
  return windows.length > 0 ? windows : DEFAULT_PRICES.peakWindows.map((window) => [...window]);
}

/** Merge one pricing slot over its fallback. */
function slotRow(value, fallback) {
  const row = isPlainObject(value) ? value : {};
  const base = isPlainObject(fallback) ? fallback : {};
  const result = {
    input: numberOr(row.input, numberOr(base.input, 0)),
    cacheHit: numberOr(row.cacheHit, numberOr(base.cacheHit, 0)),
    output: numberOr(row.output, numberOr(base.output, 0)),
  };
  if (row.cacheWrite !== undefined || base.cacheWrite !== undefined) {
    result.cacheWrite = numberOr(row.cacheWrite, numberOr(base.cacheWrite, 0));
  }
  return result;
}

/**
 * Normalize one model row into `{ off, peak }`. A legacy flat row applies the
 * same values to both slots; a slot-shaped row merges each slot separately.
 */
function priceRow(value, fallback) {
  const row = isPlainObject(value) ? value : {};
  const base = isPlainObject(fallback) ? fallback : DEFAULT_PRICES.default;
  const hasSlots = isPlainObject(row.off) || isPlainObject(row.peak);
  if (hasSlots) {
    return { off: slotRow(row.off, base.off), peak: slotRow(row.peak, base.peak) };
  }
  return { off: slotRow(row, base.off), peak: slotRow(row, base.peak) };
}

/** Deep-merge `config.prices` over {@link DEFAULT_PRICES}. */
function normalizePrices(input) {
  const source = isPlainObject(input) ? input : {};
  const sourceModels = isPlainObject(source.models) ? source.models : {};
  const models = {};
  for (const [model, row] of Object.entries(DEFAULT_PRICES.models)) {
    models[model] = priceRow(sourceModels[model], row);
  }
  for (const [model, row] of Object.entries(sourceModels)) {
    if (Object.prototype.hasOwnProperty.call(models, model)) continue;
    models[model] = priceRow(row, DEFAULT_PRICES.default);
  }
  return {
    currency: stringOr(source.currency, DEFAULT_PRICES.currency),
    symbol: typeof source.symbol === 'string' ? source.symbol : DEFAULT_PRICES.symbol,
    perMillion: source.perMillion !== false,
    cacheWriteUsesInput: source.cacheWriteUsesInput !== false,
    timezone: validTimeZone(stringOr(source.timezone, DEFAULT_TIMEZONE)),
    peakWindows: normalizePeakWindows(source.peakWindows),
    weekendOffPeak: source.weekendOffPeak !== false,
    models,
    default: priceRow(source.default, DEFAULT_PRICES.default),
  };
}

function priceRowFor(prices, model, slot) {
  const row = model !== '' && Object.prototype.hasOwnProperty.call(prices.models, model)
    ? prices.models[model]
    : prices.default;
  const key = slot === 'peak' ? 'peak' : 'off';
  return row[key] ?? prices.default[key];
}

/** Resolve the effective per-token price, folding cache writes onto input. */
function resolvePrice(row, prices) {
  return {
    input: row.input,
    cacheHit: row.cacheHit,
    output: row.output,
    cacheWrite: prices.cacheWriteUsesInput ? row.input : (row.cacheWrite ?? row.input),
  };
}

/** Merge a row's plain-object `config` over the defaults. */
function normalizeConfig(config) {
  const input = isPlainObject(config) ? config : {};
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

function providerOf(balanceUrl) {
  try {
    return new URL(balanceUrl).host;
  } catch {
    return 'api.deepseek.com';
  }
}

function decimalText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** Normalize the upstream balance body; null for shapes we cannot display. */
function normalizeUpstream(payload, provider) {
  if (!isPlainObject(payload)) return null;
  const infos = payload.balance_infos;
  if (!Array.isArray(infos)) return null;
  const balances = [];
  for (const info of infos) {
    if (!isPlainObject(info)) return null;
    balances.push({
      currency: typeof info.currency === 'string' ? info.currency : '',
      total: decimalText(info.total_balance),
      granted: decimalText(info.granted_balance),
      toppedUp: decimalText(info.topped_up_balance),
    });
  }
  return { isAvailable: payload.is_available === true, balances, provider };
}

function timeoutSignal(timeoutMs) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(timeoutMs);
    }
  } catch {
    // No signal is better than failing the lookup.
  }
  return undefined;
}

// --- decimal text <-> 0.0001-yuan integer units ---------------------------

function parseDecimal(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) raw = String(raw);
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const negative = text.charAt(0) === '-';
  const unsigned = text.replace(/^[+-]/, '');
  const dot = unsigned.indexOf('.');
  const integer = (dot === -1 ? unsigned : unsigned.slice(0, dot)).replace(/^0+(?=\d)/, '') || '0';
  return { negative, integer, fraction: dot === -1 ? '' : unsigned.slice(dot + 1) };
}

/** Decimal text -> integer ¥0.0001 units, rounded half-up on the 5th decimal. */
function unitsFromDecimal(raw) {
  const value = parseDecimal(raw);
  if (value === null) return null;
  const fraction = (value.fraction + '00000').slice(0, 5);
  let units = BigInt(value.integer) * 10000n + BigInt(fraction.slice(0, 4));
  if (Number(fraction.charAt(4)) >= 5) units += 1n;
  const signed = value.negative ? -units : units;
  if (signed > 9007199254740991n || signed < -9007199254740991n) return null;
  return Number(signed);
}

/** Integer ¥0.0001 units -> decimal string with 2..4 fraction digits. */
function unitsToText(value) {
  const rounded = Math.round(Number(value) || 0);
  const negative = rounded < 0;
  const absolute = Math.abs(rounded);
  const integer = Math.floor(absolute / 10000);
  let fraction = String(absolute % 10000).padStart(4, '0');
  while (fraction.length > 2 && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  return `${negative ? '-' : ''}${integer}.${fraction}`;
}

function safeInt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function nullableInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

// --- token usage / event pricing ------------------------------------------

function normalizeUsage(usage) {
  if (!isPlainObject(usage)) return null;
  return {
    uncachedInput: Math.max(0, Math.round(Number(usage.inputTokens) || 0)),
    cacheRead: Math.max(0, Math.round(Number(usage.cacheReadTokens) || 0)),
    cacheWrite: Math.max(0, Math.round(Number(usage.cacheWriteTokens) || 0)),
    output: Math.max(0, Math.round(Number(usage.outputTokens) || 0)),
  };
}

/**
 * Mirror token-meter's usageOf: assistant/message `usage` first, then the last
 * raw `usage` chunk of an embedded attempt/message stream.
 */
function usageOf(event) {
  if (!isPlainObject(event) || !isPlainObject(event.data)) return null;
  if (event.type === 'assistant/message' && event.data.usage !== undefined) {
    return normalizeUsage(event.data.usage);
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return null;
  const stream = event.data.stream;
  if (!Array.isArray(stream)) return null;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (isPlainObject(record) && record.type === 'chunk' && isPlainObject(record.chunk)
      && record.chunk.type === 'usage' && record.chunk.usage !== undefined) {
      return normalizeUsage(record.chunk.usage);
    }
  }
  return null;
}

function modelFromMessage(event) {
  if (!isPlainObject(event.data)) return '';
  const message = event.data.message;
  if (!isPlainObject(message)) return '';
  const source = message.source;
  if (!isPlainObject(source) || typeof source.model !== 'string') return '';
  return source.model;
}

function priceNano(price) {
  const value = typeof price === 'number' && Number.isFinite(price) && price >= 0 ? price : 0;
  return BigInt(Math.round(value * 1e9));
}

/** Price one usage sample into integer ¥0.0001 units. */
function costUnits(buckets, price) {
  const terms = [
    [buckets.uncachedInput, price.input],
    [buckets.cacheRead, price.cacheHit],
    [buckets.cacheWrite, price.cacheWrite],
    [buckets.output, price.output],
  ];
  let numerator = 0n;
  for (const [tokens, unitPrice] of terms) {
    numerator += BigInt(tokens) * priceNano(unitPrice);
  }
  return Number((numerator + 50000000000n) / 100000000000n);
}

// --- ledger file ----------------------------------------------------------

function freshToday() {
  return {
    mySpendUnits: 0,
    balanceDecreaseUnits: 0,
    balanceIncreaseUnits: 0,
    firstBalance: null,
    lastBalance: null,
    firstSeenAt: null,
    lastSeenAt: null,
  };
}

function freshLedger(day) {
  return {
    version: LEDGER_VERSION,
    day,
    today: freshToday(),
    sessions: {},
    history: [],
    backfill: { day, status: 'pending', truncated: false },
  };
}

function sanitizeLedger(raw, currentDay) {
  if (!isPlainObject(raw)) return freshLedger(currentDay);
  const todayRaw = isPlainObject(raw.today) ? raw.today : {};
  const today = {
    mySpendUnits: safeInt(todayRaw.mySpendUnits),
    balanceDecreaseUnits: safeInt(todayRaw.balanceDecreaseUnits),
    balanceIncreaseUnits: safeInt(todayRaw.balanceIncreaseUnits),
    firstBalance: nullableInt(todayRaw.firstBalance),
    lastBalance: nullableInt(todayRaw.lastBalance),
    firstSeenAt: nullableInt(todayRaw.firstSeenAt),
    lastSeenAt: nullableInt(todayRaw.lastSeenAt),
  };
  const sessions = {};
  if (isPlainObject(raw.sessions)) {
    for (const [id, row] of Object.entries(raw.sessions)) {
      if (id.length === 0 || !isPlainObject(row)) continue;
      if (typeof row.seq === 'number' && Number.isSafeInteger(row.seq) && row.seq >= 0) {
        sessions[id] = { seq: row.seq };
      }
    }
  }
  const history = [];
  if (Array.isArray(raw.history)) {
    for (const entry of raw.history) {
      if (!isPlainObject(entry) || typeof entry.day !== 'string' || !DAY_PATTERN.test(entry.day)) continue;
      history.push({
        day: entry.day,
        mySpendUnits: safeInt(entry.mySpendUnits),
        balanceDecreaseUnits: safeInt(entry.balanceDecreaseUnits),
      });
    }
  }
  const day = typeof raw.day === 'string' && DAY_PATTERN.test(raw.day) ? raw.day : currentDay;
  const backfillRaw = isPlainObject(raw.backfill) ? raw.backfill : {};
  const status = backfillRaw.status === 'done' || backfillRaw.status === 'partial' ? backfillRaw.status : 'pending';
  return {
    version: LEDGER_VERSION,
    day,
    today,
    sessions,
    history: history.slice(-HISTORY_MAX),
    backfill: {
      day: typeof backfillRaw.day === 'string' && DAY_PATTERN.test(backfillRaw.day) ? backfillRaw.day : day,
      status,
      truncated: backfillRaw.truncated === true,
    },
  };
}

function loadLedger(file, currentDay) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return freshLedger(currentDay);
  }
  try {
    return sanitizeLedger(JSON.parse(text), currentDay);
  } catch {
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // The corrupt file stays; the fresh in-memory ledger still works.
    }
    return freshLedger(currentDay);
  }
}

function writeLedgerNow(file, ledger) {
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(ledger));
    fs.renameSync(temporary, file);
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Nothing left to clean up.
    }
  }
}

function ledgerPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, '.dsh-status-balance.json');
}

const wait = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

// --- plugin body ----------------------------------------------------------

/**
 * Host half body.
 * @param ctx - Cordis context owning the web route and session events.
 * @param config - patch row config (plain object, all keys optional).
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const prices = cfg.prices;
  const timeZone = prices.timezone;
  const provider = providerOf(cfg.balanceUrl);
  const file = ledgerPath();

  let webServer;
  try {
    webServer = ctx.webServer;
  } catch {
    return;
  }
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return;

  let sessions = null;
  try {
    sessions = ctx.sessions ?? null;
  } catch {
    sessions = null;
  }
  let persistence = null;
  try {
    persistence = ctx.sessionPersistence ?? null;
  } catch {
    persistence = null;
  }
  const ledgerAvailable = sessions !== null && typeof sessions.list === 'function';

  const currentDay = localDay(Date.now(), timeZone);
  let ledger = loadLedger(file, currentDay);
  let saveTimer = null;
  let backfillPromise = null;
  /** Last request context model per session, for assistant/attempt pricing. */
  const lastModel = new Map();

  // --- persistence --------------------------------------------------------

  function scheduleSave() {
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeLedgerNow(file, ledger);
    }, SAVE_DEBOUNCE_MS);
    if (typeof saveTimer.unref === 'function') saveTimer.unref();
  }

  function flushSave() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    writeLedgerNow(file, ledger);
  }

  // --- day rollover -------------------------------------------------------

  function rollover(day) {
    if (ledger.day === day) return;
    const previous = ledger.today;
    if (typeof ledger.day === 'string' && DAY_PATTERN.test(ledger.day)) {
      ledger.history.push({
        day: ledger.day,
        mySpendUnits: previous.mySpendUnits,
        balanceDecreaseUnits: previous.balanceDecreaseUnits,
      });
      if (ledger.history.length > HISTORY_MAX) ledger.history = ledger.history.slice(-HISTORY_MAX);
    }
    const baseline = previous.lastBalance;
    ledger.day = day;
    ledger.today = freshToday();
    // The new day starts from the last known balance as its baseline.
    ledger.today.firstBalance = baseline;
    ledger.today.lastBalance = baseline;
    ledger.backfill = { day, status: 'pending', truncated: false };
    scheduleSave();
    void ensureBackfill();
  }

  // --- ledger updates -----------------------------------------------------

  function countUsage(sessionId, seq, time, buckets, model) {
    const slot = slotAt(time, prices);
    const price = resolvePrice(priceRowFor(prices, model, slot), prices);
    ledger.today.mySpendUnits += costUnits(buckets, price);
    const previous = ledger.sessions[sessionId]?.seq ?? -1;
    if (seq > previous) ledger.sessions[sessionId] = { seq };
    scheduleSave();
  }

  function applySessionEvent(session, event) {
    if (!ledgerAvailable || !isPlainObject(session) || !isPlainObject(event)) return;
    if (typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 0) return;
    const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now();
    const sessionId = String(session.id ?? '');
    if (sessionId.length === 0) return;
    if (event.type === 'request/context') {
      lastModel.set(sessionId, isPlainObject(event.data) && typeof event.data.model === 'string' ? event.data.model : '');
      return;
    }
    const day = localDay(time, timeZone);
    if (day !== ledger.day) {
      if (day < ledger.day) return;
      rollover(day);
    }
    let own = true;
    if (typeof session.isOwnSeq === 'function') {
      try {
        own = session.isOwnSeq(event.seq) === true;
      } catch {
        own = false;
      }
    }
    if (!own) return;
    const watermark = ledger.sessions[sessionId]?.seq ?? -1;
    if (event.seq <= watermark) return;
    const buckets = usageOf(event);
    if (buckets === null) return;
    const model = modelFromMessage(event) || lastModel.get(sessionId) || '';
    countUsage(sessionId, event.seq, time, buckets, model);
  }

  function foldStoredEvent(sessionId, event, ownFrom) {
    if (!isPlainObject(event) || typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq)) return false;
    if (event.seq < ownFrom) return false;
    const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now();
    if (event.type === 'request/context') {
      lastModel.set(sessionId, isPlainObject(event.data) && typeof event.data.model === 'string' ? event.data.model : '');
      return false;
    }
    if (localDay(time, timeZone) !== ledger.day) return false;
    const watermark = ledger.sessions[sessionId]?.seq ?? -1;
    if (event.seq <= watermark) return false;
    const buckets = usageOf(event);
    if (buckets === null) return false;
    const model = modelFromMessage(event) || lastModel.get(sessionId) || '';
    countUsage(sessionId, event.seq, time, buckets, model);
    return true;
  }

  // --- balance observations ----------------------------------------------

  function observeBalanceUnits(units, now) {
    const day = localDay(now, timeZone);
    if (day !== ledger.day) {
      if (day < ledger.day) return;
      rollover(day);
    }
    const today = ledger.today;
    if (today.lastBalance === null) {
      today.firstBalance = units;
      today.lastBalance = units;
      today.firstSeenAt = now;
      today.lastSeenAt = now;
    } else {
      if (units < today.lastBalance) today.balanceDecreaseUnits += today.lastBalance - units;
      else if (units > today.lastBalance) today.balanceIncreaseUnits += units - today.lastBalance;
      if (today.firstSeenAt === null) today.firstSeenAt = now;
      today.lastSeenAt = now;
      today.lastBalance = units;
    }
    scheduleSave();
  }

  function observeBalances(balances) {
    if (!ledgerAvailable || !Array.isArray(balances) || balances.length === 0) return;
    const cny = balances.find((wallet) => typeof wallet?.currency === 'string' && wallet.currency.toUpperCase() === 'CNY');
    const wallet = cny ?? balances[0];
    const units = unitsFromDecimal(wallet?.total);
    if (units === null) return;
    observeBalanceUnits(units, Date.now());
  }

  // --- backfill -----------------------------------------------------------

  async function runBackfill() {
    const dayStart = localDayStart(Date.now(), timeZone);
    let partial = false;
    let truncated = false;
    const live = new Map();
    const sources = [];

    if (sessions !== null && typeof sessions.list === 'function') {
      try {
        for (const session of sessions.list()) {
          const id = String(session?.id ?? '');
          if (id.length === 0) continue;
          live.set(id, session);
          sources.push({ id, live: session });
        }
      } catch {
        partial = true;
      }
    }

    if (persistence !== null && typeof persistence.list === 'function' && typeof persistence.open === 'function') {
      try {
        const snapshots = await persistence.list();
        for (const snapshot of snapshots) {
          const header = snapshot?.header;
          if (!isPlainObject(header) || typeof header.id !== 'string') continue;
          if (typeof header.createdAt !== 'number' || header.createdAt < dayStart - DAY_MS) continue;
          if (live.has(header.id)) continue;
          sources.push({ id: header.id, snapshot });
        }
      } catch {
        partial = true;
      }
    }

    if (sources.length > MAX_BACKFILL_SESSIONS) {
      sources.length = MAX_BACKFILL_SESSIONS;
      truncated = true;
    }

    let eventCount = 0;
    for (const source of sources) {
      if (eventCount >= MAX_BACKFILL_EVENTS) {
        truncated = true;
        break;
      }
      try {
        if (source.live !== undefined) {
          const events = source.live.ownEvents();
          for (const event of events) {
            if (eventCount >= MAX_BACKFILL_EVENTS) {
              truncated = true;
              break;
            }
            eventCount += 1;
            foldStoredEvent(source.id, event, 0);
          }
        } else {
          const handle = await persistence.open(source.id, 'read');
          try {
            const read = await handle.read();
            const ownFrom = typeof handle.inheritedEventCount === 'number' ? handle.inheritedEventCount : 0;
            const events = Array.isArray(read?.events) ? read.events : [];
            for (const event of events) {
              if (eventCount >= MAX_BACKFILL_EVENTS) {
                truncated = true;
                break;
              }
              eventCount += 1;
              foldStoredEvent(source.id, event, ownFrom);
            }
          } finally {
            try {
              await handle.close();
            } catch {
              partial = true;
            }
          }
        }
      } catch {
        partial = true;
      }
    }

    ledger.backfill = {
      day: ledger.day,
      status: truncated || partial ? 'partial' : 'done',
      truncated,
    };
    scheduleSave();
  }

  function ensureBackfill() {
    if (!ledgerAvailable) return Promise.resolve();
    if (ledger.backfill.day !== ledger.day) {
      ledger.backfill = { day: ledger.day, status: 'pending', truncated: false };
    }
    if (ledger.backfill.status === 'done' || ledger.backfill.status === 'partial') return Promise.resolve();
    if (backfillPromise !== null) return backfillPromise;
    backfillPromise = runBackfill()
      .catch(() => {
        ledger.backfill = { day: ledger.day, status: 'partial', truncated: ledger.backfill.truncated === true };
        scheduleSave();
      })
      .finally(() => {
        backfillPromise = null;
      });
    return backfillPromise;
  }

  // --- initial day / listeners -------------------------------------------

  if (ledger.day !== currentDay && currentDay > ledger.day) rollover(currentDay);
  if (ledger.backfill.day !== ledger.day) {
    ledger.backfill = { day: ledger.day, status: 'pending', truncated: false };
  }

  ctx.effect(() => () => flushSave(), 'status-balance: ledger flush');
  if (ledgerAvailable) {
    ctx.effect(
      () => ctx.on('session/event', (session, event) => {
        try {
          applySessionEvent(session, event);
        } catch {
          // A ledger fold must never disturb the session hot path.
        }
      }),
      'status-balance: ledger session events',
    );
    void ensureBackfill();
  }

  // --- route payloads -----------------------------------------------------

  function todayPayload() {
    if (!ledgerAvailable) return undefined;
    const today = ledger.today;
    return {
      date: ledger.day,
      mySpend: unitsToText(today.mySpendUnits),
      balanceDecrease: unitsToText(today.balanceDecreaseUnits),
      balanceIncrease: unitsToText(today.balanceIncreaseUnits),
      difference: unitsToText(Math.max(0, today.balanceDecreaseUnits - today.mySpendUnits)),
      firstBalance: today.firstBalance === null ? null : unitsToText(today.firstBalance),
      lastBalance: today.lastBalance === null ? null : unitsToText(today.lastBalance),
      observedSince: today.firstSeenAt,
      backfill: { ...ledger.backfill },
    };
  }

  function trendPayload() {
    if (!ledgerAvailable) return undefined;
    const positive = ledger.history
      .filter((entry) => entry.balanceDecreaseUnits > 0)
      .slice(-7);
    let average = null;
    let basis = 'none';
    if (positive.length > 0) {
      const total = positive.reduce((sum, entry) => sum + entry.balanceDecreaseUnits, 0);
      average = total / positive.length;
      basis = 'history';
    } else {
      const today = ledger.today;
      if (today.firstSeenAt !== null && today.lastSeenAt !== null
        && today.lastSeenAt - today.firstSeenAt >= 3600000 && today.balanceDecreaseUnits > 0) {
        const dayStart = localDayStart(Date.now(), timeZone);
        const elapsedFraction = Math.min(1, Math.max(0.05, (Date.now() - dayStart) / DAY_MS));
        average = today.balanceDecreaseUnits / elapsedFraction;
        basis = 'today';
      }
    }
    const lastBalance = ledger.today.lastBalance;
    const daysLeft = average !== null && average > 0 && lastBalance !== null
      ? Math.floor(lastBalance / average)
      : null;
    return {
      avgDailyDecrease: average === null ? null : unitsToText(average),
      daysLeft,
      basis,
      days: ledger.history.slice(-7).map((entry) => ({
        date: entry.day,
        decrease: unitsToText(entry.balanceDecreaseUnits),
      })),
    };
  }

  function slotPayload(now) {
    return {
      state: slotAt(now, prices),
      until: nextSlotBoundary(now, prices),
      timezone: prices.timezone,
    };
  }

  function ledgerView(now) {
    const view = { slot: slotPayload(now) };
    if (ledgerAvailable) {
      view.today = todayPayload();
      view.trend = trendPayload();
    }
    return view;
  }

  // --- balance cache / single-flight -------------------------------------

  let lastSuccess = null;
  let lastError = null;
  let lastErrorAt = 0;
  let lastFetchStartedAt = 0;
  let inFlight = null;

  const successBody = (success) => ({
    ok: true,
    fetchedAt: success.fetchedAt,
    stale: false,
    isAvailable: success.isAvailable,
    balances: success.balances,
    provider: success.provider,
    prices,
    ...ledgerView(Date.now()),
  });

  const errorBody = (error, stale) => {
    const body = {
      ok: false,
      code: isPlainObject(error) ? error.code : 'network',
      message: isPlainObject(error) ? error.message : 'balance unavailable',
      prices,
      ...ledgerView(Date.now()),
    };
    if (isPlainObject(error) && error.status !== undefined) body.status = error.status;
    if (stale !== null && stale !== undefined) {
      body.fetchedAt = stale.fetchedAt;
      body.stale = true;
      body.isAvailable = stale.isAvailable;
      body.balances = stale.balances;
      body.provider = stale.provider;
    }
    return body;
  };

  const cachedOrError = (now) => {
    if (lastSuccess !== null && now - lastSuccess.fetchedAt < cfg.cacheTtlMs) return successBody(lastSuccess);
    if (lastSuccess !== null && now - lastSuccess.fetchedAt <= cfg.staleMaxMs) return errorBody(lastError, lastSuccess);
    return errorBody(lastError, null);
  };

  const fail = (error) => {
    lastError = error;
    lastErrorAt = Date.now();
    const stale = lastSuccess !== null && lastErrorAt - lastSuccess.fetchedAt <= cfg.staleMaxMs
      ? lastSuccess
      : null;
    return errorBody(error, stale);
  };

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
        const timedOut = isPlainObject(error) && (error.name === 'TimeoutError' || error.name === 'AbortError');
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
      observeBalances(normalized.balances);
      return successBody(lastSuccess);
    } catch {
      return fail({ code: 'internal', message: 'balance lookup failed' });
    }
  };

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
        respond(res, 405, { ok: false, code: 'method-not-allowed', message: 'only GET is supported', prices }, { allow: 'GET' });
        return;
      }
      let force = false;
      try {
        force = new URL(String(req.url ?? '/'), 'http://localhost').searchParams.get('refresh') === '1';
      } catch {
        force = false;
      }
      if (ledgerAvailable) {
        // First hit kicks the day's backfill; never block the route for long.
        try {
          await Promise.race([ensureBackfill(), wait(BACKFILL_ROUTE_WAIT_MS)]);
        } catch {
          // Backfill failures are already reflected in `today.backfill`.
        }
      }
      respond(res, 200, await readBalance(force));
    } catch {
      try {
        respond(res, 200, { ok: false, code: 'internal', message: 'balance lookup failed', prices, ...ledgerView(Date.now()) });
      } catch {
        // The response is already gone.
      }
    }
  };

  ctx.effect(
    () => webServer.register({ kind: 'exact', path: cfg.routePath, handler }),
    `status-balance: GET ${cfg.routePath}`,
  );
}
