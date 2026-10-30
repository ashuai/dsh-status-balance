# dsh-status-balance 方案（Design Record, v2）

## 1. 问题与目标

用户要「能跟在上下文的后面」，显示 2 个值：**本会话消耗** 与 **余额**；只有 2 个金额，不加文字标签，用 icon 区分。

v2 目标：在 composer 下方 dock 行、上下文指示器（`ContextMeter`）之后，放一个紧凑 pill：

- 左：spend icon + 本会话消耗（估算，人民币）；
- 中：`·` 分隔（非标签）；
- 右：wallet icon + DeepSeek 钱包余额。

参照 Reasonix 的语义：可配置 balance endpoint、切 provider/model 时丢弃旧余额响应。本插件保留「可配置 `balanceUrl` + stale 丢弃」，余额仍由 Host 缓存时间戳与 `stale` 标记控制；spend 则从 session projection 实时推导，两者同一 pill 内展示。

## 2. 归属与上下文

- **Host（`index.js`）**：解析 credential、请求上游、维护 balance cache / single-flight / backoff，并在每个响应里携带价格表 `prices`。无 Session 绑定。
- **Client（`client.js`）**：
  - balance：fetch 同源 route，轮询/退避/点击刷新；
  - spend：读 `useProjection('tokenUsage')` 与 `useProjection('modelSelection')`，按价格表计算，React 重渲染驱动，**不新增 polling / timer**；
  - 渲染：`conversation.composer.dock`（list, session scope）单条 occupant。
- **Seat 与顺序**：`ContextMeter` 不是 slot，而是 `div[data-composer-dock]` 里 slot outlet 之后的 sibling。dock 是 flex row（`justify-content:center; align-items:center; gap:12px`）。因此注册 `order: 100`，同时 root inline `order: 100; flex: none`，让它成为 ContextMeter 之后的最后一个 flex item。v1 的 `shell.bottom` 注册已完全移除。

## 3. 最小设计

### 3.1 展示

- 一个 `span`：`inline-flex`、height 22、padding `0 6px`、radius 6、font-size 12、line-height 20、`--dsw-alias-label-secondary`、`tabular-nums`、`cursor:pointer`；默认透明背景，hover 用 `--dsw-alias-interactive-bg-hover`。
- 可见内容仅：spend icon + spend 金额 + `·`（`--dsw-alias-label-tertiary`）+ wallet icon + balance 金额。**没有** `余额` / `消耗` / `Balance` 等可见文字。
- icon：14×14 原创新 paths，`stroke: currentColor`，`aria-hidden`。spend = 方框＋向外的箭头（outflow）；balance = 圆角钱包＋盖线＋点。
- 点击 / Enter / Space：请求 `?refresh=1` 刷新余额（Host floor 仍生效）。
- `title` 与 `aria-label`（同一文本，本地化 zh/en）承载：
  - `本会话消耗（估算）: ¥…`；
  - `输入 N · 缓存命中 N/M · 输出 N`（M = uncached + cacheRead + cacheWrite）；
  - 实际采用的单价：`¥1/1M 输入 · ¥0.02/1M 缓存 · ¥2/1M 输出`；
  - `按列表价格估算；DeepSeek 不返回单次请求成本`；
  - `余额 ¥…` + `充值 ¥… · 赠送 ¥…` + `更新于 HH:mm:ss`；
  - stale / unavailable / error reason；`点击刷新`。

### 3.2 Spend 计算

```
(uncachedInput*input + cacheRead*cacheHit
 + cacheWrite*(cacheWriteUsesInput ? input : cacheWrite)
 + output*output) / 1_000_000
```

- projection 形态兼容 wire（`{ totals: {...}, last }`）与 flat（直接 bucket 字段）两种；短字段名（`uncachedInput` 等）也接受。
- model 取 `modelSelection.next.model ?? lastUsed.model`；查不到时用价格表 `default`。
- 金额显示：0 → `¥0.00`；`0 < v < 0.01` → 4 位小数（`¥0.0043`）；`>= 0.01` → 至少 2 位、最多 4 位有效小数并去尾零（`¥3.02`、`¥9.025`）。数字用整数 nano-yuan / BigInt 计算，避免浮点尾差。
- **只做估算**：DeepSeek 不返回单次请求成本；tooltip 明示。中途切 model 时整会话按当前选择定价，属近似。

### 3.3 价格表

Host 默认（per 1M tokens, CNY）：

| model | input | cacheHit | output |
| --- | --- | --- | --- |
| `deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-flash-1017` | 1 | 0.02 | 2 |
| `deepseek-v4-pro` / `deepseek-v4-pro-0813` | 3 | 0.025 | 6 |
| `default` | 1 | 0.02 | 2 |

`config.prices` 深度合并：标量（`currency` / `symbol` / `perMillion` / `cacheWriteUsesInput`）覆盖；model row 逐字段合并；未知 model id 追加；缺省/非法字段回退默认。Host 在 **success / error / stale / 405 / internal** 每个 body 都带 `prices`。客户端另内置同一份默认表，作为 payload 无 `prices` 时的 fallback（旧 Host 或 route 不可达时仍能算 spend）。

### 3.4 Route contract

- `GET /plugin/dsh-status-balance`（exact，路径可配）。
- Success（200）：`{ ok:true, fetchedAt, stale:false, isAvailable, balances:[...], provider, prices }`。
- Failure（200）：`{ ok:false, code, message, status?, prices, fetchedAt?, stale?, isAvailable?, balances?, provider? }`；`code ∈ {no-credential, upstream-status, network, parse, internal, method-not-allowed}`。
- 非 GET → 405 + `Allow: GET`（body 也带 `prices`）。
- `Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`。
- 错误用 HTTP 200 + `ok` 判别：HTTP 调用成功，失败属于上游；单一路径解析。

