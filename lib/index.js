/**
 * dsh-fk-search-tier — 两级搜索 failover + Fetch
 *
 * ── Search（两级 failover）──
 * 第 1 层：Tavily（优先用你的 key；无 key 自动降级到 keyless 匿名档）
 * 第 2 层：DeepSeek 官方 Search API（POST /v1/tools/search，按次计费）
 *
 * 切换触发条件（任一）：
 *   · 429 / insufficient / quota 类错误  → 长冷却（默认 1 小时）
 *   · 5xx / 超时 / 网络错误              → 短冷却（默认 60 秒），窗口内累计 3 次才开断
 *   · 返回 0 条结果                      → 当前请求立即切下一层（不冷却）
 *   · 第一层不可用（未配置且 keyless 被拒）→ 直接走第二层
 *
 * ── Fetch（三级 failover）──
 * 第 1 层：DeepSeek Fetch API（POST /v1/tools/fetch，返回页面 Markdown）
 * 第 2 层：直连抓取（fetch 原始 HTML → 转纯文本），零成本兜底
 *
 * 设计要点：
 *   1. 不改 DSH 本体，纯插件；通过 ctx.web.registerSearchProvider /
 *      ctx.web.registerFetchProvider 注册
 *   2. 不写 cordis.patch.yml 主体 —— 只提供 bundle 自带的 patch
 *   3. 每次 search/fetch 实时读配置 + 熔断状态，配置改了立刻生效
 *
 * @module dsh-fk-search-tier
 */

/** 默认 UA，避免被部分服务端拒绝。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 本 provider 在 ctx.web 里的 id。 */
export const SEARCH_TIER_PROVIDER_ID = 'search-tier'

/** provider 级错误，带 kind 供熔断器分类。 */
export class SearchTierError extends Error {
  constructor(message, kind = 'transient', code = 'WEB_PROVIDER_ERROR') {
    super(message)
    this.name = 'SearchTierError'
    this.kind = kind
    this.code = code
  }
}

/**
 * 把 HTTP 状态与异常归类成熔断器认识的 kind。
 * quota   → 额度耗尽，长冷却，不值得反复重试
 * auth    → 凭据问题，跳过该后端
 * transient → 5xx/超时/网络，短冷却后重试
 */
export function classify(status, text = '') {
  if (status === 429) return 'quota'
  if (status === 402) return 'quota'
  if (status === 401 || status === 403) return 'auth'
  if (status && status >= 500) return 'transient'
  if (/quota|insufficient|exceeded|limit reached|no credit/i.test(text)) return 'quota'
  if (/unauthorized|invalid api key|forbidden/i.test(text)) return 'auth'
  return 'transient'
}

