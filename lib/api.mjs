/**
 * 酷安 API 客户端（只读）。
 *
 * 为什么要自己算 X-App-Token：
 *   www.coolapk.com 网页版对动态/话题页一律返回「请用酷安手机APP扫码查看」占位页，
 *   网页搜索接口全 404 —— 网页路线拿不到正文，只能走 api.coolapk.com。
 *   API 要求 X-App-Token，当前可用的版本是 v2（v3 必须带数字联盟 ID，随机设备号不行）。
 *
 * v2 算法（实测可用，约 60ms/次，够快，不需要缓存 token）：
 *   ts        = 秒级时间戳字符串
 *   token     = `token://com.coolapk.market/dcf01e569c1e3db93a3d0fcf191a622c?${md5(ts)}$${md5(deviceCode)}&com.coolapk.market`
 *   salt      = (`$2y$10$${base64(ts)}/${md5(token)}`).substring(0,31) + "u"
 *   result    = "v2" + base64raw(bcrypt.hashSync(md5(base64raw(token)), salt))
 *
 * 版本必须锁 13.x + X-Api-Version 13：用 v2 token 配 14.x 会返回
 * `{"status":1001,"message":"请求方式错误(1)"}`。
 */
import crypto from 'node:crypto'
import bcrypt from './bcrypt.mjs'

export const API_BASE = 'https://api.coolapk.com'
export const APP_ID = 'com.coolapk.market'
const APP_VERSION = '13.2.0'
const APP_CODE = '2305171'
const API_VERSION = '13'
const APP_TOKEN_SECRET = 'dcf01e569c1e3db93a3d0fcf191a622c'

const DALVIK_UA =
  'Dalvik/2.1.0 (Linux; U; Android 13; Pixel 6 Build/TQ3A.230805.001) +CoolMarket/13.2.0-2305171-universal'

/** 图片 CDN 只认浏览器/APP UA：不带 UA 会 567，带 Referer 也没用 */
export const IMAGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex')
const b64raw = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '')

/** 随机 32 位 hex 设备号即可（官方那套 aid;mac;厂商… 的格式不是必需的） */
export function newDeviceCode() {
  return crypto.randomBytes(16).toString('hex')
}

export function tokenV2(deviceCode) {
  const ts = String(Math.floor(Date.now() / 1000))
  const token = `token://${APP_ID}/${APP_TOKEN_SECRET}?${md5(ts)}$${md5(deviceCode)}&${APP_ID}`
  const salt = `$2y$10$${b64raw(ts)}/${md5(token)}`.substring(0, 31) + 'u'
  return 'v2' + b64raw(bcrypt.hashSync(md5(b64raw(token)), salt))
}

export class CoolapkError extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.name = 'CoolapkError'
    this.code = extra.code
    this.status = extra.status
  }
}

/** 一个带设备号 + 超时 + 重试的会话 */
export class CoolapkClient {
  constructor(options = {}) {
    this.deviceCode = options.deviceCode || newDeviceCode()
    this.timeoutMs = Math.max(3000, Math.min(Number(options.timeoutMs) || 15000, 60000))
    // 注意：不能写 `Number(x) ?? 1` —— Number(undefined) 是 NaN，而 NaN ?? 1 仍是 NaN，
    // 会让 `attempt <= NaN` 恒为 false、整个重试循环一次都不跑。
    const retries = Number(options.retries)
    this.retries = Math.max(0, Math.min(Number.isFinite(retries) ? retries : 1, 3))
    this.lastAt = 0
    // 允许 0（=不限速），所以不能用 `||` 兜底
    const gap = Number(options.minGapMs)
    this.minGapMs = Math.max(0, Math.min(Number.isFinite(gap) ? gap : 350, 5000))
  }

  headers() {
    return {
      'User-Agent': DALVIK_UA,
      'X-Requested-With': 'XMLHttpRequest',
      'X-App-Id': APP_ID,
      'X-App-Token': tokenV2(this.deviceCode),
      'X-App-Device': this.deviceCode,
      'X-App-Version': APP_VERSION,
      'X-App-Code': APP_CODE,
      'X-Api-Version': API_VERSION,
      'X-Sdk-Int': '33',
      'X-Sdk-Locale': 'zh-CN',
      'X-App-Mode': 'universal',
      'X-Dark-Mode': '0',
      Accept: 'application/json',
    }
  }

