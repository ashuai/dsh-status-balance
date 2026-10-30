/**
 * dsh-status-balance — browser half.
 *
 * Renders a compact pill in `conversation.composer.dock`, after the context
 * meter: two unlabeled money amounts (this session's estimated spend and the
 * wallet balance), each identified only by a small icon. The wallet balance
 * comes from the Host's same-origin route; spend is derived reactively from
 * the session projections and the Host-provided list-price table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-status-balance',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

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

    /** Mirrors the Host defaults; used only when a payload carries no prices. */
    const FALLBACK_PRICES = {
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

    const zh = {
      spendEstimate: '本会话消耗（估算）: {amount}',
      spendBreakdown: '输入 {input} · 缓存命中 {cacheHit}/{cacheInput} · 输出 {output}',
      spendPrices: '{symbol}{input}/1M 输入 · {symbol}{cacheHit}/1M 缓存 · {symbol}{output}/1M 输出',
      spendNote: '按列表价格估算；DeepSeek 不返回单次请求成本',
      balanceLine: '余额 {amount}',
      topupShort: '充值',
      grantedShort: '赠送',
      updated: '更新于 {time}',
      loading: '正在获取余额…',
      error: '余额获取失败',
      stale: '显示的是上次成功获取的余额',
      unavailable: '账户当前不可用',
      refreshHint: '点击刷新',
      'code.no-credential': '未配置 API Key',
      'code.upstream-status': '上游接口返回错误',
      'code.network': '网络请求失败',
      'code.parse': '上游响应无法解析',
      'code.internal': '余额服务内部错误',
      'code.method-not-allowed': '请求方法不支持',
      'code.invalid-response': '余额接口返回了无法识别的数据',
    };

    const en = {
      spendEstimate: 'Session spend (estimate): {amount}',
      spendBreakdown: 'Input {input} · cache hit {cacheHit}/{cacheInput} · output {output}',
      spendPrices: '{symbol}{input}/1M input · {symbol}{cacheHit}/1M cache · {symbol}{output}/1M output',
      spendNote: 'Estimated from list prices; DeepSeek does not return per-request cost',
      balanceLine: 'Balance {amount}',
      topupShort: 'Topped up',
      grantedShort: 'Granted',
      updated: 'Updated {time}',
      loading: 'Fetching balance…',
      error: 'Balance unavailable',
      stale: 'Showing the last successful balance',
      unavailable: 'Account is currently unavailable',
      refreshHint: 'Click to refresh',
      'code.no-credential': 'API key is not configured',
      'code.upstream-status': 'The upstream API returned an error',
      'code.network': 'The network request failed',
      'code.parse': 'The upstream response could not be parsed',
      'code.internal': 'The balance service failed',
      'code.method-not-allowed': 'Unsupported request method',
      'code.invalid-response': 'The balance route returned an unexpected payload',
    };

    // --- wallet formatting (mirrors the shipped account settings UI) ---

    /** Currency prefix: ¥ for CNY, $ for USD, otherwise the code plus a space. */
    function currencyPrefix(currency) {
      const code = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
      if (code === 'CNY') return '¥';
      if (code === 'USD') return '$';
      return code === '' ? '' : `${code} `;
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

    function groupThousands(digits) {
      return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /**
     * Two fraction digits. `round` performs half-up on the third digit;
     * otherwise the value truncates (ROUND_DOWN), matching the shipped UI's
     * positive-balance rule.
     */
    function fixedTwo(value, round) {
      const hundredths = Number(digitAt(value.fraction, 0)) * 10 + Number(digitAt(value.fraction, 1));
      const third = Number(digitAt(value.fraction, 2));
      let cents = BigInt(value.integer) * 100n + BigInt(hundredths);
      if (round && third >= 5) cents += 1n;
      const integer = (cents / 100n).toString();
      const fraction = (cents % 100n).toString().padStart(2, '0');
      return `${groupThousands(integer)}.${fraction}`;
    }

    /**
     * Format one wallet amount with the account UI's display rules:
     * grouped thousands and 2 decimals, `<¥0.01` for a positive sub-cent,
     * a clamped `¥0.01` magnitude for a tiny negative, and `¥0.00` for zero.
     */
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

    /** Localized reason for a host error code, falling back to its message. */
    function errorText(error, t) {
      if (error === null || typeof error !== 'object') return t('error');
      const key = `code.${error.code}`;
      const mapped = t(key);
      if (mapped !== key) return mapped;
      if (typeof error.message === 'string' && error.message.length > 0) return error.message;
      return t('error');
    }

    // --- spend estimation ---

    function normalizePriceRow(value, fallback) {
      const row = value !== null && typeof value === 'object' ? value : {};
      const base = fallback !== null && typeof fallback === 'object' ? fallback : {};
      const num = (candidate, fallbackValue) => (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
        ? candidate
        : fallbackValue);
      return {
        input: num(row.input, num(base.input, 0)),
        cacheHit: num(row.cacheHit, num(base.cacheHit, 0)),
        output: num(row.output, num(base.output, 0)),
        cacheWrite: num(row.cacheWrite, num(base.cacheWrite, 0)),
      };
    }

    /** Fold the Host price table over the bundled fallback; never throws. */
    function normalizePrices(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : FALLBACK_PRICES;
      const sourceModels = source.models !== null && typeof source.models === 'object' ? source.models : {};
      const models = {};
      for (const [name, row] of Object.entries(FALLBACK_PRICES.models)) {
        models[name] = normalizePriceRow(sourceModels[name], row);
      }
      for (const [name, row] of Object.entries(sourceModels)) {
        if (Object.prototype.hasOwnProperty.call(models, name)) continue;
        models[name] = normalizePriceRow(row, FALLBACK_PRICES.default);
      }
      return {
        currency: typeof source.currency === 'string' && source.currency.length > 0 ? source.currency : FALLBACK_PRICES.currency,
        symbol: typeof source.symbol === 'string' ? source.symbol : FALLBACK_PRICES.symbol,
        perMillion: source.perMillion !== false,
        cacheWriteUsesInput: source.cacheWriteUsesInput !== false,
        models,
        default: normalizePriceRow(source.default, FALLBACK_PRICES.default),
      };
    }

    function pickPrice(prices, model) {
      if (model.length > 0 && Object.prototype.hasOwnProperty.call(prices.models, model)) return prices.models[model];
      return prices.default;
    }

    /** One token bucket shape, supporting both wire (`totals`) and flat forms. */
    function readUsage(usage) {
      if (usage === null || typeof usage !== 'object') return null;
      const buckets = usage.totals !== null && typeof usage.totals === 'object' ? usage.totals : usage;
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
      if (selection === null || typeof selection !== 'object') return '';
      const next = selection.next;
      if (next !== null && typeof next === 'object' && typeof next.model === 'string' && next.model.length > 0) {
        return next.model;
      }
      const last = selection.lastUsed;
      if (last !== null && typeof last === 'object' && typeof last.model === 'string' && last.model.length > 0) {
        return last.model;
      }
      return typeof selection.model === 'string' ? selection.model : '';
    }

    /** Price in nano-yuan per 1M tokens; integer math keeps estimates exact. */
    function priceNano(price) {
      const value = typeof price === 'number' && Number.isFinite(price) && price >= 0 ? price : 0;
      return BigInt(Math.round(value * 1e9));
    }

    /**
     * Estimated spend in units of ¥0.0001, from list prices:
     * (uncached*input + cacheRead*cacheHit + cacheWrite*write + output*output) / 1M.
     */
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
      // numerator is nano-yuan * 1M; dividing by 1e11 yields 0.0001-yuan units.
      return (numerator + 50000000000n) / 100000000000n;
    }

    /**
     * Spend display: zero `¥0.00`; a sub-cent positive amount keeps four
     * decimals; larger amounts keep two, plus any meaningful extra decimals
     * (so 9.025 stays 9.025 rather than rounding the estimate away).
     */
    function formatSpend(units, symbol) {
      if (units <= 0n) return `${symbol}0.00`;
      const integer = units / 10000n;
      let fraction = (units % 10000n).toString().padStart(4, '0');
      if (units >= 100n) {
        while (fraction.length > 2 && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
      }
      return `${symbol}${groupThousands(integer.toString())}.${fraction}`;
    }

    function formatPrice(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '0';
      return String(Number(value.toFixed(4)));
    }

    const formatCount = (value) => groupThousands(String(Math.max(0, Math.round(Number(value) || 0))));

    /**
     * Tooltip and accessible label: spend estimate + token breakdown + the
     * list prices actually used, then the balance breakdown. No visible text
     * uses these labels — they only live in `title`/`aria-label`.
     */
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
      lines.push(t('spendNote'));
      lines.push('');

      if (snapshot.phase === 'loading') {
        lines.push(t('loading'));
      } else {
        lines.push(t('balanceLine', { amount: view.balanceText }));
        if (view.balances.length > 0) {
          lines.push(`${t('topupShort')} ${view.toppedUpText} · ${t('grantedShort')} ${view.grantedText}`);
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

    function pageVisible() {
      return typeof document === 'undefined' || document.visibilityState === 'visible';
    }

    /** Dictionary fallback used when the locale seat is unavailable. */
    function translateFallback(key, params) {
      const template = Object.prototype.hasOwnProperty.call(en, key) ? en[key] : key;
      if (params === null || params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }

    /**
     * Prefer the locale seat's translation, but fall back to the bundled
     * English dictionary when the seat is missing or has no such key.
     */
    function localized(seat, key, params) {
      if (typeof seat === 'function') {
        const value = seat(key, params);
        if (typeof value === 'string' && value !== key) return value;
      }
      return translateFallback(key, params);
    }

    const backoffDelay = (count) => ERROR_BACKOFF_MS[Math.min(Math.max(count, 1), ERROR_BACKOFF_MS.length) - 1];

    // --- icons (14x14 inline SVG, currentColor, original paths) ---

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

    /**
     * The composer-dock pill. Balance fetching/polling is local to this
     * component; spend comes from projections and re-renders with them.
     */
    function BalancePill(props) {
      const seat = props.t;
      const t = (key, params) => localized(seat, key, params);

      // Standard session seats; defensive when an older client lacks them.
      const useProjection = props.useProjection;
      const usage = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined;
      const selection = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined;

      const [hover, setHover] = React.useState(false);
      const [snapshot, setSnapshot] = React.useState({ phase: 'loading' });
      const clickRef = React.useRef(null);

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

        const clearTimer = () => {
          if (timer !== 0) {
            window.clearTimeout(timer);
            timer = 0;
          }
        };

        /** Schedule the next poll; never while the page is hidden. */
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
              error,
            };
          }
          return { phase: 'error', prices: lastPrices, error };
        };

        /** Fold one route payload into React state; returns true on success. */
        const applyPayload = (payload) => {
          if (payload !== null && typeof payload === 'object' && payload.prices !== null && typeof payload.prices === 'object') {
            lastPrices = payload.prices;
          }
          if (payload !== null && typeof payload === 'object' && payload.ok === true && Array.isArray(payload.balances)) {
            const success = {
              fetchedAt: typeof payload.fetchedAt === 'number' ? payload.fetchedAt : Date.now(),
              isAvailable: payload.isAvailable === true,
              balances: payload.balances,
              provider: typeof payload.provider === 'string' ? payload.provider : '',
            };
            lastSuccess = success;
            failures = 0;
            setSnapshot({ phase: 'ready', ...success, prices: lastPrices, error: null });
            return true;
          }

          failures += 1;
          const isErrorBody = payload !== null && typeof payload === 'object' && payload.ok === false;
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
            const aborted = error !== null && typeof error === 'object'
              && (error.name === 'AbortError' || error.name === 'TimeoutError');
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

        // Initial fetch; polling starts only after the first response settles.
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
        // The pill is a single session-scope occupant; it mounts once per session.
      }, []);

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
      const buckets = readUsage(usage);
      const price = pickPrice(prices, readModel(selection));
      const symbol = prices.symbol.length > 0 ? prices.symbol : currencyPrefix(prices.currency);
      const spendText = buckets === null ? '—' : formatSpend(computeSpendUnits(buckets, price, prices), symbol);
      const title = buildTitle(snapshot, t, {
        spendText,
        buckets,
        price,
        symbol,
        balanceText,
        toppedUpText,
        grantedText,
        balances,
      });

      const fire = () => {
        if (typeof clickRef.current === 'function') {
          try {
            clickRef.current();
          } catch {
            // A refresh click must never surface as a render error.
          }
        }
      };

      return h('span', {
        role: 'button',
        tabIndex: 0,
        title,
        'aria-label': title,
        onClick: fire,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            fire();
          }
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onFocus: () => setHover(true),
        onBlur: () => setHover(false),
        style: {
          order: DOCK_ORDER,
          flex: 'none',
          boxSizing: 'border-box',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          height: 22,
          padding: '0 6px',
          borderRadius: 6,
          fontSize: 12,
          lineHeight: '20px',
          color: 'var(--dsw-alias-label-secondary)',
          fontVariantNumeric: 'tabular-nums',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          userSelect: 'none',
        },
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