/** 带超时的 JSON 请求。 */
export async function fetchJson(url, init, signal, timeoutMs = 20000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
  const onAbort = () => ctrl.abort(signal?.reason)
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal })
    const text = await resp.text().catch(() => '')
    if (!resp.ok) {
      throw new SearchTierError(
        `${url} -> HTTP ${resp.status}: ${text.slice(0, 240)}`,
        classify(resp.status, text),
      )
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new SearchTierError(`${url} -> 响应不是合法 JSON`, 'transient')
    }
  } catch (error) {
    if (error instanceof SearchTierError) throw error
    throw new SearchTierError(
      `${url} -> ${error?.message ?? String(error)}`,
      'transient',
    )
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 额度感知熔断器（照 dsh-search-failover 的模型简化而来）。
 *  - quota     → 直接长冷却
 *  - transient → 突发窗口内达到阈值才开断，短冷却
 *  - 冷却到期自动半开：下一次放行即探活，成功即闭合
 */
export class CircuitBreaker {
  constructor(options = {}) {
    this.threshold = options.threshold ?? 3
    this.burstWindowMs = options.burstWindowMs ?? 300_000
    this.cooldownMs = options.cooldownMs ?? 60_000
    this.quotaCooldownMs = options.quotaCooldownMs ?? 3_600_000
    this.state = new Map()
  }

  _entry(id) {
    let e = this.state.get(id)
    if (!e) {
      e = { failures: [], openUntil: 0, kind: null }
      this.state.set(id, e)
    }
    return e
  }

  /** 该后端当前是否处于开断状态。 */
  isOpen(id) {
    const e = this._entry(id)
    if (e.openUntil === 0) return false
    if (Date.now() >= e.openUntil) {
      e.openUntil = 0
      return false
    }
    return true
  }

  /** 距离冷却结束还有多少毫秒（0 表示未开断）。 */
  remaining(id) {
    const e = this._entry(id)
    if (e.openUntil === 0 || Date.now() >= e.openUntil) return 0
    return e.openUntil - Date.now()
  }

  recordSuccess(id) {
    const e = this._entry(id)
    e.failures = []
    e.openUntil = 0
    e.kind = null
  }

  recordFailure(id, kind = 'transient') {
    const e = this._entry(id)
    const now = Date.now()
    if (kind === 'quota') {
      e.openUntil = now + this.quotaCooldownMs
      e.kind = 'quota'
      return
    }
    if (kind === 'auth') {
      e.openUntil = now + this.quotaCooldownMs
      e.kind = 'auth'
      return
    }
    e.failures = e.failures.filter((t) => now - t < this.burstWindowMs)
    e.failures.push(now)
    if (e.failures.length >= this.threshold) {
      e.openUntil = now + this.cooldownMs
      e.kind = 'transient'
    }
  }

  /** 供状态接口展示。 */
  snapshot() {
    const out = {}
    for (const [id, e] of this.state.entries()) {
      out[id] = {
        open: this.isOpen(id),
        remainingMs: this.remaining(id),
        kind: e.kind,
        recentFailures: e.failures.length,
      }
    }
    return out
  }

  reset() {
    this.state.clear()
  }
}

// ─────────────────────────── 后端实现 ───────────────────────────

/**
 * 后端契约：
 *   { id, label, needsKey, hasKey(cfg), search(cfg, request, signal) }
 *   search 返回 { sources, truncated, content? }
 *   任一后端返回空数组视为「本次不可用」，由上层切下一层。
 */

/** 第 1 层：Tavily（有 key 用 key，无 key 走 keyless 匿名档）。 */
export const tavilyBackend = {
  id: 'tavily',
  label: 'Tavily',
  needsKey: false, // 无 key 也能走 keyless
  hasKey: (cfg) => Boolean(cfg?.apiKey),

  async search(cfg, request, signal, options = {}) {
    const limit = Math.min(request.maxResults ?? cfg?.maxResults ?? 8, 20)
    const headers = { 'content-type': 'application/json', 'user-agent': UA }
    if (cfg?.apiKey) {
      headers.authorization = `Bearer ${cfg.apiKey}`
    } else {
      headers['x-tavily-access-mode'] = 'keyless'
    }
    const body = {
      query: request.query,
      max_results: limit,
      search_depth: cfg?.depth === 'advanced' ? 'advanced' : 'basic',
    }
    if (cfg?.includeDomains?.length) body.include_domains = cfg.includeDomains
    const data = await fetchJson('https://api.tavily.com/search', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, signal, options.timeoutMs)

    const sources = (data.results ?? []).map((r) => ({
      url: r.url,
      ...(r.title ? { title: r.title } : {}),
      ...(r.content ? { snippet: String(r.content).slice(0, 500) } : {}),
      ...(r.published_date ? { publishedAt: r.published_date } : {}),
    })).filter((s) => s.url)

    return {
      sources,
      truncated: sources.length >= limit,
      // Tavily 若给了 answer 就带上（模型仍能看到 sources）
      ...(data.answer ? { content: String(data.answer) } : {}),
    }
  },
}

/** 第 2 层：DeepSeek 官方 Search API（按次计费）。 */
export const deepseekBackend = {
  id: 'deepseek',
  label: 'DeepSeek Search API',
  needsKey: true,
  hasKey: (cfg) => Boolean(cfg?.apiKey),

  async search(cfg, request, signal, options = {}) {
    if (!cfg?.apiKey) {
      throw new SearchTierError('DeepSeek 层未配置 apiKey', 'auth', 'WEB_PROVIDER_CREDENTIAL_MISSING')
    }
    const base = (cfg.baseURL || 'https://api.deepseek.com').replace(/\/+$/, '')
    const limit = Math.min(Math.max(request.maxResults ?? cfg?.maxResults ?? 8, 1), 50)
    const body = {
      query: request.query,
      count: limit,
      // 让 DeepSeek 顺带返回长摘要（600-800 字符），模型可读
      need_content: cfg?.needContent === true,
    }
    if (cfg?.oriQuestion) body.ori_question = cfg.oriQuestion
    const data = await fetchJson(`${base}/v1/tools/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
        'user-agent': UA,
      },
      body: JSON.stringify(body),
    }, signal, options.timeoutMs)

    const sources = (data.results ?? []).map((r) => ({
      url: r.url,
      ...(r.title ? { title: r.title } : {}),
      // summary 是 600-800 字符的长摘要，优先给模型；没有再退回 snippet
      ...(r.summary ? { snippet: String(r.summary).slice(0, 800) }
        : r.snippet ? { snippet: String(r.snippet).slice(0, 300) } : {}),
      ...(r.date ? { publishedAt: r.date } : {}),
    })).filter((s) => s.url)

    return { sources, truncated: sources.length >= limit }
  },
}

// ─────────────────────────── Fetch 后端 ───────────────────────────

/** 本 fetch provider 在 ctx.web 里的 id。 */
export const FETCH_TIER_PROVIDER_ID = 'fetch-tier'

/**
 * 把 HTML 粗略转成纯文本。
 *
 * 不做完整解析 —— 目的只是让模型能读懂正文，不是精确还原。
 * 依次去掉：script/style/注释 → 标签 → HTML 实体 → 压缩空白。
 */
export function htmlToText(html) {
  return String(html)
    // 整块丢弃不可见内容
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // 块级标签换行，避免整页粘成一行
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // 其余标签直接剔除
    .replace(/<[^>]+>/g, ' ')
    // 常见实体
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => {
      const n = Number(d)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '
    })
    // 压缩空白
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 从 HTML 里尽力取出标题（<title> 或 og:title）。
 * 取不到返回空串，不抛错。
 */
export function extractTitle(html) {
  const text = String(html)
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(text)
  if (og) return og[1].trim()
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)
  return t ? htmlToText(t[1]).slice(0, 200) : ''
}

/** 第 1 层：DeepSeek Fetch API（POST /v1/tools/fetch，返回 Markdown）。 */
export const deepseekFetchBackend = {
  id: 'deepseek-fetch',
  label: 'DeepSeek Fetch API',
  needsKey: true,
  hasKey: (cfg) => Boolean(cfg?.apiKey),

  async fetch(cfg, request, signal, options = {}) {
    if (!cfg?.apiKey) {
      throw new SearchTierError('DeepSeek Fetch 层未配置 apiKey', 'auth', 'WEB_PROVIDER_CREDENTIAL_MISSING')
    }
    const base = (cfg.baseURL || 'https://api.deepseek.com').replace(/\/+$/, '')
    const data = await fetchJson(`${base}/v1/tools/fetch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
        'user-agent': UA,
      },
      body: JSON.stringify({ url: request.url }),
    }, signal, options.timeoutMs)

    // 官方契约：成功时 content 为页面 Markdown 正文
    const content = typeof data?.content === 'string' ? data.content : ''
    if (!content) {
      throw new SearchTierError('DeepSeek Fetch 返回空正文', 'transient')
    }
    return {
      url: request.url,
      statusCode: 200,
      body: { kind: 'text', content },
      truncated: false,
    }
  },
}