  /** 温和限速：两次请求之间至少隔 minGapMs，别把人家接口打疼 */
  async throttle() {
    const wait = this.lastAt + this.minGapMs - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.lastAt = Date.now()
  }

  /**
   * GET 一个 /v6 接口，返回 data 字段。
   * 出错抛 CoolapkError，带上是哪个接口、酷安原话。
   */
  async get(path, params = {}) {
    const url = new URL(path, API_BASE)
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue
      url.searchParams.set(k, String(v))
    }
    let lastError
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      await this.throttle()
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), this.timeoutMs)
      try {
        const res = await fetch(url, { headers: this.headers(), signal: ac.signal })
        const text = await res.text()
        let json
        try {
          json = JSON.parse(text)
        } catch {
          throw new CoolapkError(`酷安返回了非 JSON 内容（HTTP ${res.status}）`, {
            code: 'BAD_JSON',
            status: res.status,
          })
        }
        if (json && typeof json.status === 'number' && json.status !== 0 && json.status !== -1 && json.status >= 400) {
          throw new CoolapkError(json.message || `酷安返回 status=${json.status}`, {
            code: `STATUS_${json.status}`,
            status: res.status,
          })
        }
        if (!res.ok) {
          throw new CoolapkError(json?.message || `HTTP ${res.status}`, {
            code: 'HTTP_ERROR',
            status: res.status,
          })
        }
        if (json && json.data === undefined && json.message) {
          throw new CoolapkError(String(json.message), { code: 'NO_DATA', status: res.status })
        }
        return json ? json.data : undefined
      } catch (e) {
        lastError = e
        const retryable =
          e?.name === 'AbortError' ||
          e?.code === 'BAD_JSON' ||
          e?.code === 'HTTP_ERROR' ||
          (typeof e?.status === 'number' && e.status >= 500)
        if (attempt >= this.retries || !retryable) break
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
      } finally {
        clearTimeout(timer)
      }
    }
    if (lastError?.name === 'AbortError') {
      throw new CoolapkError(`请求酷安超时（${this.timeoutMs}ms）`, { code: 'TIMEOUT' })
    }
    throw lastError instanceof CoolapkError
      ? lastError
      : new CoolapkError(`请求酷安失败：${lastError?.message || lastError}`, { code: 'NETWORK' })
  }

  /** 搜索动态。q 为空时酷安会报错，调用方要先校验 */
  async searchFeeds(q, page = 1) {
    const data = await this.get('/v6/feed/search', { q, page })
    return Array.isArray(data) ? data : []
  }

  /** 动态详情（完整正文，含图片、机型、IP 归属地、热门评论） */
  async feedDetail(id) {
    const data = await this.get('/v6/feed/detail', { id })
    return data && typeof data === 'object' ? data : null
  }

  /**
   * 下载一张图，返回 {buffer, contentType}。
   *
   * 反直觉但实测稳定：图片 CDN 会因为「浏览器 UA + Accept: image/*」返回 HTTP 567（7350B HTML）。
   *   chrome UA + Accept:image/*        → 567
   *   chrome UA + Accept:*\/* 或无 Accept → 200
   *   Dalvik UA + 任意 Accept           → 200
   * 所以这里统一用 Dalvik UA 且不发 Accept —— 两种 UA 里它更宽松，也不容易被当成爬虫。
   * 图片 URL 上的 @WxH 后缀必须原样保留，删掉就是 404。
   */
  async fetchImage(url) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), Math.max(this.timeoutMs, 30000))
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': DALVIK_UA },
        signal: ac.signal,
        redirect: 'follow',
      })
      if (!res.ok) throw new CoolapkError(`图片下载失败（HTTP ${res.status}）`, { code: 'IMAGE_HTTP', status: res.status })
      const contentType = String(res.headers.get('content-type') || '').toLowerCase()
      if (!contentType.startsWith('image/')) {
        throw new CoolapkError(`图片地址返回的不是图片（${contentType || '未知类型'}）`, { code: 'IMAGE_TYPE' })
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      return { buffer, contentType }
    } catch (e) {
      if (e?.name === 'AbortError') throw new CoolapkError('图片下载超时', { code: 'IMAGE_TIMEOUT' })
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
}
