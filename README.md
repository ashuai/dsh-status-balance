# dsh-status-balance

A DeepSeek Harness Web UI plugin that shows two amounts beside the composer: this session's estimated spend and the DeepSeek account's wallet balance. The numbers carry no text labels — two small icons tell them apart.

## Where it renders

- Claims one entry in `conversation.composer.dock` (list, session scope): `id: balance`, `order: 100`.
- The root pill also sets inline `order: 100` / `flex: none`, so in the dock's flex row it renders after the context meter. The context meter is a sibling of the slot outlet in that row (not a slot itself), so flex order, not registration order alone, places the pill after it.
- Pill geometry: inline-flex, 22px high, 12px text, tabular numerals, 6px gap, 6px radius, `--dsw-alias-label-secondary` text, transparent background and a `--dsw-alias-interactive-bg-hover` hover. No visible text labels; a tertiary `·` separates the two amounts.
- Icons are 14×14 inline SVGs in `currentColor`: an outflow glyph (arrow leaving a box) for spend and a wallet glyph for balance.
- Tooltip and `aria-label` carry the details: spend estimate, token breakdown, the unit prices actually used, the balance breakdown, update time, stale/error reason, and the refresh hint. Clicking the pill asks the Host for a forced balance refresh.

## The two amounts

### Session spend (estimate)

Derived reactively from the session projections — no polling and no timers:

- `useProjection('tokenUsage')` supplies `uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`. Both the wire shape (`{ totals, last }`) and the flat shape are accepted.
- `useProjection('modelSelection')` supplies `next.model` (falling back to `lastUsed.model`) to pick the price row.

Formula, with prices per 1M tokens:

```
(uncachedInput * input
 + cacheRead   * cacheHit
 + cacheWrite  * (cacheWriteUsesInput ? input : cacheWrite)
 + output      * output) / 1_000_000
```

Display rules: zero shows `¥0.00`; a positive amount below 0.01 keeps four decimals (`¥0.0043`); larger amounts keep at least two decimals and up to four meaningful ones, so `¥3.02`, `¥1.24`, and `¥9.025` all stay precise. The currency symbol comes from the price table.

DeepSeek does not return a per-request cost, so this is an estimate from list prices; the tooltip says so. Mid-session model switches are priced at the current selection for the whole session (an approximation).

### Wallet balance

Fetched from the Host route. Formatting mirrors the shipped account settings UI: grouped thousands, two decimals, `<¥0.01` for a positive sub-cent, `-¥0.01` clamped magnitude for a tiny negative, `¥0.00` for zero; `¥` for CNY, `$` for USD, otherwise the currency code; multiple wallets join with ` / `.

## Price table

Default list prices per 1M tokens (CNY):

| model | input | cache hit | output |
| --- | --- | --- | --- |
| `deepseek-flash` | 1 | 0.02 | 2 |
| `deepseek-v4-flash` | 1 | 0.02 | 2 |
| `deepseek-v4-flash-1017` | 1 | 0.02 | 2 |
| `deepseek-v4-pro` | 3 | 0.025 | 6 |
| `deepseek-v4-pro-0813` | 3 | 0.025 | 6 |
| default row | 1 | 0.02 | 2 |

Override the whole table through the patch row's `config.prices`. Scalars (`currency`, `symbol`, `perMillion`, `cacheWriteUsesInput`) override; model rows merge field-by-field; unknown model ids join the table; missing or invalid fields keep their defaults. `cacheWriteUsesInput` (default `true`) prices cache writes at the input rate; otherwise the row's `cacheWrite` price is used.

The Host includes the merged table in every response. The browser also bundles the same defaults as a fallback, so spend stays computable when a payload predates the price table or the route is unreachable.

## Host configuration

All keys are optional and live in the patch row under `config`:

| Key | Default | Meaning |
| --- | --- | --- |
| `routePath` | `/plugin/dsh-status-balance` | Same-origin GET route the browser calls. |
| `apiKeyRef` | `DEEPSEEK_API_KEY` | Credential reference resolved through `ctx.credentials`. |
| `balanceUrl` | `https://api.deepseek.com/user/balance` | Upstream balance endpoint. |
| `cacheTtlMs` | `30000` | A cached success younger than this is served without a fetch. |
| `failureBackoffMs` | `15000` | After a failure, non-forced requests skip the network for this long. |
| `staleMaxMs` | `300000` | Last success may still be served as stale data up to this age. |
| `timeoutMs` | `8000` | Upstream fetch timeout. |
| `minRefreshMs` | `10000` | Floor between two fetches, including `?refresh=1`. |
| `prices` | see above | List-price table used by the browser for the spend estimate. |

