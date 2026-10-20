// 离线自测：不依赖 DSH 运行时，验证核心逻辑与真实 API 调用
import {
  SearchTierProvider, CircuitBreaker, SearchTierError,
  tavilyBackend, deepseekBackend, classify, SEARCH_TIER_PROVIDER_ID,
} from '../lib/index.js'

const line = (s) => console.log(s)
const ok = (s) => console.log('  [OK  ] ' + s)
const bad = (s) => console.log('  [FAIL] ' + s)
let pass = 0, fail = 0
const check = (cond, label, extra = '') => {
  if (cond) { ok(label + (extra ? '  ' + extra : '')); pass++ }
  else { bad(label + (extra ? '  ' + extra : '')); fail++ }
}

line('='.repeat(74))
line('一、错误分类 classify()')
line('='.repeat(74))
check(classify(429) === 'quota', '429 -> quota')
check(classify(402) === 'quota', '402 -> quota')
check(classify(401) === 'auth', '401 -> auth')
check(classify(403) === 'auth', '403 -> auth')
check(classify(500) === 'transient', '500 -> transient')
check(classify(200, 'insufficient credit') === 'quota', '文本 insufficient -> quota')
check(classify(200, '') === 'transient', '默认 -> transient')

line('')
line('='.repeat(74))
line('二、熔断器 CircuitBreaker')
line('='.repeat(74))
{
  const b = new CircuitBreaker({ threshold: 3, cooldownMs: 60_000, quotaCooldownMs: 3_600_000 })
  check(!b.isOpen('x'), '初始闭合')
  b.recordFailure('x', 'transient')
  check(!b.isOpen('x'), '1次瞬时故障：仍闭合')
  b.recordFailure('x', 'transient')
  check(!b.isOpen('x'), '2次瞬时故障：仍闭合')
  b.recordFailure('x', 'transient')
  check(b.isOpen('x'), '3次瞬时故障：开断')
  check(b.remaining('x') > 0, '有剩余冷却时间', Math.round(b.remaining('x') / 1000) + 's')
  b.recordSuccess('x')
  check(!b.isOpen('x'), '成功后闭合')
}
{
  const b = new CircuitBreaker({ quotaCooldownMs: 3_600_000 })
  b.recordFailure('q', 'quota')
  check(b.isOpen('q'), '额度耗尽：立即开断')
  const rem = b.remaining('q')
  check(rem > 3_500_000, '额度冷却约 1 小时', Math.round(rem / 60000) + 'min')
}
{
  // 半开验证：用短暂停的 quota 冷却（不是默认 1 小时）
  const b = new CircuitBreaker({ quotaCooldownMs: 50 })
  b.recordFailure('t', 'quota')
  check(b.isOpen('t'), '开断中')
  await new Promise((r) => setTimeout(r, 80))
  check(!b.isOpen('t'), '冷却到期自动半开')
}

line('')
line('='.repeat(74))
line('三、provider 基本契约')
line('='.repeat(74))
{
  const p = new SearchTierProvider(() => ({ tavily: {}, deepseek: { apiKey: '' } }))
  check(p.id === SEARCH_TIER_PROVIDER_ID, 'id = ' + SEARCH_TIER_PROVIDER_ID)
  check(typeof p.available === 'function', '有 available()')
  check(typeof p.search === 'function', '有 search()')
  check(p.available() === true, 'Tavily 无 key 也可用（keyless）')
  const st = p.status()
  check(Array.isArray(st.layers) && st.layers.length === 2, 'status 有 2 层')
  check(st.order.join('>') === 'tavily>deepseek', '默认顺序 tavily > deepseek')
}
{
  // deepseek 层缺 key 应被跳过
  const p = new SearchTierProvider(() => ({ tavily: {}, deepseek: {} }))
  check(p.status().layers[1].hasKey === false, 'deepseek 未配 key -> hasKey=false')
}

