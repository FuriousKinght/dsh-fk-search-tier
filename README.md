# dsh-fk-search-tier

**两级搜索 + 两级抓取 failover** —— 搜索先 Tavily 后 DeepSeek Search API；抓取先 DeepSeek Fetch API 后直连兜底。

> DeepSeek Harness 插件。不改 DSH 本体，纯 `ctx.web` provider 注册。

---

## 为什么做这个

DSH 默认的 `deepseek-official` 搜索通道：

- 每次搜索**消耗一个完整模型轮次**（实测约 9.6K input token）
- 按 token 计费，高峰期成本翻倍

两级方案把成本压到最低：

```
【搜索】searchProvider: search-tier
第 1 层  Tavily   → 免 key 匿名档 / 免费 1000 credits/月
                    ↓  429 / 额度耗尽 / 5xx / 超时 / 空结果
第 2 层  DeepSeek → 5 元 / 1000 次成功请求（按次，不烧 token）

【抓取】fetchProvider: fetch-tier
第 1 层  DeepSeek Fetch API → 返回干净 Markdown（实测 ~0.3 秒）
                    ↓  429 / 额度耗尽 / 5xx / 超时
第 2 层  直连抓取           → 零成本兜底（HTML → 纯文本）
```

**实测数据**（2026-10-17）：

| 项目 | 结果 |
|---|---|
| Tavily keyless 免注册 | ✅ 返回 5 条真实结果 |
| DeepSeek Fetch API | ✅ 0.53s / 931 字符（example.com） |
| DeepSeek Fetch 真实页面 | ✅ 0.27s / 24,740 字符（GitHub 仓库页） |
| 不存在的域名 | HTTP 500（API 的预期行为，触发切层） |

---

## 安装

```sh
dsh plugin --profile desktop add <本包路径或包名>
```

⚠️ **必须让 DSH 走 bundle 机制自动加载 patch**，不要手工把 `cordis.patch.yml`
的内容抄进 profile 的 `cordis.patch.yml` —— 那会绕过加载时序，导致
`tool-web: waiting for web`。

装完重启 DSH。

---

## 配置

### ⚠️ 先把这件事说清楚：密钥不要写进插件目录

插件目录里的 `cordis.patch.yml` 是**随插件发布**的文件。
把 `apiKey` 写在那里，等于把密钥公开（推 GitHub、发给别人、打包分发都会带上）。

**正确做法有两种，任选其一（推荐 A）：**

---

### A. 用环境变量（推荐）

插件会自动读这两个环境变量，`cordis.patch.yml` 里留空即可：

| 后端 | 环境变量 |
|---|---|
| DeepSeek Search / Fetch | `DEEPSEEK_API_KEY` |
| Tavily（可选） | `TAVILY_API_KEY` |

**Windows — PowerShell（当前用户，永久生效）：**

```powershell
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "sk-你的key", "User")
```

**Windows — 图形界面：**

```
Win + R  →  sysdm.cpl  →  高级  →  环境变量
  → 用户变量 → 新建 → 变量名 DEEPSEEK_API_KEY，变量值填你的 key
  → 确定 → 重启 DSH
```

> 改完环境变量**必须重启 DSH** 才生效 —— 已在运行的进程不会重新读取。

---

### B. 在 profile 层覆盖（密钥放私有文件）

`$DSH_HOME/profiles/<profile>/cordis.patch.yml` 是**你自己的私有文件**，不随插件发布。

在文件末尾追加：

```yaml
# 覆盖 search-tier 的配置（本文件是私有的，可以写密钥）
- id: search-tier
  name: dsh-fk-search-tier
  config:
    order: [tavily, deepseek]

    deepseek:
      apiKey: 'sk-你的key'
      baseURL: https://api.deepseek.com

    tavily:
      apiKey: 'tvly-你的key'   # 可选；没有就走 keyless 匿名档
```

**注意**：profile 层的同名 id 会**整段覆盖**插件自带的配置，
所以「想保留的键都要重述一遍」，不能只写 `apiKey`。

---

### 最小配置（零配置也能用）

**不配任何密钥**也能工作：

- **Search**：Tavily 的 keyless 匿名档（免注册，实测可用）
- **Fetch**：直连抓取（零成本兜底）

```yaml
- id: search-tier
  name: dsh-fk-search-tier
  config:
    order: [tavily, deepseek]
    tavily: {}
    deepseek: {}          # 无 key → 该层自动跳过
```

**代价**：没有 DeepSeek 层作为兜底，Tavily 匿名档限流时就没有第二层了。

---

### 完整配置项