### 3.5 Balance cache / 状态机（不变）

`lastSuccess`、`lastErrorAt`、`lastFetchStartedAt`、`inFlight`：

1. cache fresh 且非 force → 直接返回；
2. 有 in-flight → 共享；
3. force 且低于 `minRefreshMs` → 不请求；
4. 非 force 且在 failure backoff → 不请求；
5. 否则 fetch。失败保留 `lastSuccess` ≤ `staleMaxMs` 并标 `stale:true`；超过则丢弃余额。

## 4. 更新策略与取舍

| 项 | 选择 | 理由 |
| --- | --- | --- |
| Spend | projection 驱动，无 timer/polling | token 总量变化就是渲染时机；多余轮询只会增加开销。 |
| Balance 首次 | mount fetch 一次 | 打开页面立即有数。 |
| Balance 轮询 | 60s，仅 visible | 余额变化慢；隐藏页不花 API、不空转 timer。 |
| 回前台 / focus | 数据 >30s 才 refetch | 用户真正要看的时刻刷新；短时间切 tab 不重复请求。 |
| Balance 错误 | 30s → 60s → 120s，成功重置 | 上游故障时降低压力；封顶避免恢复太慢。 |
| 点击刷新 | `?refresh=1`，Host `minRefreshMs` 兜底 | 主动刷新即时生效，连点不打穿上游。 |
| Host cache TTL | 30s | 多标签页/并发请求合并；比轮询短，正常轮询每次拿到新数据。 |
| stale-while-error | ≤5min | 上游抖动时保留最近可信余额；超过丢弃，避免旧数误导。 |
| Watchdog / cleanup | 15s abort；unmount 清 timer/listener、abort in-flight | 不悬挂、不留孤儿。 |

## 5. 边界与诚实声明（Limits）

- **Spend 是估算**：按列表价格 × token 数；不是账单金额，不含折扣/赠送额度抵扣/缓存命中率的服务端差异。tooltip 明示。
- **整会话单模型计价**：`modelSelection` 只给当前/最近模型；中途切模型时按当前价近似整个会话。
- **未鉴权的本地 route**：与其它 plugin route 一致，挂在 web server 监听接口上；只返回 display-safe 字段，API key 永不离开 Host。能访问该 server 的人可读余额。
- **依赖已配置 credential**：未配置时 `no-credential`，余额显示 `—`；spend 仍可算。
- **无 provider/model 维度**：单一 DeepSeek 账户；Reasonix 的 per-provider 切换丢弃在本插件没有对应物，只有 balance stale 丢弃。
- **pull-based、无历史**：没有 SSE/push、没有余额趋势图。
- **Projection 缺失**：老客户端没有 `useProjection` 时 spend 显示 `—`，绝不抛错。

## 6. 与既有设施的关系

- **为什么是 `conversation.composer.dock`**：这是输入框下沿唯一的 list/session slot，shipped `activity`(order 0)、`usage`(order 1) 已在此；additive，互不遮蔽。
- **为什么还要 root `order:100`**：ContextMeter 不是 slot，而是 slot outlet 的 sibling；只有 flex `order` 能保证本 pill 排在它之后。dock 的 `justify-content:center` 让整组居中，order 只改变相对位置。
- **为什么不用 `shell.bottom`**：v1 是整条底栏；用户明确要求「跟在上下文后面」，composer dock 才是正确归属。v2 已删除该注册。
- **为什么不用 `ctx.remote` / typert namespace**：编译期生成，手写纯 JS bundle 无法新增；同源 web route 是文档化 seam。
- **为什么不用 `deepseekAccount.getBalance`**：account 平台信息不是 API-key 钱包的 `/user/balance`。
- **依赖策略**：无 dependencies；React / slots / locale 由页面模块表提供。

## 7. 测试锚点（verification must cover）

1. **Seat**：`ctx.slots.inject` 只收到 `conversation.composer.dock`；register 为 `{ id:'balance', order:100, locale:'statusBalance' }`；**没有** `shell.bottom` 注册。
2. **可见结构**：恰好 2 个金额 + 1 个 `·`；无 `余额` / `Balance` / `消耗` 等可见标签；2 个 14×14 `stroke=currentColor` 的 SVG；root `order:100`、`flex:none`。
3. **Spend math**：`1M uncached + 1M cacheRead + 1M output` + 默认 flash 价 → `¥3.02`；`modelSelection.next.model='deepseek-v4-pro'` → `¥9.025`；token 全 0 → `¥0.00`；`2150` output + flash → `¥0.0043`；host `prices` 自定义 → 按自定义价计算。
4. **Tooltip**：含 `本会话消耗（估算）`、token breakdown（`输入 N · 缓存命中 N/M · 输出 N`）、所用单价、估算说明、`余额 …`、`充值 … · 赠送 …`、`更新于`、`点击刷新`；zh/en 均可用。
5. **Balance UI**：ready / stale 时余额与 route 一致；loading/error 显示 `—`，不抛错。
6. **Balance 行为**：mount 一次 fetch；同 fetchedAt 的 cache；`?refresh=1` 受 `minRefreshMs` 约束；失败 stale/backoff；hidden 清 timer；visible/focus >30s refetch；unmount abort + 清 listener。
7. **Route**：200 + JSON + `prices` 在 success/error/stale/405；非 GET 405 + `Allow: GET`；响应与日志无 key。
8. **隔离探针**：页面中 pill 位于 ContextMeter 之后（computed flex order / DOM 位置），无 console/page error；teardown 无残留进程与端口。