line('')
line('='.repeat(74))
line('四、真实调用第 1 层：Tavily keyless')
line('='.repeat(74))
{
  const p = new SearchTierProvider(() => ({
    order: ['tavily', 'deepseek'],
    tavily: { maxResults: 5 },
    deepseek: { apiKey: '' },
    timeoutMs: 25000,
  }))
  try {
    const r = await p.search({ query: 'DeepSeek Harness', maxResults: 5 }, undefined)
    const n = r.sources?.length ?? 0
    check(n > 0, 'Tavily 返回结果', n + ' 条')
    if (n > 0) {
      line('       首条: ' + (r.sources[0].title ?? '(无标题)').slice(0, 50))
      line('       URL : ' + (r.sources[0].url ?? '').slice(0, 60))
      check(Boolean(r.sources[0].url), '结果含 url')
      check(Boolean(r.sources[0].snippet), '结果含 snippet')
    }
    check(r.__layer === 'tavily', '实际命中层 = tavily')
    check(p.lastWinner === 'tavily', 'lastWinner 记录正确')
  } catch (e) {
    bad('Tavily 调用异常: ' + e.message.slice(0, 160))
    fail++
  }
}

line('')
line('='.repeat(74))
line('五、降级逻辑：第 1 层被熔断 -> 应跳过并尝试第 2 层')
line('='.repeat(74))
{
  const breaker = new CircuitBreaker({ quotaCooldownMs: 3_600_000 })
  breaker.recordFailure('tavily', 'quota') // 手动把第 1 层打开
  const p = new SearchTierProvider(() => ({
    order: ['tavily', 'deepseek'],
    tavily: { maxResults: 5 },
    deepseek: { apiKey: '' },   // 故意不放 key，验证「跳过 -> 全失败」路径
    timeoutMs: 8000,
  }), breaker)
  check(breaker.isOpen('tavily'), '第 1 层已开断')
  check(p.available() === false, '两层都不可用 -> available=false')
  try {
    await p.search({ query: 'test', maxResults: 3 }, undefined)
    bad('应该抛错但没抛')
    fail++
  } catch (e) {
    const msg = String(e.message)
    check(e instanceof SearchTierError, '抛出 SearchTierError')
    check(msg.includes('tavily=skipped-open'), '跳过原因含 skipped-open')
    check(msg.includes('deepseek=skipped-no-key'), '第 2 层含 skipped-no-key')
    line('       错误信息: ' + msg.slice(0, 120))
  }
}

line('')
line('='.repeat(74))
line('六、空结果应切下一层（failOnEmpty）')
line('='.repeat(74))
{
  // 用一个必然返回空的自定义 backend 模拟
  const p = new SearchTierProvider(() => ({
    order: ['tavily', 'deepseek'],
    tavily: { maxResults: 5 },
    deepseek: { apiKey: 'dummy' },
    timeoutMs: 5000,
    failOnEmpty: true,
  }))
  // 让 tavily 返回空：临时替换其实现
  const orig = tavilyBackend.search
  tavilyBackend.search = async () => ({ sources: [], truncated: false })
  try {
    await p.search({ query: 'x', maxResults: 3 }, undefined)
    bad('应因空结果而继续切层并最终失败')
    fail++
  } catch (e) {
    check(String(e.message).includes('tavily=empty'), '空结果记为 empty 并切层')
  } finally {
    tavilyBackend.search = orig
  }
}

