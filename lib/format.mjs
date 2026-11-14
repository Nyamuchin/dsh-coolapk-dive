/**
 * 正文/字段的清洗与渲染。
 *
 * 酷安的 message 是「HTML 片段 + 字面 \n」的混合体，实测 84 条帖子里
 * 只出现过 `<a class="feed-link-tag">` 这一种标签（没有 img/br/p），
 * 换行是真正的换行符，表情是 `[受虐滑稽]` 这样的方括号文本。
 * 所以清洗只需要：把标签拆成纯文本 + 反转义实体 + 收一下空行。
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
}

export function decodeEntities(input) {
  return String(input ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    const hit = NAMED_ENTITIES[body.toLowerCase()]
    return hit === undefined ? whole : hit
  })
}

/** 抽出正文里的 #话题#（酷安的 feed-link-tag 只用于话题） */
export function extractTags(html) {
  const out = []
  const re = /<a[^>]*class="[^"]*feed-link-tag[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(String(html ?? '')))) {
    const text = decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim()
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

/** 正文 HTML → 纯文本（保留换行与话题文字，去掉所有标签） */
export function messageToText(html) {
  let s = String(html ?? '')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/p>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  s = s.replace(/\r\n?/g, '\n')
  s = s.replace(/[ \t]+\n/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

/** 搜索结果里的长文会被截断并以「查看更多」链接收尾，纯文本化后把这行去掉 */
export function stripSeeMore(text) {
  return String(text ?? '')
    .replace(/^\s*查看更多\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 秒级时间戳 → YYYY-MM-DD HH:mm（本地时区） */
export function formatDate(seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n * 1000)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 优先 dateline_text（酷安自己的「7天前」），否则格式化时间戳 */
export function dateLabel(item) {
  const text = String(item?.dateline_text ?? '').trim()
  const abs = formatDate(item?.dateline)
  if (text && abs) return `${text}（${abs}）`
  return text || abs
}

/**
 * 展示标题：message_title 多数是空串，title 是「某某的动态」不能用，
 * ttitle 是话题/主体名（如「原神」「华为FreeClip 2 耳夹耳机」）。
 * 所以顺序是 message_title → ttitle → 正文首行。
 */
export function feedTitle(item, fallbackText = '') {
  const candidates = [item?.message_title, item?.ttitle, item?.extra_title]
  for (const c of candidates) {
    const s = messageToText(c)
    if (s) return s.replace(/\s+/g, ' ').slice(0, 80)
  }
  const body = messageToText(fallbackText || item?.message || '')
  const firstLine = body.split('\n').map((l) => l.trim()).find(Boolean) || ''
  return firstLine.slice(0, 60) || `动态 ${item?.id ?? ''}`.trim()
}

export function authorOf(item) {
  const u = item?.userInfo || {}
  const name = String(item?.username || u.username || '').trim()
  return name || (item?.is_anonymous ? '匿名用户' : '未知用户')
}

export function picsOf(item) {
  const arr = Array.isArray(item?.picArr) ? item.picArr : []
  const urls = arr.map((u) => String(u || '').trim()).filter(Boolean)
  if (!urls.length && typeof item?.pic === 'string' && item.pic.trim()) urls.push(item.pic.trim())
  // 去重但保序
  return [...new Set(urls)]
}

const fmtCount = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}万`
  return String(n)
}

export function statsLine(item) {
  const bits = []
  const likes = Number(item?.likenum) || 0
  const replies = Number(item?.replynum) || 0
  if (likes) bits.push(`👍${fmtCount(likes)}`)
  if (replies) bits.push(`💬${fmtCount(replies)}`)
  if (Number(item?.favnum)) bits.push(`⭐${fmtCount(item.favnum)}`)
  return bits.join(' ')
}

/** 一条搜索结果的紧凑 markdown 摘要 */
export function renderSearchItem(item, index, { bodyChars = 220 } = {}) {
  const text = stripSeeMore(messageToText(item?.message))
  const title = feedTitle(item, text)
  const lines = [`### ${index}. ${title}`]
  const meta = [`作者 ${authorOf(item)}`]
  const when = dateLabel(item)
  if (when) meta.push(when)
  if (item?.device_title) meta.push(`机型 ${item.device_title}`)
  const stats = statsLine(item)
  if (stats) meta.push(stats)
  lines.push(`- ${meta.join(' · ')}`)
  lines.push(`- 动态 id：\`${item?.id}\`${Number(item?.replynum) ? ` · 回复 ${item.replynum} 条` : ''}`)
  const tags = extractTags(item?.message)
  if (tags.length) lines.push(`- 话题：${tags.join(' ')}`)
  if (text) {
    const body = text.length > bodyChars ? `${text.slice(0, bodyChars)}…` : text
    lines.push('')
    lines.push(body.replace(/^/gm, '> ').replace(/> \n/g, '>\n'))
  }
  const pics = picsOf(item)
  if (pics.length) lines.push('', `- 配图 ${pics.length} 张`)
  return lines.join('\n')
}

/** 搜索结果的完整 markdown（工具返回的 markdown 字段） */
export function renderSearchMarkdown(items, { q, page, total, hasMore }) {
  const head = [`# 酷安搜索「${q}」`, '']
  const meta = [`第 ${page} 页`, `${items.length} 条`]
  if (Number(total) > 0) meta.push(`约 ${Number(total).toLocaleString('en-US')} 条结果`)
  head.push(meta.join(' · '))
  if (!items.length) {
    head.push('', '没有搜到相关动态。换个关键词，或者减少限定词试试。')
    return head.join('\n')
  }
  head.push('', '要读全文（含完整配图与热门评论）就用 `coolapk_read` 传下面的动态 id。')
  const blocks = items.map((item, i) => renderSearchItem(item, (page - 1) * items.length + i + 1))
  const tail = hasMore ? `\n\n---\n还有更多结果：翻到第 ${page + 1} 页继续。` : ''
  return `${head.join('\n')}\n\n${blocks.join('\n\n')}${tail}`
}

/** 帖子详情 markdown */
export function renderDetailMarkdown(feed, { images = [], comments = [] } = {}) {
  const text = messageToText(feed?.message)
  const title = feedTitle(feed, text)
  const out = [`# ${title}`, '']
  const meta = [`作者 ${authorOf(feed)}`]
  const when = dateLabel(feed)
  if (when) meta.push(when)
  if (feed?.device_title) meta.push(`机型 ${feed.device_title}`)
  if (feed?.ip_location) meta.push(`IP ${feed.ip_location}`)
  const stats = statsLine(feed)
  if (stats) meta.push(stats)
  out.push(meta.join(' · '))
  out.push(`动态 id：\`${feed?.id}\`${feed?.url ? ` · 链接 ${feed.url}` : ''}`)
  const tags = extractTags(feed?.message)
  if (tags.length) out.push(`话题：${tags.join(' ')}`)
  out.push('', '---', '', text || '（正文为空）')
  const pics = picsOf(feed)
  if (pics.length) {
    out.push('', `## 配图（${pics.length} 张）`)
    const savedByUrl = new Map(images.map((i) => [i.url, i]))
    pics.forEach((url, i) => {
      const saved = savedByUrl.get(url)
      out.push(`${i + 1}. ${saved?.path ? `![配图 ${i + 1}](${saved.path})` : url}`)
      if (saved?.path) out.push(`   - 本地文件：${saved.path}`)
      if (saved?.error) out.push(`   - 下载失败：${saved.error}`)
    })
  }
  if (comments.length) {
    out.push('', `## 热门评论（${comments.length} 条）`)
    for (const c of comments) {
      const who = String(c?.username || c?.userInfo?.username || '匿名用户')
      const body = messageToText(c?.message)
      const like = Number(c?.likenum) || 0
      out.push('', `**${who}**${like ? ` · 👍${like}` : ''}`)
      out.push(body.replace(/^/gm, '> ').replace(/> \n/g, '>\n'))
    }
  }
  const replyCount = Number(feed?.replynum) || 0
  if (replyCount) {
    out.push(
      '',
      `---`,
      `这条动态有 ${replyCount} 条回复。酷安的完整评论区接口对外封闭（恒定返回「评论接口异常，请尝试升级到新版酷安」），所以只能看到上面的热门评论。`,
    )
  }
  return out.join('\n')
}
