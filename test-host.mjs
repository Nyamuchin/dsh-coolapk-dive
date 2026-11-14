/**
 * 主机端自测：用一个假的 ctx 跑 apply()，验证工具注册、工具执行、HTTP 路由。
 * 不依赖 Harness 运行时，直接 node 跑。
 */
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const registered = []
const effects = []
const logs = []

const fakeCtx = {
  tools: {
    register(def) {
      registered.push(def)
      return () => {}
    },
  },
  effect(fn, label) {
    effects.push({ label })
    const dispose = typeof fn === 'function' ? fn() : undefined
    if (typeof dispose === 'function') effects.push({ label: label + ':dispose' })
    return () => {}
  },
  // 模仿真实 Cordis：没有写进 inject 的服务，属性访问会直接抛错。
  // 这样能提前抓到 `ctx.settings` 这种「不 inject 就访问」的 bug。
  get(name) {
    if (name === 'webServer') return fakeWeb
    if (name === 'settings') return { register() {} }
    if (name === 'tools') return fakeCtx.tools
    return undefined
  },
  inject(names, cb) {
    if (names.includes('webServer')) cb({ webServer: fakeWeb })
  },
}

let handler = null
const fakeWeb = {
  register(route) {
    handler = route.handler
    return () => {}
  },
}

const mod = await import('./index.js')
const { readConfig, writeConfig } = await import('./lib/config.mjs')
const configBackup = readConfig()
console.log('module name =', mod.name, '| inject =', JSON.stringify(mod.inject), '| Config =', typeof mod.Config)

mod.apply(fakeCtx, {})
await new Promise((r) => setTimeout(r, 300))

console.log('registered tools =', registered.map((t) => t.name).join(', '))
for (const t of registered) {
  console.log(`  ${t.name}: params=${JSON.stringify(Object.keys(t.parameters || {}))} required=${JSON.stringify(t.parameters?.required || [])}`)
}

// ── 直接跑工具 ───────────────────────────────────────────────────────────────
const search = registered.find((t) => t.name === 'coolapk_search')
const read = registered.find((t) => t.name === 'coolapk_read')

const exec = { signal: undefined, deferContext() {}, concludeTurn() {} }

const s1 = await search.execute({ q: '耳机', page: 1 }, exec)
console.log('\n[search] ok=', s1.ok, 'count=', s1.count, 'total=', s1.total, 'ids=', s1.ids.slice(0, 3))
console.log('[search] markdown head:\n' + String(s1.markdown).split('\n').slice(0, 6).join('\n'))

const s2 = await search.execute({ q: '耳机', page: 1 }, exec)
console.log('[search cached] cached=', s2.cached)

const bad = await search.execute({ q: '' }, exec)
console.log('[search empty q] ok=', bad.ok, 'error=', bad.error)

const id = s1.ids.find((x) => x) || '74358577'
const r1 = await read.execute({ id }, exec)
console.log('\n[read] ok=', r1.ok, 'title=', r1.title, 'author=', r1.author, 'images=', r1.images?.length, 'stats=', JSON.stringify(r1.imageStats))
console.log('[read] first image:', JSON.stringify(r1.images?.[0]))
console.log('[read] markdown head:\n' + String(r1.markdown).split('\n').slice(0, 8).join('\n'))

const r2 = await read.execute({ id: 'https://www.coolapk.com/feed/74358577?s=abc123' }, exec)
console.log('[read from url] ok=', r2.ok, 'id=', r2.id, 'cached=', r2.cached)

const r3 = await read.execute({ id: 'not-an-id' }, exec)
console.log('[read bad id] ok=', r3.ok, 'error=', r3.error)

// ── 跑 HTTP 路由 ─────────────────────────────────────────────────────────────
if (!handler) {
  console.log('\n!! webServer handler 没挂上')
} else {
  const server = http.createServer((req, res) => handler(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/api/coolapk-dive`
  const j = async (p, init) => {
    const res = await fetch(base + p, { headers: { host: `127.0.0.1:${port}` }, ...init })
    return { status: res.status, body: await res.json() }
  }
  console.log('\n[GET /state]', JSON.stringify((await j('/state')).body).slice(0, 300))
  const test = await j('/test?q=耳机', { method: 'POST', body: '{}' })
  console.log('[POST /test]', JSON.stringify(test.body))
  const cfg = await j('/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageSize: 5 }) })
  console.log('[POST /config]', JSON.stringify(cfg.body))
  const cfg2 = await j('/config')
  console.log('[GET /config pageSize]', cfg2.body.config?.pageSize)
  const cc = await j('/cache/clear', { method: 'POST', body: '{}' })
  console.log('[POST /cache/clear]', JSON.stringify(cc.body))
  const nf = await j('/nope')
  console.log('[GET /nope]', nf.status, JSON.stringify(nf.body))
  // 跨站请求应被拒
  const res403 = await fetch(base + '/state', { headers: { origin: 'https://evil.example', host: `127.0.0.1:${port}` } })
  console.log('[cross-origin]', res403.status)
  server.close()
}

console.log('\nEFFECTS:', effects.map((e) => e.label).join(' | '))

// 测试会改真实配置（pageSize），跑完还原
writeConfig(configBackup)
console.log('配置已还原：pageSize =', readConfig().pageSize)
process.exit(0)