```yaml
- id: search-tier
  name: dsh-fk-search-tier
  config:
    # ── 层级顺序 ──
    order: [tavily, deepseek]              # 搜索：先 Tavily，再 DeepSeek
    fetchOrder: [deepseek-fetch, direct]   # 抓取：先 DeepSeek Fetch，再直连

    # ── 第 1 层：Tavily ──
    tavily:
      # apiKey 留空 → keyless 匿名档；有 key 走账户额度（1000 credits/月）
      depth: basic          # basic=1 credit | advanced=2 credits
      maxResults: 8

    # ── DeepSeek 官方 API（Search + Fetch）──
    deepseek:
      # apiKey 留空 → 自动读环境变量 DEEPSEEK_API_KEY；仍然没有 → 该层跳过
      baseURL: https://api.deepseek.com
      maxResults: 8
      needContent: false     # true 会额外返回网页正文（更慢、更长）
      fetchMaxBytes: 200000  # Fetch 单页最大字节

    # ── 直连抓取（零成本兜底）──
    direct:
      # userAgent: ''        # 可覆盖默认 UA
      {}

    # ── 超时 ──
    timeoutMs: 20000         # 搜索单层超时
    fetchTimeoutMs: 30000    # 抓取单层超时（页面通常更大）
    failOnEmpty: true        # 上一层返回 0 条也切下一层

    # ── 熔断 ──
    breaker:
      threshold: 3           # 瞬时故障累计几次才开断
      burstWindowMs: 300000  # 5 分钟窗口
      cooldownMs: 60000      # 瞬时故障冷却 60 秒
      quotaCooldownMs: 3600000  # 额度耗尽冷却 1 小时
```

---

### 怎么确认密钥读到了

配好并重启 DSH 后，让 AI 调一次诊断工具：

```
search_tier_status
```

返回的 `layers` 里看 `hasKey` 字段：

```json
{
  "id": "deepseek",
  "hasKey": true,        ← true 表示密钥读到了
  "needsKey": true,
  "open": false
}
```

**`hasKey: false` 说明密钥没读到**，按上面 A / B 检查，并确认已重启 DSH。

---

### 排查清单

| 现象 | 原因 | 解决 |
|---|---|---|
| `hasKey: false` | 环境变量没设，或设了没重启 DSH | 重设 + 重启 |
| `hasKey: true` 但报 401 | key 无效或已过期 | 去平台确认 |
| 一直用 Tavily，从不切 DeepSeek | Tavily 正常时不会切（这是设计） | 正常现象 |
| 两层都失败 | 网络问题 / 两边都额度耗尽 | 看错误信息里的 `skipped-open` |

---

## 切换规则

搜索与抓取共用同一套熔断语义（两个独立实例，参数相同）。

| 触发条件 | 行为 | 冷却 |
|---|---|---|
| `429` / `402` / 文本含 `insufficient` `quota` | 该层开断，立即切下一层 | **1 小时** |
| `401` / `403`（凭据问题） | 跳过该层（不冷却，配置改了立刻恢复） | 无 |
| `5xx` / 超时 / 网络错误 | 窗口内累计 3 次才开断 | **60 秒** |
| 返回 **0 条结果**（仅搜索） | 本次直接切下一层（不计入熔断） | 无 |
| 该层缺 key（仅 deepseek / deepseek-fetch） | 直接跳过 | 无 |

冷却到期后**自动半开**：下一次请求放行做探活，成功即闭合。

---

## 返回给模型的内容

### 搜索

严格遵循 DSH 的 `ctx.web` 契约，**只返回 `sources`**（让模型自己读）：

```js
{
  sources: [
    { url, title, snippet, publishedAt? }
  ],
  truncated: boolean,
  content?: string     // 仅 Tavily 返回 answer 时才带
}
```

- **Tavily**：`snippet` 取 `content` 前 500 字符
- **DeepSeek**：`snippet` 优先取 `summary`（600-800 字符长摘要），回退 `snippet`（100-200 字符）

模型收到的最终文本由 DSH 的 `formatSearchOutput` 组装成 markdown 来源列表。

### 抓取

按官方 `WebFetchResult` 契约：

```js
{
  url: string,              // 请求的 URL（API 不报告重定向后的最终 URL）
  statusCode: 200,          // 成功即 200（DeepSeek API 不报告目标页面状态）
  body: { kind: 'text', content: string },
  truncated: false
}
```

- **DeepSeek Fetch**：直接用 API 返回的 `content`（已是 Markdown）
- **直连抓取**：`fetch` 原始 HTML → `htmlToText()` 转纯文本；非 HTML 原样返回

---

## 诊断

注册了一个只读工具 `search_tier_status`，AI 可直接调用查看：

```json
{
  "search": {
    "providerId": "search-tier",
    "order": ["tavily", "deepseek"],
    "lastWinner": "tavily",
    "layers": [
      { "id": "tavily", "hasKey": false, "open": false, "lastError": null },
      { "id": "deepseek", "hasKey": true, "open": false, "lastError": null }
    ],
    "breaker": { "tavily": { "open": false, "remainingMs": 0 } }
  },
  "fetch": {
    "providerId": "fetch-tier",
    "order": ["deepseek-fetch", "direct"],
    "lastWinner": "deepseek-fetch",
    "layers": [
      { "id": "deepseek-fetch", "hasKey": true, "open": false, "lastError": null },
      { "id": "direct", "hasKey": true, "open": false, "lastError": null }
    ]
  }
}
```

