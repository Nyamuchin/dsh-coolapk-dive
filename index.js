/**
 * dsh-coolapk-dive —— 主机半端
 * ============================================================================
 * 让 AI 在 Harness 里搜酷安、读帖子正文，配图存到本地。
 *
 * 两条前提（都是实测结论，不是猜的）：
 *   1. 网页版没戏：www.coolapk.com 的动态页/话题页一律返回「请用酷安手机APP扫码查看」
 *      占位页，网页搜索接口全 404 —— 所以只能走 api.coolapk.com。
 *   2. 走 API 必须自己算 X-App-Token（v2，bcrypt），v3 需要数字联盟 ID 拿不到。
 *      算法在 lib/api.mjs，bcrypt 已经 vendored 进 lib/bcrypt.mjs，不依赖 npm 装包。
 *
 * 只读插件：不登录、不点赞、不回帖、不收藏。唯一写盘的是配图缓存。
 */
import { defineTool as hostDefineTool } from './lib/toolkit.mjs'
import { CoolapkClient, CoolapkError, newDeviceCode, tokenV2 } from './lib/api.mjs'
import { readConfig, writeConfig, DEFAULTS, baseDir, imageDirAbs } from './lib/config.mjs'
import { MemoryCache } from './lib/cache.mjs'
import { feedImageDir, saveImage, summarizeImageResults } from './lib/images.mjs'
import {
  renderSearchMarkdown,
  renderDetailMarkdown,
  picsOf,
  messageToText,
  feedTitle,
  authorOf,
} from './lib/format.mjs'
import fs from 'node:fs'
import path from 'node:path'

let VERSION = '0.0.0'
try {
  VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
} catch {
  /* ignore */
}

export const name = 'coolapk-dive'

// ⚠️ webServer / settings 都不写进 inject：
//   · headless profile 没有 webServer，写进 inject 会让整个插件 pending、工具全不可用；
//   · settings 在部分 profile 里也可能缺席。
// 只在 apply 里按需 ctx.get / ctx.inject，缺了就少一块功能，工具照常能用。
export const inject = ['tools']

let Config
try {
  const mod = await import('@deepseek-ai/schemastery')
  const z = mod?.default ?? mod
  if (z && typeof z.object === 'function') {
    Config = z.object({
      enabled: z.boolean().default(true).description('启用酷安工具'),
      pageSize: z.number().default(DEFAULTS.pageSize).description('搜索结果每页条数'),
      snippetChars: z.number().default(DEFAULTS.snippetChars).description('搜索结果正文摘要字数'),
      saveImages: z.boolean().default(DEFAULTS.saveImages).description('读帖时把配图下载到本地'),
      maxImages: z.number().default(DEFAULTS.maxImages).description('单帖最多下载几张图'),
      includeComments: z.boolean().default(DEFAULTS.includeComments).description('读帖时带上热门评论'),
      timeoutMs: z.number().default(DEFAULTS.timeoutMs).description('请求超时（毫秒）'),
      minGapMs: z.number().default(DEFAULTS.minGapMs).description('请求最小间隔（毫秒）'),
      cacheSize: z.number().default(DEFAULTS.cacheSize).description('内存缓存条数'),
      cacheTtlSec: z.number().default(DEFAULTS.cacheTtlSec).description('内存缓存存活秒数'),
    })
  }
} catch {
  Config = undefined
}

const log = (msg) => {
  try {
    console.log(`[coolapk-dive] ${msg}`)
  } catch {
    /* ignore */
  }
}

const str = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim())

