/**
 * 图片落盘：把帖子配图存到 $DSH_HOME/coolapk-dive/images/<动态id>/ 下。
 *
 * 为什么值得做：酷安图床地址带 `@1320x2120` 这种尺寸后缀，去掉后缀会 404，
 * 而地址本身会随内容变动/失效；存到本地之后模型可以直接用 read_image 看，
 * 也方便用户自己回看。
 *
 * 注意：图床会因为「浏览器 UA + Accept: image/*」回 567（一个 HTML 错误页），
 * 所以下载统一走 Dalvik UA 且不发 Accept，见 lib/api.mjs 的 fetchImage()。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
}

const extFor = (contentType, url) => {
  const byType = EXT[String(contentType || '').toLowerCase().split(';')[0].trim()]
  if (byType) return byType
  const m = /\.([a-zA-Z0-9]{2,5})(?:$|\?)/.exec(String(url || ''))
  const guess = m ? m[1].toLowerCase() : ''
  return ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic'].includes(guess) ? guess : 'jpg'
}

/** 图片地址 → 稳定的短哈希（同一张图重复下载能命中同一个文件名） */
export const urlKey = (url) => crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 10)

/** 帖子配图目录（按动态 id 分桶，便于用户回看，也避免单目录几万文件） */
export function feedImageDir(dirAbs, feedId) {
  const safe = String(feedId ?? 'unknown').replace(/[^0-9a-zA-Z_-]/g, '') || 'unknown'
  const dir = path.join(dirAbs, safe)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 下载并保存一张图。
 * @returns {{ok:true, path:string, bytes:number, contentType:string} | {ok:false, error:string}}
 */
export async function saveImage(client, url, { dir, maxBytes = 12 * 1024 * 1024, name } = {}) {
  try {
    const { buffer, contentType } = await client.fetchImage(url)
    if (maxBytes > 0 && buffer.length > maxBytes) {
      return { ok: false, error: `图片 ${(buffer.length / 1048576).toFixed(1)}MB 超过上限 ${(maxBytes / 1048576).toFixed(1)}MB` }
    }
    const ext = extFor(contentType, url)
    const base = name || urlKey(url)
    const file = path.join(dir, `${base}.${ext}`)
    fs.writeFileSync(file, buffer, { mode: 0o600 })
    return { ok: true, path: file, bytes: buffer.length, contentType }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** 一张图都没下成功时给个短原因，别把整页 markdown 撑爆 */
export function summarizeImageResults(results) {
  const ok = results.filter((r) => r.ok)
  const bad = results.filter((r) => !r.ok)
  return { okCount: ok.length, failCount: bad.length, bytes: ok.reduce((n, r) => n + r.bytes, 0) }
}