line('')
line('='.repeat(74))
line('七、Fetch 层：契约与 failover')
line('='.repeat(74))
{
  const { FetchTierProvider, FETCH_TIER_PROVIDER_ID, deepseekFetchBackend, directFetchBackend } =
    await import('../lib/index.js')

  check(FETCH_TIER_PROVIDER_ID === 'fetch-tier', 'FETCH_TIER_PROVIDER_ID 正确')

  // provider id
  const fp = new FetchTierProvider(() => ({
    fetchOrder: ['deepseek-fetch', 'direct'],
    deepseek: {},
    timeoutMs: 8000,
  }))
  check(fp.id === 'fetch-tier', 'provider.id = fetch-tier')

  // 无 deepseek key 时仍可用（direct 层兜底）
  check(fp.available() === true, '无 deepseek key 时 direct 层兜底，available = true')

  // 配置归一化
  const c = fp.cfg()
  check(c.order.join(',') === 'deepseek-fetch,direct', '默认顺序 deepseek-fetch -> direct', c.order.join('>'))

  // 两层后端的契约形状
  check(typeof deepseekFetchBackend.fetch === 'function', 'deepseekFetchBackend 有 fetch()')
  check(deepseekFetchBackend.needsKey === true, 'deepseekFetchBackend 需要 key')
  check(typeof directFetchBackend.fetch === 'function', 'directFetchBackend 有 fetch()')
  check(directFetchBackend.needsKey === false, 'directFetchBackend 不需要 key')

  // 熔断：让 direct 层连续失败 3 次后开断
  const fb = new CircuitBreaker({ threshold: 3, cooldownMs: 60_000 })
  fb.recordFailure('direct', 'transient')
  fb.recordFailure('direct', 'transient')
  check(!fb.isOpen('direct'), 'direct 故障 2 次：仍闭合')
  fb.recordFailure('direct', 'transient')
  check(fb.isOpen('direct'), 'direct 故障 3 次：开断')

  // 全部层不可用时应抛错并列出各层原因
  const fp2 = new FetchTierProvider(() => ({
    fetchOrder: ['deepseek-fetch', 'direct'],
    deepseek: {},           // 无 key -> skipped-no-key
    timeoutMs: 3000,
  }))
  // 手动把 direct 也熔断
  const origDirect = directFetchBackend.fetch
  const origDeep = deepseekFetchBackend.fetch
  directFetchBackend.fetch = async () => { throw new SearchTierError('模拟失败', 'transient') }
  deepseekFetchBackend.fetch = async () => { throw new SearchTierError('模拟失败', 'transient') }
  try {
    // 用自定义 breaker 把两层都打开
    const fbAll = new CircuitBreaker({ threshold: 1, cooldownMs: 60_000 })
    fbAll.recordFailure('direct', 'transient')
    fbAll.recordFailure('deepseek-fetch', 'transient')
    const fp3 = new FetchTierProvider(() => ({ fetchOrder: ['deepseek-fetch', 'direct'], deepseek: { apiKey: 'x' } }), fbAll)
    check(fp3.available() === false, '两层都熔断时 available = false')
    try {
      await fp3.fetch({ url: 'https://example.com' }, undefined)
      check(false, '两层都熔断时应抛错')
    } catch (e) {
      check(String(e.message).includes('所有抓取层均失败'), '两层都熔断时抛 SearchTierError')
      check(String(e.message).includes('skipped-open'), '错误信息含 skipped-open')
    }
  } finally {
    directFetchBackend.fetch = origDirect
    deepseekFetchBackend.fetch = origDeep
  }
}

line('')
line('='.repeat(74))
line('八、Fetch 层：真实调用')
line('='.repeat(74))
{
  const { FetchTierProvider } = await import('../lib/index.js')
  const fs = await import('node:fs')
  // 取 DeepSeek key 用于真实调用（只读，绝不打印）
  //
  // 优先环境变量；其次尝试从 DSH 的凭据文件读（路径动态推导，不写死本机路径）。
  let key = (process.env.DEEPSEEK_API_KEY || '').trim()
  if (!key) {
    try {
      const os = await import('node:os')
      const path = await import('node:path')
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
      const cred = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8')
      const m = /DEEPSEEK_API_KEY\s*:\s*['"]?(sk-[A-Za-z0-9_-]+)/.exec(cred)
      if (m) key = m[1]
    } catch { /* 无凭据则跳过真实调用 */ }
  }

  if (!key) {
    line('  [SKIP] 未找到 DEEPSEEK_API_KEY，跳过真实 Fetch 调用')
  } else {
    const fp = new FetchTierProvider(() => ({
      fetchOrder: ['deepseek-fetch', 'direct'],
      deepseek: { apiKey: key, baseURL: 'https://api.deepseek.com' },
      timeoutMs: 30000,
    }))
    try {
      const r = await fp.fetch({ url: 'https://example.com' })
      check(r.url === 'https://example.com', '返回 url 与请求一致')
      check(r.statusCode === 200, 'statusCode = 200')
      check(r.body?.kind === 'text', 'body.kind = text')
      check((r.body?.content ?? '').length > 50, 'content 非空', `${(r.body?.content ?? '').length} 字符`)
      check(fp.status().lastWinner === 'deepseek-fetch', '命中 deepseek-fetch 层')
    } catch (e) {
      bad('真实 Fetch 调用失败: ' + String(e.message).slice(0, 150))
      fail++
    }
  }
}

line('')
line('='.repeat(74))
line(`结果：通过 ${pass}   失败 ${fail}`)
line('='.repeat(74))
process.exit(fail === 0 ? 0 : 1)
