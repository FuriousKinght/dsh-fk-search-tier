// 端到端模拟：第 1 层失败 -> 第 2 层接手
import { SearchTierProvider, CircuitBreaker, tavilyBackend, deepseekBackend } from '../lib/index.js'

const line = (s) => console.log(s)

line('='.repeat(76))
line('端到端：模拟 Tavily 额度耗尽 -> 自动切 DeepSeek')
line('='.repeat(76))
line('')

// 第 2 层用 mock，避免真实扣费
const origDs = deepseekBackend.search
let dsCalled = 0
deepseekBackend.search = async (cfg, req) => {
  dsCalled++
  line('  [DeepSeek] 被调用，query = ' + req.query)
  return {
    sources: [
      { url: 'https://example.com/a', title: 'DeepSeek 兜底结果 A', snippet: '这是第 2 层返回的结果' },
      { url: 'https://example.com/b', title: 'DeepSeek 兜底结果 B', snippet: '同样来自第 2 层' },
    ],
    truncated: false,
  }
}

// 第 1 层模拟 429
const origTv = tavilyBackend.search
let tvCalled = 0
tavilyBackend.search = async () => {
  tvCalled++
  line('  [Tavily] 被调用 -> 模拟返回 429 额度耗尽')
  const e = new Error('Tavily -> HTTP 429: rate limit exceeded')
  e.kind = 'quota'
  throw e
}

const breaker = new CircuitBreaker({ quotaCooldownMs: 3_600_000 })
const p = new SearchTierProvider(() => ({
  order: ['tavily', 'deepseek'],
  tavily: {},
  deepseek: { apiKey: 'fake-key-for-mock' },
  timeoutMs: 5000,
}), breaker)

line('--- 第 1 次搜索 ---')
let r = await p.search({ query: '测试查询 1', maxResults: 5 }, undefined)
line('  返回结果数: ' + r.sources.length)
line('  实际命中层: ' + r.__layer)
line('  attempts  : ' + JSON.stringify(r.__attempts))
line('')
line('  Tavily 被调用 ' + tvCalled + ' 次，DeepSeek 被调用 ' + dsCalled + ' 次')
line('  Tavily 熔断状态: ' + (breaker.isOpen('tavily') ? '已开断' : '闭合'))
line('')

line('--- 第 2 次搜索（Tavily 应在熔断期内被跳过）---')
const before = { tv: tvCalled, ds: dsCalled }
r = await p.search({ query: '测试查询 2', maxResults: 5 }, undefined)
line('  返回结果数: ' + r.sources.length)
line('  实际命中层: ' + r.__layer)
line('  attempts  : ' + JSON.stringify(r.__attempts))
line('')
line('  Tavily 新增调用 ' + (tvCalled - before.tv) + ' 次（应为 0，被熔断跳过）')
line('  DeepSeek 新增调用 ' + (dsCalled - before.ds) + ' 次')
line('')

line('--- 状态快照 ---')
line(JSON.stringify(p.status(), null, 1))

// 恢复
tavilyBackend.search = origTv
deepseekBackend.search = origDs

const pass = r.__layer === 'deepseek' && (tvCalled - before.tv) === 0 && dsCalled >= 1
line('')
line('='.repeat(76))
line(pass ? '✅ 端到端验证通过：额度耗尽后自动降级，且熔断期内不再重试第 1 层' : '❌ 验证失败')
line('='.repeat(76))
process.exit(pass ? 0 : 1)
