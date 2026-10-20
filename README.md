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

全部配置在**本插件自带的 `cordis.patch.yml`** 里。也可以在 profile 层用同 id 覆盖。

### 最小配置（零配置，Tavily keyless + 无 DeepSeek）

```yaml
- id: search-tier
  name: dsh-fk-search-tier
  config:
    order: [tavily, deepseek]
    tavily: {}
    deepseek: {}          # 无 key → 该层自动跳过
```

### 推荐配置（Tavily 免费 key + DeepSeek 兜底）

```yaml
- id: search-tier
  name: dsh-fk-search-tier
  config:
    order: [tavily, deepseek]

    tavily:
      apiKey: 'tvly-xxxxx'   # app.tavily.com 免费注册，1000 credits/月
      depth: basic           # basic=1 credit, advanced=2 credits
      maxResults: 8

    deepseek:
      apiKey: 'sk-xxxxx'     # 与主模型同一个 DeepSeek key
      baseURL: https://api.deepseek.com
      maxResults: 8
      needContent: false     # true 会额外抓网页正文（更慢更长）

    timeoutMs: 20000
    failOnEmpty: true

    breaker:
      threshold: 3
      burstWindowMs: 300000
      cooldownMs: 60000
      quotaCooldownMs: 3600000
```

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

## License

MIT
