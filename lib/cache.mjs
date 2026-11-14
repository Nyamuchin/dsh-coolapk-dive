/**
 * 进程内内存缓存（不落盘）。
 *
 * 用户选的是「内存缓存，不落盘」：同一次会话里重复读同一帖不重复打酷安接口，
 * 进程退出就清空 —— 不留隐私痕迹，也不会出现「缓存过期了还拿旧内容」的持久问题。
 */
export class MemoryCache {
  constructor({ max = 64, ttlMs = 900_000 } = {}) {
    this.max = Math.max(0, Number(max) || 0)
    this.ttlMs = Math.max(0, Number(ttlMs) || 0)
    this.map = new Map()
    this.hits = 0
    this.misses = 0
  }

  configure({ max, ttlMs }) {
    if (max !== undefined) this.max = Math.max(0, Number(max) || 0)
    if (ttlMs !== undefined) this.ttlMs = Math.max(0, Number(ttlMs) || 0)
    this.prune()
  }

  prune() {
    const now = Date.now()
    for (const [key, entry] of this.map) {
      if (this.ttlMs > 0 && now - entry.at > this.ttlMs) this.map.delete(key)
    }
    while (this.max > 0 && this.map.size > this.max) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
    if (this.max === 0) this.map.clear()
  }

  get(key) {
    if (this.max === 0) return undefined
    const entry = this.map.get(key)
    if (!entry) {
      this.misses += 1
      return undefined
    }
    if (this.ttlMs > 0 && Date.now() - entry.at > this.ttlMs) {
      this.map.delete(key)
      this.misses += 1
      return undefined
    }
    // 触碰一下，LRU 顺序
    this.map.delete(key)
    this.map.set(key, entry)
    this.hits += 1
    return entry.value
  }

  set(key, value) {
    if (this.max === 0) return value
    this.map.delete(key)
    this.map.set(key, { at: Date.now(), value })
    this.prune()
    return value
  }

  clear() {
    const size = this.map.size
    this.map.clear()
    return size
  }

  stats() {
    return { size: this.map.size, max: this.max, ttlMs: this.ttlMs, hits: this.hits, misses: this.misses }
  }
}