/** 第 2 层：直连抓取（零成本兜底，HTML → 纯文本）。 */
export const directFetchBackend = {
  id: 'direct',
  label: '直连抓取',
  needsKey: false,
  hasKey: () => true,

  async fetch(cfg, request, signal, options = {}) {
    const ctrl = new AbortController()
    const timeoutMs = options.timeoutMs ?? 20000
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
    const onAbort = () => ctrl.abort(signal?.reason)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    try {
      const resp = await fetch(request.url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'user-agent': cfg?.userAgent || UA,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: ctrl.signal,
      })
      if (!resp.ok) {
        throw new SearchTierError(
          `${request.url} -> HTTP ${resp.status}`,
          classify(resp.status),
        )
      }
      const contentType = resp.headers.get('content-type') || ''
      const raw = await resp.text()
      // 非 HTML 直接原样返回；HTML 则转纯文本
      const isHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw)
      const content = isHtml ? htmlToText(raw) : raw
      if (!content) {
        throw new SearchTierError('直连抓取得到空正文', 'transient')
      }
      const title = isHtml ? extractTitle(raw) : ''
      return {
        url: request.url,
        statusCode: resp.status,
        ...(title ? { title } : {}),
        body: { kind: 'text', content },
        truncated: false,
      }
    } catch (error) {
      if (error instanceof SearchTierError) throw error
      throw new SearchTierError(
        `${request.url} -> ${error?.message ?? String(error)}`,
        'transient',
      )
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  },
}