---

## 自测

```sh
node test/selftest.mjs
```

**53 项断言**，覆盖：

| 段 | 内容 |
|---|---|
| 一 | 错误分类 `classify()` |
| 二 | 熔断器（额度 / 瞬时 / 半开） |
| 三 | 搜索 provider 契约 |
| 四 | **真实** Tavily keyless 调用 |
| 五 | 降级逻辑（熔断跳过） |
| 六 | 空结果切层 |
| 七 | **Fetch provider 契约与 failover**（13 项） |
| 八 | **真实** DeepSeek Fetch API 调用（5 项） |

---

## 与 dsh-search-failover 的区别

| | `dsh-search-failover` | **本插件** |
|---|---|---|
| 搜索后端数 | 10 个 | **2 个（专注）** |
| 抓取 failover | ❌ | ✅ **有（2 层）** |
| 支持 DeepSeek 新 Search API | ❌ 无 | ✅ **有** |
| 支持 DeepSeek Fetch API | ❌ 无 | ✅ **有** |
| Tavily keyless | ✅ | ✅ |
| 熔断 | ✅ | ✅ |
| 设置页 | ✅ | ❌（纯配置） |
| 代码量 | ~90 KB | **~26 KB** |

如果你的需求就是「Tavily → DeepSeek」两级搜索加重试兜底抓取，本插件更轻。

---

## 与官方 `dsh-web-deepseek-api` 的区别

DSH 0.2.1-rc.2 起官方内置了 DeepSeek Search / Fetch provider。两者不冲突，但定位不同：

| | 官方内置 | **本插件** |
|---|---|---|
| DeepSeek Search | ✅ | ✅ |
| DeepSeek Fetch | ✅ | ✅ |
| **两级 failover** | ❌ **无**（README 明确写「不会自动重试或回退至其他提供者」） | ✅ **有** |
| **Tavily 免费额度兜底** | ❌ 无 | ✅ 1000 次/月 |
| **消费 `summary` 长摘要** | ❌ 丢弃（只映射 `snippet`） | ✅ 优先使用 |
| 热切换 provider | ✅（rc.2 的 Volatile） | ❌ 需重启 |
| 维护方 | 官方 | 自己 |

⚠️ **两者同时存在时可能触发 `WEB_PROVIDER_AMBIGUOUS`**（多个可用 provider 但未显式指定）。
本插件的 patch 显式写了 `searchProvider` / `fetchProvider`，所以不会歧义；
但如果你在设置页把官方开关打开，要注意读一下最终生效的是哪个。

---

## 已知限制

1. **Tavily keyless 是匿名档**，有速率限制，随时可能被官方关闭
2. **DeepSeek Search / Fetch API 均按次计费**，各 5 元/1000 次
3. **直连抓取层不解析 JS 渲染的页面**（纯 `fetch` + HTML 转文本）
4. **抓取成功一律报 200** —— DeepSeek API 不报告目标页面状态，这是官方契约的行为
5. 无设置页，改配置需编辑 YAML 并重启

---


## 更新记录

### v0.2.0（2026-10-20）

**密钥不再随插件发布 —— 修掉一个会泄露 API Key 的安全问题**

插件目录里的 `cordis.patch.yml` 是随插件分发的文件。之前把 `apiKey` 写在那里，
等于把密钥公开（推 GitHub、发给别人、打包分发都会带上）。

- `cordis.patch.yml` 里的 `apiKey` 一律留空
- 插件新增环境变量支持：`DEEPSEEK_API_KEY` / `TAVILY_API_KEY`
- 读取顺序：patch 配置 → 环境变量 → 该层跳过
- README 新增完整的「配置」章节（含 Windows 设置步骤、profile 覆盖法、排查清单）

**抓取层新增两级 failover**

原来只有搜索有 failover，抓取是单层。现在抓取也两级：

- 第 1 层：DeepSeek Fetch API（返回干净 Markdown）
- 第 2 层：直连抓取（`fetch` + HTML 转文本，零成本兜底）

**额度感知熔断**

- 瞬时故障：5 分钟内累计 3 次开断，冷却 60 秒
- **额度耗尽单独识别**：冷却 1 小时（避免反复撞额度墙）
- 两层都失败时抛明确错误，不静默返回空

**诊断工具**

新增 `search_tier_status` 工具，返回各层状态：是否被熔断、剩余冷却时间、
最近错误、上次成功用的是哪层、`hasKey` 是否读到密钥。

**自测**

`test/selftest.mjs` 覆盖切换规则、熔断、错误分类；`test/e2e.mjs` 走真实调用。
测试里的密钥来源改为「环境变量优先，其次从 DSH 凭据文件动态读取」，
不再硬编码本机路径。

---


## License

MIT