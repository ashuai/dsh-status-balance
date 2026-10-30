# dsh-status-balance 设计记录（Design Record）

> 章节 1–7 记录 v2（composer pill，两个金额）；章节 8–14 记录 v3（点击弹层、今日账本、峰谷计价）。

## 1. 问题与目标

用户要「能跟在上下文的后面」，显示 2 个值：**本会话消耗** 与 **余额**；只有 2 个金额，不加文字标签，用 icon 区分。

v2 目标：在 composer 下方 dock 行、上下文指示器（`ContextMeter`）之后，放一个紧凑 pill：

- 左：spend icon + 本会话消耗（估算，人民币）；
- 中：`·` 分隔（非标签）；
- 右：wallet icon + DeepSeek 钱包余额。

参照同类工具的做法：可配置 balance endpoint、切 provider/model 时丢弃旧余额响应。本插件保留「可配置 `balanceUrl` + stale 丢弃」，余额仍由 Host 缓存时间戳与 `stale` 标记控制；spend 则从 session projection 实时推导，两者同一 pill 内展示。

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
- **无 provider/model 维度**：单一 DeepSeek 账户；同类工具的 per-provider 切换丢弃在本插件没有对应物，只有 balance stale 丢弃。
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

---

# v3 增量：popover + 今日账本 + 峰谷计价

> 本节覆盖 v2 的价格表与测试锚点 3 中「flash 1/0.02/2、pro 3/0.025/6」的描述；v2 的 pill seat、无标签、余额缓存策略继续有效。

## 8. 问题与目标

用户点击 pill 应看到明细，并追问「峰谷价有没有算」。v3 的回答：

- pill 继续只显示 2 个金额，但把会话 spend 改为**按当前时段**（高峰/谷时）计价；
- 点击 pill 打开 popover：今日我的消耗、今日余额减少、差额、充值、预计可用、当前时段；
- Host 侧新增**本机日账本**：从 session 事件累计消耗，从余额观测累计减少，按本地日滚动；
- 峰谷价由 `Asia/Shanghai` 时区与可配置窗口决定，事件按 `event.time` 所属时段计价。

## 9. Popover 设计理由

- 触发：pill 改为真实 `<button type="button">`，`aria-haspopup="dialog"` / `aria-expanded`；点击展开并入队一次 balance 强制刷新。
- 面板：`react-dom.createPortal(panel, document.body)`，`position:fixed; z-index:1100`，`max-content` 宽度、300–440px 夹取；只在打开时挂载。
- 定位：以 pill `getBoundingClientRect()` 为锚，面板放上方 gap 8；上方空间不足则放下方；左右 `clamp(右对齐, 12, vw-12-width)`；`resize` 与捕获阶段 `scroll` 重测。
- 关闭：外部 `pointerdown`/`click`（capture）与 `Escape`；点击面板内部不关闭；Escape 后焦点回 pill；卸载移除全部 listener。
- 内容布局：标题行（wallet icon + 标题 + 当前余额）+ 细线 + `dl` 两列 grid（label/value）+ 细线 + 11px footer。行内 label 允许出现（pill 仍无标签）。
- 差额只在 `>¥0.01` 时出现，label 明示「其他终端/密钥」；充值单独一行 `+¥x`。
- loading/error 时行值显示 `—`，footer 保留错误原因；面板照常可开。

## 10. Ledger 状态机

持久化：`$DSH_HOME/.dsh-status-balance.json`（无 `DSH_HOME` 时 `~/.dsh`），`version: 1`，金额单位 ¥0.0001 整数。

```json
{ "version":1, "day":"YYYY-MM-DD",
  "today": { "mySpendUnits":0, "balanceDecreaseUnits":0, "balanceIncreaseUnits":0,
             "firstBalance":null, "lastBalance":null, "firstSeenAt":null, "lastSeenAt":null },
  "sessions": { "<sessionId>": { "seq": 12 } },
  "history": [ { "day":"...", "mySpendUnits":12345, "balanceDecreaseUnits":23456 } ],
  "backfill": { "day":"...", "status":"pending|done|partial", "truncated":false } }
```

- **Live fold**：`session/event` → `assistant/message.usage`，否则扫 `assistant/attempt`/`assistant/message` stream 的最后一个 `chunk.type==='usage'`。`isOwnSeq` 为 false（fork inherited）跳过；`event.seq <= watermark` 跳过；计数后把 watermark 推到该 seq。model 取 assistant message `source.model`，attempt 用该 session 最近的 `request/context.model`，都没有则 default 价。
- **日边界**：`event.time` 的本地日 > ledger.day → archive + reset；< 则忽略（防时钟回拨倒退）。archive 推 `{day, mySpendUnits, balanceDecreaseUnits}` 进 history，history 截到 14 条。新日 `firstBalance/lastBalance = 旧 lastBalance`，`firstSeenAt/lastSeenAt = null`；sessions watermark **保留**（全局防重）；backfill 重置为 pending。
- **Backfill**：每日一次。live sessions（全部）+ persisted sessions（`header.createdAt >= dayStart - 24h`），live 优先；own 判定 live 用 `isOwnSeq`，persisted 用 `handle.inheritedEventCount`；`handle.read()` 后必须 `close()`。上限 200 session / 200000 event；命中上限或单 session 异常 → `truncated=true` / `status='partial'`。route 首次命中最多等 1.5s，随后后台继续；`today.backfill` 暴露状态。
- **Balance observation**：仅在上游 fetch 成功且解析出余额时；取 CNY wallet（否则第一个）。当日首次设 baseline；之后下降累加 decrease、上升累加 increase；更新 lastBalance/lastSeenAt。重启后从本进程首次观测开始，不追溯之前。
- **持久化**：tmp + rename 原子写，debounce ~2s；损坏 JSON 重命名为 `.corrupt-<ts>` 后新建，加载永不 throw；history load/save 均截 14。
- **单写者假设**：同一 DSH_HOME 只应有一个 Host 进程；多进程并发写没有锁（见限制）。