// ─────────────────────────── provider ───────────────────────────

/**
 * 两级搜索 provider。
 * 实现 ctx.web 的 search provider 契约：{ id, available(), search(request, signal) }
 */
export class SearchTierProvider {
  /**
   * @param {() => object} readConfig 每次调用返回最新配置（行内 + settings 覆盖）
   * @param {CircuitBreaker} breaker 熔断器
   */
  constructor(readConfig, breaker = new CircuitBreaker()) {
    this.readConfig = readConfig
    this.breaker = breaker
    this.backends = { tavily: tavilyBackend, deepseek: deepseekBackend }
    /** 最近一次成功的后端 id，供状态接口展示。 */
    this.lastWinner = null
    /** 每个后端最近的错误，供状态接口展示。 */
    this.lastErrors = {}
  }

  get id() {
    return SEARCH_TIER_PROVIDER_ID
  }

  /** 归一化配置：决定层级顺序与各层参数。 */
  cfg() {
    const raw = this.readConfig?.() ?? {}
    const tavily = raw.tavily ?? {}
    const deepseek = raw.deepseek ?? {}
    // 顺序：默认先 tavily 后 deepseek；配置里可调
    const order = Array.isArray(raw.order) && raw.order.length
      ? raw.order.filter((x) => x === 'tavily' || x === 'deepseek')
      : ['tavily', 'deepseek']
    return {
      order: order.length ? order : ['tavily', 'deepseek'],
      tavily,
      deepseek,
      timeoutMs: raw.timeoutMs ?? 20000,
      // 是否在上一层返回空结果时也切换
      failOnEmpty: raw.failOnEmpty !== false,
    }
  }

  /** 至少有一层可用，provider 才算 available。 */
  available() {
    const c = this.cfg()
    // Tavily 无 key 也可（keyless），所以按「未被熔断」判断
    for (const id of c.order) {
      if (this.breaker.isOpen(id)) continue
      const backend = this.backends[id]
      const layerCfg = c[id]
      if (!backend) continue
      if (backend.needsKey && !backend.hasKey(layerCfg)) continue
      return true
    }
    return false
  }

  /**
   * 依次尝试各层。
   * @returns {{sources: Array, truncated: boolean, content?: string}}
   */
  async search(request, signal) {
    const c = this.cfg()
    const attempts = []

    for (const id of c.order) {
      const backend = this.backends[id]
      if (!backend) continue
      const layerCfg = c[id] ?? {}

      // 缺 key 的必需层直接跳过
      if (backend.needsKey && !backend.hasKey(layerCfg)) {
        attempts.push({ id, outcome: 'skipped-no-key' })
        continue
      }
      // 熔断开断则跳过
      if (this.breaker.isOpen(id)) {
        attempts.push({ id, outcome: 'skipped-open', remainingMs: this.breaker.remaining(id) })
        continue
      }

      try {
        const result = await backend.search(layerCfg, request, signal, { timeoutMs: c.timeoutMs })
        const empty = !result.sources || result.sources.length === 0
        if (empty && c.failOnEmpty) {
          attempts.push({ id, outcome: 'empty' })
          this.lastErrors[id] = 'empty result'
          continue // 本次直接切下一层，不计入熔断失败
        }
        this.breaker.recordSuccess(id)
        this.lastWinner = id
        this.lastErrors[id] = null
        return {
          ...result,
          // 把实际用的层带进 meta，便于前端/日志排查
          __layer: id,
          __attempts: attempts,
        }
      } catch (error) {
        if (signal?.aborted) throw error
        const kind = error?.kind ?? 'transient'
        attempts.push({ id, outcome: `error:${kind}`, message: String(error?.message ?? error).slice(0, 200) })
        this.lastErrors[id] = String(error?.message ?? error).slice(0, 240)
        // auth 类不冷却（配置问题，冷却没用）；quota / transient 冷却
        if (kind !== 'auth') this.breaker.recordFailure(id, kind)
        continue // 切下一层
      }
    }

    // 所有层都失败
    const detail = attempts.map((a) => `${a.id}=${a.outcome}`).join('; ')
    throw new SearchTierError(
      `所有搜索层均失败（${detail}）`,
      'transient',
      'WEB_PROVIDER_ERROR',
    )
  }

