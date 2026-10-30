/**
 * dsh-status-balance — browser half (v3).
 *
 * Renders a compact pill in `conversation.composer.dock` (after the context
 * meter) with two unlabeled money amounts: this session's estimated spend and
 * the wallet balance. Clicking the pill opens a detail popover with today's
 * ledger, runway estimate, and the current peak/off-peak price slot.
 *
 * The wallet balance comes from the Host's same-origin route. Session spend is
 * derived reactively from the session projections and prices at the current
 * slot; the daily ledger numbers come from the Host's route payload.
 */
window.__ModuleLoader__.load({
  id: 'dsh-status-balance',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const Fragment = React.Fragment;

    // react-dom is part of the shipped client module table; degrade gracefully.
    let ReactDOM = null;
    try {
      ReactDOM = require('react-dom');
    } catch {
      ReactDOM = null;
    }

    const NS = 'statusBalance';
    const ROUTE = '/plugin/dsh-status-balance';
    /** Composer-dock order: the shipped stats use 0 and 1, so 100 renders last. */
    const DOCK_ORDER = 100;
    /** Visible-page poll interval for the wallet balance. */
    const POLL_MS = 60000;
    /** Focus/visibility refetch threshold, so quick tab flips stay cheap. */
    const FRESH_MS = 30000;
    /** Error backoff ladder; the last value repeats. */
    const ERROR_BACKOFF_MS = [30000, 60000, 120000];
    /** Client watchdog: never leave the balance request stuck forever. */
    const WATCHDOG_MS = 15000;
    const DAY_MS = 86400000;

    /** Mirrors the Host defaults; used when a payload carries no prices. */
    const FALLBACK_PRICES = {
      currency: 'CNY',
      symbol: '¥',
      perMillion: true,
      cacheWriteUsesInput: true,
      timezone: 'Asia/Shanghai',
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

    const zh = {
      balanceTitle: '账户余额',
      spendEstimate: '本会话消耗（估算）: {amount}',
      spendBreakdown: '输入 {input} · 缓存命中 {cacheHit}/{cacheInput} · 输出 {output}',
      spendPrices: '{symbol}{input}/1M 输入 · {symbol}{cacheHit}/1M 缓存 · {symbol}{output}/1M 输出',
      spendNote: '按当前时段价估算；DeepSeek 不返回单次请求成本',
      currentSlot: '当前时段',
      peak: '高峰价',
      offpeak: '谷时价',
      switchAt: '{time} 切换',
      balanceLine: '余额 {amount}',
      toppedUp: '充值余额',
      granted: '赠送余额',
      topupGranted: '充值 / 赠送',
      updated: '更新于 {time}',
      loading: '正在获取余额…',
      error: '余额获取失败',
      stale: '显示的是上次成功获取的余额',
      unavailable: '账户当前不可用',
      refreshHint: '点击刷新',
      todaySpend: '今日我的消耗',
      todayDecrease: '今日余额减少',
      todayDifferenceLabel: '今日差额（其他终端/密钥）',
      todayRecharge: '今日充值',
      daysLeft: '预计可用',
      daysApprox: '≈ {n} 天',
      over365: '>365 天',
      trendHistoryHint: '按近 {n} 日日均降幅 {amount}/天',
      trendTodayHint: '按今日日均降幅 {amount}/天',
      footerUpdated: '更新 {time}',
      footerSince: '数据自今日 00:00',
      'code.no-credential': '未配置 API Key',
      'code.upstream-status': '上游接口返回错误',
      'code.network': '网络请求失败',
      'code.parse': '上游响应无法解析',
      'code.internal': '余额服务内部错误',
      'code.method-not-allowed': '请求方法不支持',
      'code.invalid-response': '余额接口返回了无法识别的数据',
    };

    const en = {
      balanceTitle: 'Account balance',
      spendEstimate: 'Session spend (estimate): {amount}',
      spendBreakdown: 'Input {input} · cache hit {cacheHit}/{cacheInput} · output {output}',
      spendPrices: '{symbol}{input}/1M input · {symbol}{cacheHit}/1M cache · {symbol}{output}/1M output',
      spendNote: 'Estimated at the current slot price; DeepSeek does not return per-request cost',
      currentSlot: 'Current period',
      peak: 'Peak',
      offpeak: 'Off-peak',
      switchAt: 'switches at {time}',
      balanceLine: 'Balance {amount}',
      toppedUp: 'Topped up',
      granted: 'Granted',
      topupGranted: 'Topped up / Granted',
      updated: 'Updated {time}',
      loading: 'Fetching balance…',
      error: 'Balance unavailable',
      stale: 'Showing the last successful balance',
      unavailable: 'Account is currently unavailable',
      refreshHint: 'Click to refresh',
      todaySpend: 'My spend today',
      todayDecrease: 'Balance decrease today',
      todayDifferenceLabel: 'Difference today (other terminals/keys)',
      todayRecharge: 'Recharged today',
      daysLeft: 'Estimated runway',
      daysApprox: '≈ {n} days',
      over365: '>365 days',
      trendHistoryHint: 'Based on the last {n} days, avg {amount}/day',
      trendTodayHint: 'Based on today so far, avg {amount}/day',
      footerUpdated: 'Updated {time}',
      footerSince: 'Data since 00:00 today',
      'code.no-credential': 'API key is not configured',
      'code.upstream-status': 'The upstream API returned an error',
      'code.network': 'The network request failed',
      'code.parse': 'The upstream response could not be parsed',
      'code.internal': 'The balance service failed',
      'code.method-not-allowed': 'Unsupported request method',
      'code.invalid-response': 'The balance route returned an unexpected payload',
    };

    // --- generic helpers ----------------------------------------------------

    function isPlainObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function groupThousands(digits) {
      return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /** Parse a decimal string into sign + raw integer/fraction digits. */
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

    const digitAt = (fraction, index) => (index < fraction.length ? fraction.charAt(index) : '0');

    function isZero(value) {
      return value.integer === '0' && /^0*$/.test(value.fraction);
    }

    /** |value| < 0.01, compared by digits instead of floating point. */
    function isSubCent(value) {
      return value.integer === '0' && digitAt(value.fraction, 0) === '0' && digitAt(value.fraction, 1) === '0';
    }

    /** Currency prefix: ¥ for CNY, $ for USD, otherwise the code plus a space. */
    function currencyPrefix(currency) {
      const code = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
      if (code === 'CNY') return '¥';
      if (code === 'USD') return '$';
      return code === '' ? '' : `${code} `;
    }

    function fixedTwo(value, round) {
      const hundredths = Number(digitAt(value.fraction, 0)) * 10 + Number(digitAt(value.fraction, 1));
      const third = Number(digitAt(value.fraction, 2));
      let cents = BigInt(value.integer) * 100n + BigInt(hundredths);
      if (round && third >= 5) cents += 1n;
      const integer = (cents / 100n).toString();
      const fraction = (cents % 100n).toString().padStart(2, '0');
      return `${groupThousands(integer)}.${fraction}`;
    }

    /** Wallet amount, mirroring the shipped account settings formatter. */
    function formatBalance(raw, currency) {
      const prefix = currencyPrefix(currency);
      const value = parseDecimal(raw);
      if (value === null) return `${prefix}—`;
      if (isZero(value)) return `${prefix}0.00`;
      if (value.negative) {
        const magnitude = isSubCent(value) ? '0.01' : fixedTwo(value, true);
        return `-${prefix}${magnitude}`;
      }
      if (isSubCent(value)) return `<${prefix}0.01`;
      return `${prefix}${fixedTwo(value, false)}`;
    }

    /** Format one Host decimal string (already 0.0001-unit rounded) as money. */
    function formatMoneyText(text, symbol) {
      if (typeof text !== 'string' || text.length === 0) return '—';
      const value = parseDecimal(text);
      if (value === null) return '—';
      let fraction = value.fraction;
      if (fraction.length < 2) fraction = fraction.padEnd(2, '0');
      if (fraction.length > 4) fraction = fraction.slice(0, 4);
      return `${value.negative ? '-' : ''}${symbol}${groupThousands(value.integer)}.${fraction}`;
    }

    function formatTime(ms) {
      try {
        return new Date(ms).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
      } catch {
        return String(ms);
      }
    }

    function formatSlotTime(ms, timeZone) {
      try {
        return new Intl.DateTimeFormat(undefined, {
          timeZone,
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(new Date(ms));
      } catch {
        return formatTime(ms).slice(0, 5);
      }
    }

    function formatPrice(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '0';
      return String(Number(value.toFixed(4)));
    }

    const formatCount = (value) => groupThousands(String(Math.max(0, Math.round(Number(value) || 0))));

    /** Localized reason for a host error code, falling back to its message. */
    function errorText(error, t) {
      if (error === null || typeof error !== 'object') return t('error');
      const key = `code.${error.code}`;
      const mapped = t(key);
      if (mapped !== key) return mapped;
      if (typeof error.message === 'string' && error.message.length > 0) return error.message;
      return t('error');
    }

    // --- price table / peak slots -----------------------------------------

    function slotRow(value, fallback) {
      const row = isPlainObject(value) ? value : {};
      const base = isPlainObject(fallback) ? fallback : {};
      const num = (candidate, fallbackValue) => (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
        ? candidate
        : fallbackValue);
      const result = {
        input: num(row.input, num(base.input, 0)),
        cacheHit: num(row.cacheHit, num(base.cacheHit, 0)),
        output: num(row.output, num(base.output, 0)),
      };
      if (row.cacheWrite !== undefined || base.cacheWrite !== undefined) {
        result.cacheWrite = num(row.cacheWrite, num(base.cacheWrite, 0));
      }
      return result;
    }

    function normalizePriceRow(value, fallback) {
      const row = isPlainObject(value) ? value : {};
      const base = isPlainObject(fallback) ? fallback : FALLBACK_PRICES.default;
      const hasSlots = isPlainObject(row.off) || isPlainObject(row.peak);
      if (hasSlots) {
        return { off: slotRow(row.off, base.off), peak: slotRow(row.peak, base.peak) };
      }
      return { off: slotRow(row, base.off), peak: slotRow(row, base.peak) };
    }

    function normalizePeakWindows(value) {
      if (!Array.isArray(value)) return FALLBACK_PRICES.peakWindows.map((window) => [...window]);
      const windows = [];
      for (const window of value) {
        if (!Array.isArray(window) || window.length !== 2) continue;
        const start = Number(window[0]);
        const end = Number(window[1]);
        if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= 24 && start < end) {
          windows.push([start, end]);
        }
      }
      return windows.length > 0 ? windows : FALLBACK_PRICES.peakWindows.map((window) => [...window]);
    }

    function validTimeZone(timeZone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
        return timeZone;
      } catch {
        return FALLBACK_PRICES.timezone;
      }
    }

    function normalizePrices(raw) {
      const source = isPlainObject(raw) ? raw : FALLBACK_PRICES;
      const sourceModels = isPlainObject(source.models) ? source.models : {};
      const models = {};
      for (const [model, row] of Object.entries(FALLBACK_PRICES.models)) {
        models[model] = normalizePriceRow(sourceModels[model], row);
      }
      for (const [model, row] of Object.entries(sourceModels)) {
        if (Object.prototype.hasOwnProperty.call(models, model)) continue;
        models[model] = normalizePriceRow(row, FALLBACK_PRICES.default);
      }
      return {
        currency: typeof source.currency === 'string' && source.currency.length > 0 ? source.currency : FALLBACK_PRICES.currency,
        symbol: typeof source.symbol === 'string' ? source.symbol : FALLBACK_PRICES.symbol,
        perMillion: source.perMillion !== false,
        cacheWriteUsesInput: source.cacheWriteUsesInput !== false,
        timezone: validTimeZone(typeof source.timezone === 'string' ? source.timezone : FALLBACK_PRICES.timezone),
        peakWindows: normalizePeakWindows(source.peakWindows),
        weekendOffPeak: source.weekendOffPeak !== false,
        models,
        default: normalizePriceRow(source.default, FALLBACK_PRICES.default),
      };
    }

    function pickPrice(prices, model, slot) {
      const row = model.length > 0 && Object.prototype.hasOwnProperty.call(prices.models, model)
        ? prices.models[model]
        : prices.default;
      const key = slot === 'peak' ? 'peak' : 'off';
      return row[key] ?? prices.default[key];
    }

    // --- time zone slots ---------------------------------------------------

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
        weekday: values.weekday,
      };
    }

    function zoneOffset(ms, timeZone) {
      const parts = dateParts(ms, timeZone);
      const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, 0, 0);
      return asUTC - Math.floor(ms / 3600000) * 3600000;
    }

    function localEpoch(year, month, day, hour, timeZone) {
      const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
      const offset = zoneOffset(guess, timeZone);
      let epoch = guess - offset;
      const refined = zoneOffset(epoch, timeZone);
      if (refined !== offset) epoch = guess - refined;
      return epoch;
    }

    function addDays(year, month, day, offset) {
      const date = new Date(Date.UTC(year, month - 1, day + offset));
      return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
    }

    function slotAt(ms, prices) {
      const parts = dateParts(ms, prices.timezone);
      const weekend = parts.weekday === 'Sat' || parts.weekday === 'Sun';
      if (weekend && prices.weekendOffPeak) return 'offpeak';
      for (const window of prices.peakWindows) {
        if (parts.hour >= window[0] && parts.hour < window[1]) return 'peak';
      }
      return 'offpeak';
    }

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

    // --- spend estimation --------------------------------------------------

    function readUsage(usage) {
      if (!isPlainObject(usage)) return null;
      const buckets = isPlainObject(usage.totals) ? usage.totals : usage;
      const count = (...keys) => {
        for (const key of keys) {
          const value = buckets[key];
          if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value);
        }
        return 0;
      };
      return {
        uncachedInput: count('uncachedInputTokens', 'uncachedInput', 'inputTokens'),
        cacheRead: count('cacheReadTokens', 'cacheRead'),
        cacheWrite: count('cacheWriteTokens', 'cacheWrite'),
        output: count('outputTokens', 'output'),
      };
    }

    function readModel(selection) {
      if (!isPlainObject(selection)) return '';
      const next = selection.next;
      if (isPlainObject(next) && typeof next.model === 'string' && next.model.length > 0) return next.model;
      const last = selection.lastUsed;
      if (isPlainObject(last) && typeof last.model === 'string' && last.model.length > 0) return last.model;
      return typeof selection.model === 'string' ? selection.model : '';
    }

    function priceNano(price) {
      const value = typeof price === 'number' && Number.isFinite(price) && price >= 0 ? price : 0;
      return BigInt(Math.round(value * 1e9));
    }

    function computeSpendUnits(buckets, price, prices) {
      const writePrice = prices.cacheWriteUsesInput
        ? price.input
        : (Number.isFinite(price.cacheWrite) ? price.cacheWrite : price.input);
      const terms = [
        [buckets.uncachedInput, price.input],
        [buckets.cacheRead, price.cacheHit],
        [buckets.cacheWrite, writePrice],
        [buckets.output, price.output],
      ];
      let numerator = 0n;
      for (const [tokens, unitPrice] of terms) {
        numerator += BigInt(tokens) * priceNano(unitPrice);
      }
      return (numerator + 50000000000n) / 100000000000n;
    }

    function formatSpend(units, symbol) {
      if (units <= 0n) return `${symbol}0.00`;
      const integer = units / 10000n;
      let fraction = (units % 10000n).toString().padStart(4, '0');
      if (units >= 100n) {
        while (fraction.length > 2 && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
      }
      return `${symbol}${groupThousands(integer.toString())}.${fraction}`;
    }

    function pageVisible() {
      return typeof document === 'undefined' || document.visibilityState === 'visible';
    }

    function translateFallback(key, params) {
      const template = Object.prototype.hasOwnProperty.call(en, key) ? en[key] : key;
      if (params === null || params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }

    function localized(seat, key, params) {
      if (typeof seat === 'function') {
        const value = seat(key, params);
        if (typeof value === 'string' && value !== key) return value;
      }
      return translateFallback(key, params);
    }

    const backoffDelay = (count) => ERROR_BACKOFF_MS[Math.min(Math.max(count, 1), ERROR_BACKOFF_MS.length) - 1];

    // --- icons --------------------------------------------------------------

    function SpendIcon() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        'aria-hidden': 'true',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style: { flex: 'none', display: 'block' },
      },
        h('path', { d: 'M9 2.5h4.5V7' }),
        h('path', { d: 'M13.5 2.5 8.5 7.5' }),
        h('path', { d: 'M12.5 9.5v2.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5v-7A1.5 1.5 0 0 1 4 3.5h2.5' }),
      );
    }

    function WalletIcon() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        'aria-hidden': 'true',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style: { flex: 'none', display: 'block' },
      },
        h('rect', { x: 1.5, y: 3.5, width: 13, height: 9, rx: 2 }),
        h('path', { d: 'M1.5 6.5h6.5' }),
        h('circle', { cx: 11.5, cy: 9.5, r: 1, fill: 'currentColor', stroke: 'none' }),
      );
    }

    // --- tooltip / popover content -----------------------------------------

    function slotText(t, state, until, timeZone) {
      const label = t(state === 'peak' ? 'peak' : 'offpeak');
      if (typeof until !== 'number' || !Number.isFinite(until)) return label;
      return `${label}（${t('switchAt', { time: formatSlotTime(until, timeZone) })}）`;
    }

    function buildTitle(snapshot, t, view) {
      const lines = [`${t('spendEstimate', { amount: view.spendText })}`];
      if (view.buckets !== null) {
        const cacheInput = view.buckets.uncachedInput + view.buckets.cacheRead + view.buckets.cacheWrite;
        lines.push(t('spendBreakdown', {
          input: formatCount(view.buckets.uncachedInput),
          cacheHit: formatCount(view.buckets.cacheRead),
          cacheInput: formatCount(cacheInput),
          output: formatCount(view.buckets.output),
        }));
      }
      lines.push(t('spendPrices', {
        symbol: view.symbol,
        input: formatPrice(view.price.input),
        cacheHit: formatPrice(view.price.cacheHit),
        output: formatPrice(view.price.output),
      }));
      lines.push(`${t('currentSlot')}: ${slotText(t, view.slot, view.until, view.prices.timezone)}`);
      lines.push(t('spendNote'));
      lines.push('');

      if (snapshot.phase === 'loading') {
        lines.push(t('loading'));
      } else {
        lines.push(t('balanceLine', { amount: view.balanceText }));
        if (view.balances.length > 0) {
          lines.push(`${t('toppedUp')} ${view.toppedUpText} · ${t('granted')} ${view.grantedText}`);
          if (typeof snapshot.fetchedAt === 'number' && snapshot.fetchedAt > 0) {
            lines.push(t('updated', { time: formatTime(snapshot.fetchedAt) }));
          }
        }
        if (snapshot.isAvailable === false) lines.push(t('unavailable'));
        if (snapshot.phase === 'stale') lines.push(t('stale'));
        if (snapshot.error !== null && snapshot.error !== undefined) {
          lines.push(`${t('error')}: ${errorText(snapshot.error, t)}`);
        }
      }
      lines.push(t('refreshHint'));
      return lines.join('\n');
    }

    const PANEL_RULE = {
      borderTop: '0.5px solid var(--dsw-alias-border-l2)',
    };

    function buildPanel(view) {
      const {
        t, snapshot, prices, slot, until, symbol, balances, balanceText,
        toppedUpText, grantedText, panelRef,
      } = view;
      const rows = [];
      const pushRow = (label, value, hint) => {
        rows.push(h('dt', {
          title: hint,
          style: { color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
        }, label));
        rows.push(h('dd', {
          style: {
            color: 'var(--dsw-alias-label-secondary)',
            margin: 0,
            fontVariantNumeric: 'tabular-nums',
            textAlign: 'right',
          },
        }, value));
      };

      const today = isPlainObject(snapshot.today) ? snapshot.today : null;
      const trend = isPlainObject(snapshot.trend) ? snapshot.trend : null;

      const topupNonZero = balances.some((wallet) => {
        const value = parseDecimal(wallet?.toppedUp);
        return value !== null && !isZero(value);
      });
      const grantedNonZero = balances.some((wallet) => {
        const value = parseDecimal(wallet?.granted);
        return value !== null && !isZero(value);
      });
      if (topupNonZero || grantedNonZero) {
        if (topupNonZero && grantedNonZero) {
          pushRow(t('topupGranted'), `${toppedUpText} · ${grantedText}`);
        } else if (topupNonZero) {
          pushRow(t('toppedUp'), toppedUpText);
        } else {
          pushRow(t('granted'), grantedText);
        }
      }

      pushRow(t('todaySpend'), today === null ? '—' : formatMoneyText(today.mySpend, symbol));
      pushRow(t('todayDecrease'), today === null ? '—' : formatMoneyText(today.balanceDecrease, symbol));
      if (today !== null && typeof today.difference === 'string' && Number(today.difference) > 0.01) {
        pushRow(t('todayDifferenceLabel'), formatMoneyText(today.difference, symbol));
      }
      if (today !== null && typeof today.balanceIncrease === 'string' && Number(today.balanceIncrease) > 0) {
        pushRow(t('todayRecharge'), `+${formatMoneyText(today.balanceIncrease, symbol)}`);
      }

      const daysLeft = trend !== null && typeof trend.daysLeft === 'number' && Number.isFinite(trend.daysLeft)
        ? trend.daysLeft
        : null;
      const daysText = daysLeft === null
        ? '—'
        : daysLeft > 365
          ? t('over365')
          : t('daysApprox', { n: Math.max(0, daysLeft) });
      const average = trend !== null && typeof trend.avgDailyDecrease === 'string'
        ? formatMoneyText(trend.avgDailyDecrease, symbol)
        : null;
      let trendHint;
      if (trend !== null && trend.basis === 'history' && average !== null) {
        const days = Array.isArray(trend.days)
          ? trend.days.filter((entry) => typeof entry?.decrease === 'string' && Number(entry.decrease) > 0).length
          : 0;
        trendHint = t('trendHistoryHint', { n: Math.max(1, days), amount: average });
      } else if (trend !== null && trend.basis === 'today' && average !== null) {
        trendHint = t('trendTodayHint', { amount: average });
      }
      pushRow(t('daysLeft'), daysText, trendHint);
      pushRow(t('currentSlot'), slotText(t, slot, until, prices.timezone));

      const updated = typeof snapshot.fetchedAt === 'number' && snapshot.fetchedAt > 0
        ? formatTime(snapshot.fetchedAt)
        : '—';
      const footerLines = [];
      if (snapshot.error !== null && snapshot.error !== undefined) {
        footerLines.push(`${t('error')}: ${errorText(snapshot.error, t)}`);
      }
      footerLines.push(`${t('footerUpdated', { time: updated })} · ${t('footerSince')} · ${t('refreshHint')}`);

      const panelStyle = {
        position: 'fixed',
        zIndex: 1100,
        boxSizing: 'border-box',
        borderRadius: 'var(--dsw-radius-lg)',
        background: 'var(--dsw-specific-menu)',
        width: 'max-content',
        minWidth: 'min(300px, 100vw - 24px)',
        maxWidth: 'min(440px, 100vw - 24px)',
        backdropFilter: 'var(--dsw-menu-backdrop-filter)',
        '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
        boxShadow: 'var(--dsw-elevation-prominent)',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'default',
        padding: 16,
        fontSize: 12,
        lineHeight: '18px',
        ...(view.pos === null
          ? { left: 0, top: 0, visibility: 'hidden' }
          : { left: view.pos.left, top: view.pos.top }),
      };

      return h('div', {
        ref: panelRef,
        role: 'dialog',
        'aria-label': t('balanceTitle'),
        'data-dsh-balance-popover': true,
        style: panelStyle,
      },
        h('div', {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            gap: 16,
            marginBottom: 8,
            fontWeight: 500,
            color: 'var(--dsw-alias-label-primary)',
          },
        },
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, h(WalletIcon), t('balanceTitle')),
          h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, balanceText),
        ),
        h('div', { style: { ...PANEL_RULE, marginBottom: 10 } }),
        h('dl', {
          style: {
            display: 'grid',
            gridTemplateColumns: 'minmax(96px,auto) minmax(0,1fr)',
            gap: '6px 16px',
            margin: 0,
            color: 'var(--dsw-alias-label-tertiary)',
          },
        }, rows),
        h('div', { style: { ...PANEL_RULE, margin: '10px 0 8px' } }),
        h('div', {
          style: {
            fontSize: 11,
            lineHeight: '16px',
            color: 'var(--dsw-alias-label-tertiary)',
          },
        }, footerLines.map((line, index) => h('div', { key: index }, line))),
      );
    }

    // --- component ----------------------------------------------------------

    function BalancePill(props) {
      const seat = props.t;
      const t = (key, params) => localized(seat, key, params);

      const useProjection = props.useProjection;
      const usage = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined;
      const selection = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined;

      const [open, setOpen] = React.useState(false);
      const [hover, setHover] = React.useState(false);
      const [snapshot, setSnapshot] = React.useState({ phase: 'loading' });
      const [pos, setPos] = React.useState(null);
      const anchorRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const clickRef = React.useRef(null);
      const useLayoutEffect = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect;

      React.useEffect(() => {
        let disposed = false;
        let timer = 0;
        let watchdog = 0;
        let controller = null;
        let busy = false;
        let failures = 0;
        let refreshQueued = false;
        let lastSuccess = null;
        let lastPrices = null;
        let lastLedger = { today: null, trend: null, slot: null };

        const clearTimer = () => {
          if (timer !== 0) {
            window.clearTimeout(timer);
            timer = 0;
          }
        };

        const schedule = (delay) => {
          clearTimer();
          if (disposed || !pageVisible()) return;
          timer = window.setTimeout(() => {
            timer = 0;
            void load(false);
          }, delay);
        };

        const staleSnapshot = (error) => {
          if (lastSuccess !== null) {
            return {
              phase: 'stale',
              fetchedAt: lastSuccess.fetchedAt,
              isAvailable: lastSuccess.isAvailable,
              balances: lastSuccess.balances,
              provider: lastSuccess.provider,
              prices: lastPrices,
              ...lastLedger,
              error,
            };
          }
          return { phase: 'error', prices: lastPrices, ...lastLedger, error };
        };

        const applyPayload = (payload) => {
          if (isPlainObject(payload)) {
            if (isPlainObject(payload.prices)) lastPrices = payload.prices;
            lastLedger = {
              today: isPlainObject(payload.today) ? payload.today : lastLedger.today,
              trend: isPlainObject(payload.trend) ? payload.trend : lastLedger.trend,
              slot: isPlainObject(payload.slot) ? payload.slot : lastLedger.slot,
            };
          }
          if (isPlainObject(payload) && payload.ok === true && Array.isArray(payload.balances)) {
            const success = {
              fetchedAt: typeof payload.fetchedAt === 'number' ? payload.fetchedAt : Date.now(),
              isAvailable: payload.isAvailable === true,
              balances: payload.balances,
              provider: typeof payload.provider === 'string' ? payload.provider : '',
            };
            lastSuccess = success;
            failures = 0;
            setSnapshot({ phase: 'ready', ...success, prices: lastPrices, ...lastLedger, error: null });
            return true;
          }

          failures += 1;
          const isErrorBody = isPlainObject(payload) && payload.ok === false;
          const error = {
            code: isErrorBody && typeof payload.code === 'string' ? payload.code : 'invalid-response',
            message: isErrorBody && typeof payload.message === 'string'
              ? payload.message
              : 'balance route returned an unexpected payload',
          };
          if (isErrorBody && Array.isArray(payload.balances) && payload.balances.length > 0) {
            lastSuccess = {
              fetchedAt: typeof payload.fetchedAt === 'number'
                ? payload.fetchedAt
                : (lastSuccess !== null ? lastSuccess.fetchedAt : null),
              isAvailable: payload.isAvailable !== false,
              balances: payload.balances,
              provider: typeof payload.provider === 'string'
                ? payload.provider
                : (lastSuccess !== null ? lastSuccess.provider : ''),
            };
          }
          setSnapshot(staleSnapshot(error));
          return false;
        };

        const load = async (force) => {
          if (disposed || busy) return;
          busy = true;
          clearTimer();

          controller = typeof AbortController === 'function' ? new AbortController() : null;
          watchdog = window.setTimeout(() => {
            if (controller !== null) {
              try {
                controller.abort();
              } catch {
                // Already settled.
              }
            }
          }, WATCHDOG_MS);

          try {
            const response = await fetch(force ? `${ROUTE}?refresh=1` : ROUTE, {
              method: 'GET',
              cache: 'no-store',
              headers: { accept: 'application/json' },
              signal: controller === null ? undefined : controller.signal,
            });
            if (disposed) return;
            let payload = null;
            try {
              payload = await response.json();
            } catch {
              payload = null;
            }
            if (disposed) return;
            const ok = applyPayload(payload);
            schedule(ok ? POLL_MS : backoffDelay(failures));
          } catch (error) {
            if (disposed) return;
            failures += 1;
            const aborted = isPlainObject(error) && (error.name === 'AbortError' || error.name === 'TimeoutError');
            setSnapshot(staleSnapshot({
              code: 'network',
              message: aborted ? 'balance request timed out' : 'balance request failed',
            }));
            schedule(backoffDelay(failures));
          } finally {
            if (watchdog !== 0) {
              window.clearTimeout(watchdog);
              watchdog = 0;
            }
            busy = false;
            controller = null;
            if (refreshQueued && !disposed) {
              refreshQueued = false;
              void load(true);
            }
          }
        };

        const needsRefresh = () => lastSuccess === null
          || typeof lastSuccess.fetchedAt !== 'number'
          || Date.now() - lastSuccess.fetchedAt > FRESH_MS;

        const onVisibilityChange = () => {
          if (disposed) return;
          if (!pageVisible()) {
            clearTimer();
            return;
          }
          if (needsRefresh()) void load(false);
          else schedule(POLL_MS);
        };

        const onFocus = () => {
          if (disposed || !pageVisible()) return;
          if (needsRefresh()) void load(false);
        };

        clickRef.current = () => {
          if (disposed) return;
          if (busy) {
            refreshQueued = true;
            return;
          }
          void load(true);
        };

        window.addEventListener('focus', onFocus);
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', onVisibilityChange);
        }

        void load(false);

        return () => {
          disposed = true;
          clearTimer();
          if (watchdog !== 0) {
            window.clearTimeout(watchdog);
            watchdog = 0;
          }
          if (controller !== null) {
            try {
              controller.abort();
            } catch {
              // Already settled.
            }
            controller = null;
          }
          clickRef.current = null;
          window.removeEventListener('focus', onFocus);
          if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onVisibilityChange);
          }
        };
      }, []);

      // Dismiss the popover on Escape or an outside pointerdown/click.
      React.useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined;
        const closeOutside = (event) => {
          const target = event?.target;
          if (panelRef.current !== null && typeof panelRef.current?.contains === 'function' && panelRef.current.contains(target)) return;
          if (anchorRef.current !== null && typeof anchorRef.current?.contains === 'function' && anchorRef.current.contains(target)) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event?.key !== 'Escape') return;
          setOpen(false);
          if (anchorRef.current !== null && typeof anchorRef.current?.focus === 'function') anchorRef.current.focus();
        };
        document.addEventListener('pointerdown', closeOutside, true);
        document.addEventListener('click', closeOutside, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('pointerdown', closeOutside, true);
          document.removeEventListener('click', closeOutside, true);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      // Measure the anchor and panel, then place the panel above it (below when
      // the viewport has no room above). Re-measure on resize/scroll.
      useLayoutEffect(() => {
        if (!open || typeof window === 'undefined') return undefined;
        const measure = () => {
          const anchor = anchorRef.current;
          const panel = panelRef.current;
          if (anchor === null || panel === null) return;
          if (typeof anchor.getBoundingClientRect !== 'function' || typeof panel.getBoundingClientRect !== 'function') return;
          const rect = anchor.getBoundingClientRect();
          const panelRect = panel.getBoundingClientRect();
          const width = panelRect.width || panel.offsetWidth || 0;
          const height = panelRect.height || panel.offsetHeight || 0;
          if (width <= 0 || height <= 0) return;
          const viewportWidth = window.innerWidth || 0;
          const margin = 12;
          const gap = 8;
          const left = Math.max(margin, Math.min(rect.right - width, viewportWidth - margin - width));
          let top = rect.top - gap - height;
          if (top < margin) top = rect.bottom + gap;
          setPos((previous) => (previous !== null && previous.left === left && previous.top === top
            ? previous
            : { left, top }));
        };
        measure();
        window.addEventListener('resize', measure);
        window.addEventListener('scroll', measure, true);
        return () => {
          window.removeEventListener('resize', measure);
          window.removeEventListener('scroll', measure, true);
        };
      }, [open, snapshot]);

      const fire = () => {
        if (typeof clickRef.current === 'function') {
          try {
            clickRef.current();
          } catch {
            // A refresh click must never surface as a render error.
          }
        }
      };

      const balances = Array.isArray(snapshot.balances) ? snapshot.balances : [];
      const balanceText = balances.length > 0
        ? balances.map((wallet) => formatBalance(wallet && wallet.total, wallet && wallet.currency)).join(' / ')
        : '—';
      const toppedUpText = balances
        .map((wallet) => formatBalance(wallet && wallet.toppedUp, wallet && wallet.currency))
        .join(' / ');
      const grantedText = balances
        .map((wallet) => formatBalance(wallet && wallet.granted, wallet && wallet.currency))
        .join(' / ');

      const prices = normalizePrices(snapshot.prices);
      const symbol = prices.symbol.length > 0 ? prices.symbol : currencyPrefix(prices.currency);
      const now = Date.now();
      const slot = slotAt(now, prices);
      const routeUntil = isPlainObject(snapshot.slot) && typeof snapshot.slot.until === 'number'
        ? snapshot.slot.until
        : null;
      const until = routeUntil !== null && routeUntil > now ? routeUntil : nextSlotBoundary(now, prices);

      const buckets = readUsage(usage);
      const price = pickPrice(prices, readModel(selection), slot);
      const spendText = buckets === null ? '—' : formatSpend(computeSpendUnits(buckets, price, prices), symbol);
      const title = buildTitle(snapshot, t, {
        spendText,
        buckets,
        price,
        prices,
        slot,
        until,
        symbol,
        balanceText,
        toppedUpText,
        grantedText,
        balances,
      });

      const triggerStyle = {
        order: DOCK_ORDER,
        flex: 'none',
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 22,
        margin: 0,
        padding: '0 6px',
        border: 'none',
        borderRadius: 6,
        fontSize: 12,
        lineHeight: '20px',
        fontFamily: 'inherit',
        fontWeight: 'inherit',
        textAlign: 'inherit',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        userSelect: 'none',
      };

      const trigger = h('button', {
        ref: anchorRef,
        type: 'button',
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-label': title,
        title,
        onClick: () => {
          if (!open) {
            setOpen(true);
            fire();
          } else {
            setOpen(false);
          }
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onFocus: () => setHover(true),
        onBlur: () => setHover(false),
        style: triggerStyle,
      },
        h(SpendIcon),
        h('span', null, spendText),
        h('span', {
          'aria-hidden': 'true',
          style: { color: 'var(--dsw-alias-label-tertiary)', flex: 'none' },
        }, '·'),
        h(WalletIcon),
        h('span', null, balanceText),
      );

      const panel = open
        ? buildPanel({
          t,
          snapshot,
          prices,
          slot,
          until,
          symbol,
          balances,
          balanceText,
          toppedUpText,
          grantedText,
          panelRef,
          pos,
        })
        : null;

      let overlay = null;
      if (panel !== null) {
        overlay = ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
          ? ReactDOM.createPortal(panel, document.body)
          : panel;
      }

      return h(Fragment, null, trigger, overlay);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Isolate the two registrations: a dictionary problem must not hide
        // the pill, and a slot problem must not break locale.
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'status-balance: dictionaries');
        } catch {
          // The component falls back to its bundled English dictionary.
        }
        try {
          ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'balance',
            order: DOCK_ORDER,
            locale: NS,
          }, BalancePill));
        } catch {
          // Registration failure must not take the composer down with it.
        }
      },
    };
  },
});