## Response contract

The route is a plain same-origin HTTP endpoint. The API key never appears in a response.

Success (HTTP 200):

```json
{
  "ok": true,
  "fetchedAt": 1761744000000,
  "stale": false,
  "isAvailable": true,
  "balances": [
    { "currency": "CNY", "total": "1234.56", "granted": "0.00", "toppedUp": "1234.56" }
  ],
  "provider": "api.deepseek.com",
  "prices": {
    "currency": "CNY", "symbol": "¥", "perMillion": true, "cacheWriteUsesInput": true,
    "models": {
      "deepseek-flash": { "input": 1, "cacheHit": 0.02, "output": 2 },
      "deepseek-v4-pro": { "input": 3, "cacheHit": 0.025, "output": 6 }
    },
    "default": { "input": 1, "cacheHit": 0.02, "output": 2 }
  }
}
```

Failure (HTTP 200 with `ok: false`) always carries `prices`; when a success younger than `staleMaxMs` exists, it also carries the last snapshot:

```json
{
  "ok": false,
  "code": "network",
  "message": "upstream request failed",
  "prices": { "...": "..." },
  "fetchedAt": 1761744000000,
  "stale": true,
  "isAvailable": true,
  "balances": [ { "currency": "CNY", "total": "1234.56", "granted": "0.00", "toppedUp": "1234.56" } ],
  "provider": "api.deepseek.com"
}
```

Codes: `no-credential`, `upstream-status` (adds `status`), `network`, `parse`, `internal`, `method-not-allowed`. Non-GET requests get HTTP 405 with `Allow: GET`, also carrying `prices`.

Errors use HTTP 200 with an `ok` discriminant because the HTTP call to the Host succeeded; the failure belongs to the upstream lookup and the page renders it as a state. Every response is `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`.

### Cache and failure semantics

- A success is cached for `cacheTtlMs`. Concurrent requests share one in-flight upstream call (single-flight).
- A failure starts `failureBackoffMs`: non-forced requests answer immediately from the last success (marked stale) or from the failure.
- The last success stays servable for `staleMaxMs`; past that it is dropped from responses.
- `?refresh=1` bypasses the cache TTL but not `minRefreshMs`.
- The credential is re-resolved on every fetch, so rotating it needs no restart.

## Balance update strategy

- Fetch once on mount.
- Poll every 60s, only while `document.visibilityState === 'visible'`.
- On `visibilitychange` back to visible, and on window `focus`, refetch only when the last data is older than 30s.
- On error, back off 30s → 60s → 120s (reset on success). No polling while hidden.
- Clicking the pill requests `?refresh=1`; the Host floor still applies. A click during an in-flight fetch is queued once.
- In-flight fetches are aborted and timers/listeners are removed on unmount. A 15s client watchdog prevents a permanently pending request.

Spend has no timer and no request: the projection hooks re-render the pill when the session's token totals change.

## Install

The package is a bundle: `dsh.bundle.patch` points at `cordis.patch.yml`, which inserts the Host row, and `dsh.client` points the Web page at the browser module. It has no dependencies or peer dependencies; packages shipped with the harness resolve from the harness installation.

Install it as a profile bundle through the plugin manager's `install_bundle` action (pass this package directory), or add the same patch row to a profile composition. A page reload (or the manager's activation path) makes the client module live. The locale JSON files supply the plugin-manager title/description; `icon.svg` is the row icon.

## Security notes

- The API key is resolved and used only inside the Host process. The browser receives currency codes and balance strings, timestamps, the endpoint host, list prices, and short error text — never the credential or raw upstream bodies.
- Session spend is computed in the browser from session projections; no token counts or spend are sent to the Host by this plugin.
- The route is same-origin, GET-only, and `no-store`. There is deliberately no wildcard CORS header, so other origins cannot read it with a browser.
- Like other plugin routes, the endpoint is served on whatever interface the harness web server listens on. Anyone who can reach that server can read the balance fields; bind the server to localhost when that matters.
- The route does not log requests, responses, or credentials.