## 11. 峰谷计价

- 时区默认 `Asia/Shanghai`；周一至周五 `[9,12)`、`[14,18)` 为 peak；周末与其余时段 offpeak（`weekendOffPeak` 可关）。
- 判断来自 `Intl.DateTimeFormat.formatToParts` 的本地 hour/weekday；`nextSlotBoundary` 从窗口边界（0/9/12/14/18）向后扫描最多 8 天，找到第一个状态变化点。
- 价格表 slot-shaped：`{ off:{input,cacheHit,output[,cacheWrite]}, peak:{...} }`；flat `{input,cacheHit,output}` 兼容为两 slot 同价；`config.prices` 深度合并。
- Host 的 ledger 用 `event.time` 选 slot 计价；客户端 pill 用 `Date.now()` 选当前 slot；同一事件在 popover 的 `mySpend` 与 pill 的 `sessionSpend` 可能因时段变化/是否含历史事件而不同，这是预期。
- 公式：`(uncached*input + cacheRead*cacheHit + cacheWrite*(cacheWriteUsesInput?input:cacheWrite) + output*output) / 1e6`；整数 nano-yuan/BigInt 计算，避免浮点尾差。

## 12. Trend 公式

- `avgDailyDecrease`：history 最后 ≤7 条 `balanceDecreaseUnits > 0` 的均值（basis `history`）。
- 无 history 时 fallback：今日 `lastSeenAt - firstSeenAt >= 1h` 且 decrease > 0 → `decrease / max(0.05, (now - dayStart)/24h)`（basis `today`）。
- `daysLeft = floor(lastBalanceUnits / avg)`；无 avg / avg<=0 → null；客户端显示 `>365` 或 `—`。
- `trend.days` = history 最后 7 条 `{date, decrease}`；tooltip 给出 N 与日均。

## 13. 限制（诚实声明）

- **我的消耗 vs 余额减少**：前者只含本进程能看到的 own session 事件；后者是钱包读数差，含其它终端、其它密钥、充值。两者不相等时差额行只做提示，不做归因。
- **观测起点**：Host 启动后第一次成功 fetch 才有 baseline；重启当天早先的余额变化不可见。
- **backfill 窗口**：只回填 `createdAt >= dayStart - 24h` 的 persisted sessions；更早创建但今天仍在跑的 session 仅在其 live 时才计入（live sessions 全部尝试）。
- **单进程假设**：ledger 没有跨进程写锁；同一 DSH_HOME 多开 Host 可能互相覆盖。
- **估算**：spend 是列表价估算，不是账单；中途切 model 时，事件自身若带 source model 则按事件 model，否则按最近 request/context/default。
- **无 `?session` 细分**：本版未实现 per-session 查询参数，避免路线表与 route 复杂化。
- **仍无鉴权**：route 与其它 plugin route 一样挂在 web server 监听接口上；只返回 display-safe 数据。

## 14. 测试锚点（v3）

1. **Host live**：peak flash 1M input+1M output = ¥10；off 同量 = ¥5；pro peak input 1M = ¥9；重复事件 seq 只计一次；fork inherited 跳过；attempt stream usage 用最近 request/context 的 model。
2. **Host slots**：Fri 10:00 peak、Fri 13:00 offpeak、Sat 10:00 offpeak；peak until 12:00，offpeak until 14:00，weekend until Monday 09:00。
3. **Rollover**：跨日事件触发 archive + reset；history 出现前一日、today 重置；watermark 保留。
4. **Balance observation**：100 → 95.50 → 96 得 decrease 4.50 / increase 0.50 / last 96.00 / difference 4.50；首次 baseline。
5. **Backfill**：persisted session 只计一次；handle close；失败 → partial；201 sessions → truncated partial 且只计 200。
6. **Persistence**：损坏 JSON 重命名恢复；write 后无 tmp 残留；history 截 14；history/today trend 公式（history avg、today fallback、daysLeft）。
7. **Degrade**：sessions 缺失时 today/trend 省略，slot/prices 仍在。
8. **Client popover**：portal 到 body、dialog role、aria-expanded；标题余额、5+ 行、差额为 0 时隐藏、daysLeft 42/>365/—、充值行、slot 文案、footer、错误原因；Escape/外部点击关闭、内部点击不关闭、卸载移除 listener。
9. **Client pill**：仍恰好 2 个金额、无标签；peak/off 价分别为 ¥10.00/¥5.00；pro peak ¥36.00；点击展开并 `?refresh=1`；sub-cent `¥0.0043`。
10. **Route**：today/trend/slot 在所有成功/错误 body；`prices` slot-shaped + timezone/peakWindows；`prices` 在 405；数字为 decimal string；无 key 泄漏。
11. **隔离探针**：真实页面中 pill 在 ContextMeter 后、popover 定位/关闭正常、无 console error；teardown 无残留。