  /** 状态快照，供诊断/设置页展示。 */
  status() {
    const c = this.cfg()
    return {
      providerId: SEARCH_TIER_PROVIDER_ID,
      order: c.order,
      lastWinner: this.lastWinner,
      layers: c.order.map((id) => ({
        id,
        label: this.backends[id]?.label ?? id,
        hasKey: this.backends[id]?.hasKey(c[id] ?? {}) ?? false,
        needsKey: this.backends[id]?.needsKey ?? false,
        open: this.breaker.isOpen(id),
        remainingMs: this.breaker.remaining(id),
        lastError: this.lastErrors[id] ?? null,
      })),
      breaker: this.breaker.snapshot(),
    }
  }
}

// ─────────────────────────── fetch provider ───────────────────────────

/**
 * 两级抓取 provider。
 * 实现 ctx.web 的 fetch provider 契约：{ id, available(), fetch(request, signal) }
 *
 * 与搜索 provider 分开的理由：抓取和搜索的可用性判断不同 —— 搜索有 3 条规则
 * （空结果切层），抓取只要成功拿到正文就算成功。
 */
export class FetchTierProvider {
  /**
   * @param {() => object} readConfig 每次调用返回最新配置
   * @param {CircuitBreaker} breaker 熔断器（与搜索共用，按 backend id 分桶）
   */
  constructor(readConfig, breaker = new CircuitBreaker()) {
    this.readConfig = readConfig
    this.breaker = breaker
    this.backends = { 'deepseek-fetch': deepseekFetchBackend, direct: directFetchBackend }
    /** 最近一次成功的后端 id，供状态接口展示。 */
    this.lastWinner = null
    /** 每个后端最近的错误，供状态接口展示。 */
    this.lastErrors = {}
  }

  get id() {
    return FETCH_TIER_PROVIDER_ID
  }

  /** 归一化配置：决定层级顺序与各层参数。 */
  cfg() {
    const raw = this.readConfig?.() ?? {}
    const direct = raw.direct ?? {}
    const deepseek = raw.deepseek ?? {}
    // 顺序：默认先 deepseek（返回干净 Markdown），失败再直连
    const order = Array.isArray(raw.fetchOrder) && raw.fetchOrder.length
      ? raw.fetchOrder.filter((x) => x === 'deepseek-fetch' || x === 'direct')
      : ['deepseek-fetch', 'direct']
    return {
      order: order.length ? order : ['deepseek-fetch', 'direct'],
      'deepseek-fetch': deepseek,
      direct,
      timeoutMs: raw.fetchTimeoutMs ?? raw.timeoutMs ?? 20000,
    }
  }

  /** 至少有一层可用，provider 才算 available。 */
  available() {
    const c = this.cfg()
    for (const id of c.order) {
      if (this.breaker.isOpen(id)) continue
      const backend = this.backends[id]
      if (!backend) continue
      if (backend.needsKey && !backend.hasKey(c[id])) continue
      return true
    }
    return false
  }

  /**
   * 依次尝试各层。
   * @returns {{url: string, statusCode: number, body: {kind: 'text', content: string}, truncated: boolean}}
   */
  async fetch(request, signal) {
    const c = this.cfg()
    const attempts = []

    for (const id of c.order) {
      const backend = this.backends[id]
      if (!backend) continue
      const layerCfg = c[id] ?? {}

      // 缺 key 的必需层直接跳过
      if (backend.needsKey && !backend.hasKey(layerCfg)) {
        attempts.push({ id, outcome: 'skipped-no-key' })
        continue
      }
      // 熔断开断则跳过
      if (this.breaker.isOpen(id)) {
        attempts.push({ id, outcome: 'skipped-open', remainingMs: this.breaker.remaining(id) })
        continue
      }

      try {
        const result = await backend.fetch(layerCfg, request, signal, { timeoutMs: c.timeoutMs })
        this.breaker.recordSuccess(id)
        this.lastWinner = id
        this.lastErrors[id] = null
        return result
      } catch (error) {
        if (signal?.aborted) throw error
        const kind = error?.kind ?? 'transient'
        attempts.push({ id, outcome: `error:${kind}`, message: String(error?.message ?? error).slice(0, 200) })
        this.lastErrors[id] = String(error?.message ?? error).slice(0, 240)
        // auth 类不冷却（配置问题，冷却没用）；quota / transient 冷却
        if (kind !== 'auth') this.breaker.recordFailure(id, kind)
        continue // 切下一层
      }
    }

    // 所有层都失败
    const detail = attempts.map((a) => `${a.id}=${a.outcome}`).join('; ')
    throw new SearchTierError(
      `所有抓取层均失败（${detail}）`,
      'transient',
      'WEB_PROVIDER_ERROR',
    )
  }