/** 同源校验：设置页接口只给本机页面用，别让外站页面借浏览器打本地端口 */
function isSameOrigin(origin, host) {
  if (!origin) return true
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export function apply(ctx, pluginConfig) {
  // 配置：磁盘 > 宿主传入 > 默认
  const cfgOf = () => readConfig(pluginConfig)
  let cfg = cfgOf()

  const cache = new MemoryCache({ max: cfg.cacheSize, ttlMs: cfg.cacheTtlSec * 1000 })

  /** 按当前配置造一个 client；配置变了就重建（deviceCode 保持稳定） */
  let deviceCode = newDeviceCode()
  let client = null
  const clientOf = () => {
    const c = cfgOf()
    if (!client || client.timeoutMs !== c.timeoutMs || client.minGapMs !== c.minGapMs) {
      client = new CoolapkClient({
        deviceCode,
        timeoutMs: c.timeoutMs,
        minGapMs: c.minGapMs,
      })
    }
    cache.configure({ max: c.cacheSize, ttlMs: c.cacheTtlSec * 1000 })
    return client
  }

  const errText = (e) => {
    if (e instanceof CoolapkError) {
      const hint =
        e.code === 'TIMEOUT'
          ? '（网络慢或酷安限流，稍后重试或调大超时）'
          : e.code && String(e.code).startsWith('STATUS_')
            ? '（酷安接口拒绝了这次请求，可能是接口变动或风控）'
            : ''
      return `${e.message}${hint}`
    }
    return e?.message || String(e)
  }

  // ── 业务：搜索 ──────────────────────────────────────────────────────────────
  async function doSearch(args) {
    const q = str(args?.q)
    if (!q) throw new Error('缺少关键词 q')
    if (q.length > 100) throw new Error('关键词太长（最多 100 字）')
    const page = Math.max(1, Math.min(Number(args?.page) || 1, 50))
    const c = cfgOf()
    const key = `search:${q}:${page}`
    const cached = cache.get(key)
    if (cached) return { ...cached, cached: true }

    const items = await clientOf().searchFeeds(q, page)
    const shown = items.slice(0, Math.max(1, c.pageSize))
    const total = Number(items[0]?._queryTotal) || 0
    const hasMore = items.length >= shown.length && shown.length > 0 && page < 50
    const markdown = renderSearchMarkdown(shown, {
      q,
      page,
      total,
      hasMore,
    })
    const payload = {
      ok: true,
      markdown,
      query: q,
      page,
      count: shown.length,
      total,
      hasMore,
      ids: shown.map((i) => String(i?.id ?? '')).filter(Boolean),
      cached: false,
    }
    cache.set(key, payload)
    return payload
  }

  // ── 业务：读帖 ──────────────────────────────────────────────────────────────
  async function doRead(args) {
    // 兼容三种输入：纯 id、/feed/<id> 链接、带 ?s= 的分享链接
    const raw = str(args?.id).replace(/^.*?\/feed\//, '').replace(/[?#].*$/, '').replace(/[^0-9a-zA-Z_-]/g, '')
    if (!raw) throw new Error('缺少动态 id（就是搜索结果里那个数字，也可以直接贴 /feed/<id> 链接）')
    // 酷安的动态 id 是纯数字；不先拦住的话会拿 "not-an-id" 去打接口，
    // 酷安只会回一句没头没尾的「请输入查询参数」，用户看不出是自己传错了。
    if (!/^\d{4,}$/.test(raw)) {
      throw new Error(`「${raw}」不像酷安的动态 id —— 它应该是一串纯数字（例如 74358577），可以先用 coolapk_search 搜到`)
    }
    const id = raw
    const c = cfgOf()
    const wantImages = args?.downloadImages === false ? false : c.saveImages
    const key = `detail:${id}`
    const cached = cache.get(key)
    // 命中缓存的前提：要么这次不要图，要么缓存里确实已经把图处理过了
    // （picCount === 0 表示这帖本来就没图，不需要为了图片再打一次接口）
    if (cached && (!wantImages || cached.imagesResolved)) {
      return { ...cached, cached: true }
    }

    const feed = await clientOf().feedDetail(id)
    if (!feed || typeof feed !== 'object') throw new Error(`没拿到动态 ${id}（可能已删除或需要登录）`)

    // 图片：只下载这一帖的配图，失败不阻断正文
    const allPics = picsOf(feed)
    let images = []
    if (wantImages && c.maxImages > 0 && allPics.length) {
      const urls = allPics.slice(0, c.maxImages)
      let dir = null
      try {
        dir = feedImageDir(imageDirAbs(c), id)
      } catch (e) {
        log(`图片目录建不出来：${e?.message ?? e}`)
      }
      if (dir) {
        for (const url of urls) {
          const r = await saveImage(clientOf(), url, { dir, maxBytes: c.maxImageBytes })
          images.push(r.ok ? { url, path: r.path, bytes: r.bytes } : { url, error: r.error })
        }
      }
    }

    const comments = c.includeComments && Array.isArray(feed.topReplyRows) ? feed.topReplyRows.slice(0, 3) : []
    const markdown = renderDetailMarkdown(feed, { images, comments })
    const summary = summarizeImageResults(images.map((i) => (i.error ? { ok: false } : { ok: true, bytes: i.bytes })))
    const payload = {
      ok: true,
      markdown,
      id: String(feed.id ?? id),
      title: feedTitle(feed, messageToText(feed.message)),
      author: authorOf(feed),
      url: typeof feed.url === 'string' ? feed.url : '',
      likes: Number(feed.likenum) || 0,
      replies: Number(feed.replynum) || 0,
      picCount: allPics.length,
      images,
      // 这次到底把图处理完没有：没要图、没图、或者图目录建不出来时都算「处理完了」，
      // 免得同一个帖因为「要图但没图」每次都重新打接口。
      imagesResolved: !wantImages || allPics.length === 0 || images.length > 0 || c.maxImages <= 0,
      imageStats: summary,
      commentCount: comments.length,
      cached: false,
    }
    cache.set(key, payload)
    return payload
  }

  // ── 工具注册 ────────────────────────────────────────────────────────────────
  const tool = (spec) => {
    const wrapped = {
      ...spec,
      execute: async (...a) => {
        try {
          return await spec.execute(...a)
        } catch (e) {
          log(`工具 ${spec.name} 出错：${e?.message ?? e}`)
          throw e
        }
      },
    }
    try {
      const dispose = ctx.tools.register(hostDefineTool(wrapped))
      if (typeof dispose === 'function') ctx.effect(() => dispose, `${name}: tool ${spec.name}`)
    } catch (e) {
      log(`工具 ${spec.name} 没注册上（不影响别的）：${e?.message ?? e}`)
    }
  }

  tool({
    name: 'coolapk_search',
    description:
      '搜索酷安（Coolapk）动态/帖子。返回标题、作者、时间、机型、点赞回复数、正文摘要和动态 id。'
      + '要读全文用 coolapk_read 传 id。分页可用 page 参数（每页 7–10 条，可翻到很老的帖子）。',
    parameters: {
      q: { type: 'string', description: '搜索关键词，例如「原神」「耳机 降噪」「华为 Pura」', required: true },
      page: { type: 'number', description: '第几页，从 1 开始（默认 1）' },
    },
    execute: async (args) => {
      try {
        return await doSearch(args)
      } catch (e) {
        return { ok: false, error: errText(e), markdown: `搜索失败：${errText(e)}` }
      }
    },
  })

  tool({
    name: 'coolapk_read',
    description:
      '读一条酷安动态的完整正文（搜索结果里是截断的），带作者、机型、IP 归属地、点赞回复数、'
      + '配图（默认下载到本地并给出文件路径）和热门评论。参数 id 可以直接给数字或 /feed/<id> 链接。',
    parameters: {
      id: { type: 'string', description: '动态 id（数字），或完整/部分 /feed/<id> 链接', required: true },
      downloadImages: { type: 'boolean', description: '是否把配图下载到本地（默认跟随设置页开关）' },
    },
    execute: async (args) => {
      try {
        return await doRead(args)
      } catch (e) {
        return { ok: false, error: errText(e), markdown: `读帖失败：${errText(e)}` }
      }
    },
  })

  // 宿主设置项（有就挂，没有也不影响 —— 真正的设置在下面自己的 HTTP 接口里）
  //
  // ⚠️ 这里必须用 ctx.get('settings') 而不是 ctx.settings：
  //   Cordis 在服务没写进 inject 时，属性访问会直接抛
  //   `cannot get property "settings" without inject`，整个插件激活失败。
  let settingsSvc
  try {
    settingsSvc = ctx.get('settings')
  } catch {
    settingsSvc = undefined
  }
  if (settingsSvc && typeof settingsSvc.register === 'function' && Config) {
    try {
      settingsSvc.register('coolapk-dive', Config, { base: {}, applies: 'live' })
    } catch (e) {
      log(`宿主设置项没挂上（不影响用）：${e?.message ?? e}`)
    }
  }

  // ── HTTP（设置页用）────────────────────────────────────────────────────────
  const sendJson = (res, code, obj) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(obj))
  }

  const readBody = (req) =>
    new Promise((resolve) => {
      let b = ''
      req.on('data', (c) => {
        b += c
        if (b.length > 2e6) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(b || '{}'))
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })

  const stateOf = () => ({
    ok: true,
    version: VERSION,
    config: cfgOf(),
    defaults: DEFAULTS,
    dir: baseDir(),
    imageDir: imageDirAbs(cfgOf()),
    cache: cache.stats(),
    deviceCode,
  })

  const handle = async (req, res) => {
    if (!isSameOrigin(req.headers?.origin, req.headers?.host)) {
      return sendJson(res, 403, { ok: false, error: '跨站请求被拒（只接受同源）' })
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const sub = url.pathname.replace('/api/coolapk-dive', '') || '/'
    try {
      if (sub === '/' || sub === '/state') return sendJson(res, 200, stateOf())

      if (sub === '/config' && req.method === 'GET') return sendJson(res, 200, { ok: true, config: cfgOf(), defaults: DEFAULTS })

      if (sub === '/config' && req.method === 'POST') {
        const body = await readBody(req)
        const next = writeConfig(body && typeof body === 'object' ? body : {})
        cfg = next
        cache.configure({ max: next.cacheSize, ttlMs: next.cacheTtlSec * 1000 })
        log('配置已更新')
        return sendJson(res, 200, { ok: true, config: next })
      }

      if (sub === '/cache/clear' && req.method === 'POST') {
        const cleared = cache.clear()
        return sendJson(res, 200, { ok: true, cleared })
      }

      // 自检：真的打一次酷安接口，把 token 生成耗时、HTTP 延迟、拿到几条都报出来
      if (sub === '/test' && (req.method === 'POST' || req.method === 'GET')) {
        const q = url.searchParams.get('q') || '耳机'
        const started = Date.now()
        let tokenMs = 0
        try {
          const t0 = Date.now()
          const token = tokenV2(deviceCode)
          tokenMs = Date.now() - t0
          const items = await clientOf().searchFeeds(q, 1)
          const sample = items[0]
          return sendJson(res, 200, {
            ok: true,
            tokenMs,
            tokenPrefix: token.slice(0, 6),
            ms: Date.now() - started,
            query: q,
            count: items.length,
            total: Number(sample?._queryTotal) || 0,
            sample: sample
              ? { id: sample.id, title: feedTitle(sample, messageToText(sample.message)), author: authorOf(sample) }
              : null,
          })
        } catch (e) {
          return sendJson(res, 200, { ok: false, error: errText(e), tokenMs, ms: Date.now() - started })
        }
      }

      if (sub === '/open-dir' && req.method === 'POST') {
        return sendJson(res, 200, { ok: true, dir: imageDirAbs(cfgOf()) })
      }

      return sendJson(res, 404, { ok: false, error: `未知接口 ${sub}` })
    } catch (e) {
      log(`HTTP ${sub} 出错：${e?.message ?? e}`)
      return sendJson(res, 500, { ok: false, error: e?.message || String(e) })
    }
  }

  // 可选服务：webServer 可能在本插件 apply 之后才就绪，也可能永远没有（headless）。
  // 所以：先直接取 → 不行就 ctx.inject 等一次 → 再不行短轮询兜底，超时就放弃。
  let mounted = false
  const mount = (ws) => {
    if (!ws || mounted || typeof ws.register !== 'function') return
    mounted = true
    try {
      ctx.effect(
        () =>
          ws.register({
            kind: 'prefix',
            path: '/api/coolapk-dive',
            handler: handle,
          }),
        `${name}: routes`,
      )
      log('设置页接口已挂载：/api/coolapk-dive')
    } catch (e) {
      mounted = false
      log(`设置页接口没挂上：${e?.message ?? e}`)
    }
  }

  try {
    mount(ctx.get('webServer'))
  } catch {
    /* 没有 webServer 服务 */
  }
  if (!mounted) {
    try {
      ctx.inject(['webServer'], (c) => {
        let ws
        try {
          ws = c?.webServer ?? c?.get?.('webServer')
        } catch {
          ws = undefined
        }
        mount(ws)
      })
    } catch {
      /* 等不到就算了 */
    }
  }
  if (!mounted) {
    const timer = setInterval(() => {
      if (mounted) {
        clearInterval(timer)
        return
      }
      try {
        mount(ctx.get('webServer'))
      } catch {
        /* ignore */
      }
    }, 1500)
    try {
      timer.unref?.()
    } catch {
      /* ignore */
    }
    ctx.effect(() => () => clearInterval(timer), `${name}: webServer poll`)
    // 60 秒还没等到就放弃轮询，别一直空转
    const stop = setTimeout(() => clearInterval(timer), 60_000)
    try {
      stop.unref?.()
    } catch {
      /* ignore */
    }
  }

  ctx.effect(() => () => {
    try {
      client = null
      cache.clear()
    } catch {
      /* ignore */
    }
  }, `${name}: teardown`)

  log(`已加载 v${VERSION}（缓存 ${cfg.cacheSize} 条 / 图片目录 ${cfg.imageDir}）`)
}
