/**
 * 配置：自己的 JSON 文件，落在 $DSH_HOME/coolapk-dive/config.json（0600）。
 *
 * 为什么不只靠宿主 settings：DSH 的自动表单在部分版本上不渲染，
 * 所以设置页控件 + `/api/coolapk-dive/config` 自给自足；宿主 settings 只是顺手挂上。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DIR_NAME = 'coolapk-dive'

export const DEFAULTS = {
  enabled: true,
  /** 每页结果数：酷安自己一页 7–10 条，这里只做展示裁剪 */
  pageSize: 10,
  /** 搜索结果里每条正文展示多少字 */
  snippetChars: 220,
  /** 是否把帖子配图下载到本地 */
  saveImages: true,
  /** 一次最多下载几张图（防止一条 20 图的帖子把磁盘写满） */
  maxImages: 6,
  /** 图片存到哪（相对 $DSH_HOME） */
  imageDir: 'coolapk-dive/images',
  /** 单张图最大字节数 */
  maxImageBytes: 12 * 1024 * 1024,
  /** 请求超时（毫秒） */
  timeoutMs: 15000,
  /** 请求间隔下限（毫秒），别把人家接口打疼 */
  minGapMs: 350,
  /** 是否带热门评论 */
  includeComments: true,
  /** 内存缓存条数（不落盘，进程退出即清） */
  cacheSize: 64,
  /** 内存缓存存活秒数 */
  cacheTtlSec: 900,
}

export function homeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function baseDir() {
  return path.join(homeDir(), DIR_NAME)
}

export function configFile() {
  return path.join(baseDir(), 'config.json')
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

export function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt)
  return {
    enabled: bool(r.enabled, DEFAULTS.enabled),
    pageSize: clampInt(r.pageSize, 1, 30, DEFAULTS.pageSize),
    snippetChars: clampInt(r.snippetChars, 0, 2000, DEFAULTS.snippetChars),
    saveImages: bool(r.saveImages, DEFAULTS.saveImages),
    maxImages: clampInt(r.maxImages, 0, 30, DEFAULTS.maxImages),
    imageDir: typeof r.imageDir === 'string' && r.imageDir.trim() ? r.imageDir.trim() : DEFAULTS.imageDir,
    maxImageBytes: clampInt(r.maxImageBytes, 1024 * 64, 64 * 1024 * 1024, DEFAULTS.maxImageBytes),
    timeoutMs: clampInt(r.timeoutMs, 3000, 60000, DEFAULTS.timeoutMs),
    minGapMs: clampInt(r.minGapMs, 0, 5000, DEFAULTS.minGapMs),
    includeComments: bool(r.includeComments, DEFAULTS.includeComments),
    cacheSize: clampInt(r.cacheSize, 0, 500, DEFAULTS.cacheSize),
    cacheTtlSec: clampInt(r.cacheTtlSec, 0, 86400, DEFAULTS.cacheTtlSec),
  }
}

export function readConfig(override) {
  let disk = {}
  try {
    disk = JSON.parse(fs.readFileSync(configFile(), 'utf8'))
  } catch {
    /* 没配置过就用默认 */
  }
  const merged = { ...DEFAULTS, ...(disk && typeof disk === 'object' ? disk : {}) }
  if (override && typeof override === 'object') {
    for (const [k, v] of Object.entries(override)) {
      if (v !== undefined && v !== null) merged[k] = v
    }
  }
  return normalize(merged)
}

export function writeConfig(patch) {
  const next = normalize({ ...readConfig(), ...(patch && typeof patch === 'object' ? patch : {}) })
  const dir = baseDir()
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${configFile()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, configFile())
  try {
    fs.chmodSync(configFile(), 0o600)
  } catch {
    /* Windows 上 chmod 基本无意义 */
  }
  return next
}

/** 图片目录（绝对路径），并保证存在 */
export function imageDirAbs(cfg) {
  const rel = (cfg?.imageDir || DEFAULTS.imageDir).replace(/^[/\\]+/, '')
  const dir = path.isAbsolute(rel) ? rel : path.join(homeDir(), rel)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