  /** 状态快照，供诊断/设置页展示。 */
  status() {
    const c = this.cfg()
    return {
      providerId: FETCH_TIER_PROVIDER_ID,
      order: c.order,
      lastWinner: this.lastWinner,
      layers: c.order.map((id) => ({
        id,
        label: this.backends[id]?.label ?? id,
        hasKey: this.backends[id]?.hasKey(c[id] ?? {}) ?? false,
        needsKey: this.backends[id]?.needsKey ?? false,
        open: this.breaker.isOpen(id),
        remainingMs: this.breaker.remaining(id),
        lastError: this.lastErrors[id] ?? null,
      })),
    }
  }
}

// ─────────────────────────── 插件入口 ───────────────────────────

export const name = 'search-tier'
export const inject = ['web']

export function apply(ctx, config) {
  const inlineConfig = config ?? {}
  const breaker = new CircuitBreaker(inlineConfig.breaker ?? {})

  /**
   * 给某个后端的 cfg 补上密钥兜底。
   *
   * ⚠️ 为什么需要这个（2026-10-20）：
   *   本文件随插件发布，patch 里的 apiKey 一旦写了就会被公开。
   *   所以密钥不能写在 patch 里 —— 改从环境变量读取。
   *
   * 读取顺序（先到先得）：
   *   ① patch 配置里的 apiKey（本机覆盖时用；发布版留空）
   *   ② 环境变量 DEEPSEEK_API_KEY / TAVILY_API_KEY
   */
  function withKey(cfg, envName) {
    if (!cfg) return cfg
    if (cfg.apiKey) return cfg
    const fromEnv = typeof process !== 'undefined' ? process.env?.[envName] : undefined
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
      return { ...cfg, apiKey: fromEnv.trim() }
    }
    return cfg
  }

  // 每次 search/fetch 实时读配置；密钥缺省时从环境变量补
  const readConfig = () => {
    const c = inlineConfig
    return {
      ...c,
      deepseek: withKey(c.deepseek, 'DEEPSEEK_API_KEY'),
      tavily: withKey(c.tavily, 'TAVILY_API_KEY'),
    }
  }

  const provider = new SearchTierProvider(readConfig, breaker)
  const fetcher = new FetchTierProvider(readConfig, new CircuitBreaker(inlineConfig.breaker ?? {}))

  // 注册到 ctx.web 的两个接缝：搜索 + 抓取
  ctx.web.registerSearchProvider(provider)

  let fetchRegistered = false
  if (typeof ctx.web.registerFetchProvider === 'function') {
    ctx.web.registerFetchProvider(fetcher)
    fetchRegistered = true
  }

  // 暴露一个只读诊断工具，方便 AI 自己排查哪层挂了
  const tools = ctx.get?.('tools')
  if (tools && typeof tools.defineTool === 'function') {
    try {
      tools.defineTool({
        name: 'search_tier_status',
        description: '查看两级搜索（Tavily → DeepSeek）与两级抓取（DeepSeek Fetch → 直连）的当前状态：各层是否被熔断、最近错误、上次成功用的是哪层。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => JSON.stringify({
          search: provider.status(),
          fetch: fetchRegistered ? fetcher.status() : { registered: false, reason: 'ctx.web.registerFetchProvider 不可用' },
        }, null, 1),
      })
    } catch {
      // 工具注册失败不影响搜索/抓取
    }
  }

  ctx.on?.('dispose', () => {
    breaker.reset()
  })
}
