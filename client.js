/**
 * dsh-coolapk-dive —— 客户端半端（设置页）
 * ============================================================================
 * 只在 Harness Web 设置页里挂一个「酷安探帖」分区：改配置、点自检、清缓存。
 *
 * 规矩（照 references/ui-plugin.md）：
 *   · 只用 require('react')，不 require 任何 @deepseek-ai/dsh-client-* 包 ——
 *     那些包随时会变，抛错会让整个 slot 条目白屏。
 *   · 颜色一律走宿主 --dsw-alias-* token，不自造配色、不替换 app root。
 *   · 样式表在 apply 里用 ctx.effect 注册并在卸载时移除。
 */
window.__ModuleLoader__.load({
  id: 'dsh-coolapk-dive',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/api/coolapk-dive'

    // ── HTTP 小工具 ───────────────────────────────────────────────────────────
    const parse = async (r) => {
      const text = await r.text()
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(text ? text.slice(0, 200) : `HTTP ${r.status}`)
      }
    }
    const jget = async (p) => parse(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) =>
      parse(
        await fetch(API + p, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        }),
      )

    // ── 配置项描述（渲染表单用） ──────────────────────────────────────────────
    const FIELDS = [
      { key: 'enabled', label: '启用酷安工具', type: 'bool', hint: '关掉后 AI 就看不到 coolapk_search / coolapk_read' },
      { key: 'pageSize', label: '搜索结果条数', type: 'int', min: 1, max: 30, hint: '每页显示多少条（酷安接口本身每页 7–10 条）' },
      { key: 'snippetChars', label: '正文摘要字数', type: 'int', min: 40, max: 2000, hint: '搜索结果里每条正文截多少字' },
      { key: 'saveImages', label: '读帖时下载配图', type: 'bool', hint: '关掉就只给图片链接，不落盘' },
      { key: 'maxImages', label: '单帖最多几张图', type: 'int', min: 0, max: 20, hint: '0 = 不下载' },
      { key: 'includeComments', label: '带上热门评论', type: 'bool', hint: '酷安只开放「热门评论」一条，完整评论区接口是封闭的' },
      { key: 'timeoutMs', label: '请求超时（毫秒）', type: 'int', min: 3000, max: 60000, step: 1000 },
      { key: 'minGapMs', label: '请求最小间隔（毫秒）', type: 'int', min: 0, max: 5000, step: 50, hint: '两次请求之间至少隔这么久，别把酷安惹毛' },
      { key: 'cacheSize', label: '内存缓存条数', type: 'int', min: 0, max: 500, hint: '0 = 不缓存；进程退出就没了，不落盘' },
      { key: 'cacheTtlSec', label: '缓存存活（秒）', type: 'int', min: 30, max: 86400, step: 30 },
    ]

    // ── 样式 ──────────────────────────────────────────────────────────────────
    const CSS = `
.cpk-wrap { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 12px; }
.cpk-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.cpk-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.cpk-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.cpk-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.cpk-card-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); display: flex; align-items: center; gap: 8px; }
.cpk-row { display: grid; grid-template-columns: minmax(120px, 190px) 1fr; gap: 10px; align-items: center; }
.cpk-label { font-size: 13px; color: var(--dsw-alias-label-primary); }
.cpk-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 3px; line-height: 1.5; }
.cpk-input { width: 100%; box-sizing: border-box; font-size: 13px; padding: 6px 9px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); outline: none; }
.cpk-input:focus { border-color: var(--dsw-alias-brand-primary); }
.cpk-check { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; color: var(--dsw-alias-label-primary); cursor: pointer; user-select: none; }
.cpk-check input { width: 15px; height: 15px; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
.cpk-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.cpk-btn { font-size: 13px; padding: 6px 13px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }
.cpk-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.cpk-btn:disabled { opacity: 0.5; cursor: default; }
.cpk-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.cpk-msg { font-size: 12px; line-height: 1.6; padding: 8px 10px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); white-space: pre-wrap; word-break: break-word; }
.cpk-msg.ok { border-color: var(--dsw-alias-state-success-primary); }
.cpk-msg.err { border-color: var(--dsw-alias-state-error-primary); }
.cpk-msg.warn { border-color: var(--dsw-alias-state-warn-primary); }
.cpk-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.cpk-kv b { color: var(--dsw-alias-label-primary); font-weight: 500; }
.cpk-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.cpk-tag { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.cpk-tag.on { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.cpk-tag.off { border-color: var(--dsw-alias-state-idle-primary); color: var(--dsw-alias-state-idle-primary); }
`

    // ── 错误边界：一个分区崩了不能把整个设置页带走 ────────────────────────────
    class Boundary extends React.Component {
      constructor(p) {
        super(p)
        this.state = { err: null }
      }
      static getDerivedStateFromError(err) {
        return { err }
      }
      render() {
        if (this.state.err) {
          return h(
            'div',
            { className: 'cpk-msg err' },
            `酷安探帖设置页出错了：${this.state.err?.message || String(this.state.err)}`,
          )
        }
        return this.props.children
      }
    }

    function Field({ spec, value, onChange, disabled }) {
      const common = { className: 'cpk-input', disabled }
      if (spec.type === 'bool') {
        return h(
          'label',
          { className: 'cpk-check' },
          h('input', {
            type: 'checkbox',
            checked: !!value,
            disabled,
            onChange: (e) => onChange(spec.key, e.target.checked),
          }),
          value ? '开启' : '关闭',
        )
      }
      return h('input', {
        ...common,
        type: 'number',
        value: value ?? '',
        min: spec.min,
        max: spec.max,
        step: spec.step || 1,
        onChange: (e) => {
          const n = Number(e.target.value)
          onChange(spec.key, Number.isFinite(n) ? n : value)
        },
      })
    }

    function Panel() {
      const [cfg, setCfg] = useState(null)
      const [defaults, setDefaults] = useState(null)
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState(null) // {kind, text}
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const refresh = useCallback(async () => {
        try {
          const s = await jget('/state')
          if (!alive.current) return
          if (s?.ok) {
            setState(s)
            setCfg((prev) => prev ?? s.config)
            setDefaults(s.defaults ?? null)
          } else {
            setMsg({ kind: 'err', text: s?.error || '拿不到状态' })
          }
        } catch (e) {
          if (alive.current) setMsg({ kind: 'err', text: `连不上插件接口：${e.message}` })
        }
      }, [])

      useEffect(() => {
        refresh()
      }, [refresh])

      const setField = (key, value) => setCfg((prev) => ({ ...prev, [key]: value }))

      const save = async () => {
        setBusy('save')
        setMsg(null)
        try {
          const r = await jpost('/config', cfg)
          if (r?.ok) {
            setCfg(r.config)
            setMsg({ kind: 'ok', text: '已保存。新配置立即生效，不用重启。' })
            await refresh()
          } else {
            setMsg({ kind: 'err', text: r?.error || '保存失败' })
          }
        } catch (e) {
          setMsg({ kind: 'err', text: `保存失败：${e.message}` })
        } finally {
          setBusy('')
        }
      }

      const runTest = async () => {
        setBusy('test')
        setMsg(null)
        try {
          const r = await jpost('/test?q=' + encodeURIComponent('耳机'), {})
          if (r?.ok) {
            const lines = [
              `酷安接口通了 ✅`,
              `token 生成 ${r.tokenMs} ms（前缀 ${r.tokenPrefix}…）`,
              `搜索「${r.query}」耗时 ${r.ms} ms，拿到 ${r.count} 条，命中总数 ${r.total}`,
            ]
            if (r.sample) lines.push(`第一条：${r.sample.title} —— ${r.sample.author}（id ${r.sample.id}）`)
            setMsg({ kind: 'ok', text: lines.join('\n') })
          } else {
            setMsg({ kind: 'err', text: `自检失败：${r?.error || '未知原因'}` })
          }
          await refresh()
        } catch (e) {
          setMsg({ kind: 'err', text: `自检失败：${e.message}` })
        } finally {
          setBusy('')
        }
      }

      const clearCache = async () => {
        setBusy('cache')
        setMsg(null)
        try {
          const r = await jpost('/cache/clear', {})
          setMsg({ kind: r?.ok ? 'ok' : 'err', text: r?.ok ? `已清空缓存（${r.cleared} 条）` : r?.error || '清缓存失败' })
          await refresh()
        } catch (e) {
          setMsg({ kind: 'err', text: `清缓存失败：${e.message}` })
        } finally {
          setBusy('')
        }
      }

      const resetDefaults = () => {
        if (!defaults) return
        setCfg((prev) => ({ ...prev, ...defaults }))
        setMsg({ kind: 'warn', text: '已填回默认值，记得点「保存」才会写盘。' })
      }

      if (!cfg) {
        return h('div', { className: 'cpk-wrap' }, h('div', { className: 'cpk-msg' }, '正在读配置…'))
      }

      const cache = state?.cache
      const imagesOn = !!cfg.saveImages && Number(cfg.maxImages) > 0

      return h(
        'div',
        { className: 'cpk-wrap' },

        // 头部
        h(
          'div',
          { className: 'cpk-head' },
          h('span', { className: 'cpk-title' }, '酷安探帖'),
          h('span', { className: 'cpk-sub' }, '搜酷安、读帖子正文、配图存本地（只读，不登录不互动）'),
          h('span', { className: 'cpk-tag' }, `v${state?.version || '?'}`),
          h('span', { className: `cpk-tag ${cfg.enabled ? 'on' : 'off'}` }, cfg.enabled ? '工具已启用' : '工具已停用'),
          h('span', { className: `cpk-tag ${imagesOn ? 'on' : 'off'}` }, imagesOn ? '配图落盘' : '不落盘'),
        ),

        // 自检 / 状态
        h(
          'div',
          { className: 'cpk-card' },
          h('div', { className: 'cpk-card-title' }, '连通性'),
          h(
            'div',
            { className: 'cpk-kv' },
            h('span', null, '接口'),
            h('b', null, 'api.coolapk.com（X-App-Token v2 自动生成）'),
            h('span', null, '缓存'),
            h('b', null, cache ? `${cache.size}/${cache.max} 条 · 命中 ${cache.hits} 次 · TTL ${Math.round((cache.ttlMs || 0) / 1000)}s` : '—'),
            h('span', null, '图片目录'),
            h('b', { className: 'cpk-code' }, state?.imageDir || '—'),
            h('span', null, '设备码'),
            h('b', { className: 'cpk-code' }, (state?.deviceCode || '').slice(0, 16) + '…'),
          ),
          h(
            'div',
            { className: 'cpk-actions' },
            h('button', { className: 'cpk-btn primary', disabled: !!busy, onClick: runTest }, busy === 'test' ? '自检中…' : '自检一下'),
            h('button', { className: 'cpk-btn', disabled: !!busy, onClick: clearCache }, busy === 'cache' ? '清理中…' : '清空缓存'),
            h('button', { className: 'cpk-btn', disabled: !!busy, onClick: refresh }, '刷新状态'),
          ),
          msg ? h('div', { className: `cpk-msg ${msg.kind}` }, msg.text) : null,
        ),

        // 抓取
        h(
          'div',
          { className: 'cpk-card' },
          h('div', { className: 'cpk-card-title' }, '抓取'),
          ...FIELDS.slice(0, 6).map((spec) =>
            h(
              'div',
              { className: 'cpk-row', key: spec.key },
              h(
                'div',
                null,
                h('div', { className: 'cpk-label' }, spec.label),
                spec.hint ? h('div', { className: 'cpk-hint' }, spec.hint) : null,
              ),
              h(Field, { spec, value: cfg[spec.key], onChange: setField, disabled: false }),
            ),
          ),
        ),

        // 网络与缓存
        h(
          'div',
          { className: 'cpk-card' },
          h('div', { className: 'cpk-card-title' }, '网络与缓存'),
          ...FIELDS.slice(6).map((spec) =>
            h(
              'div',
              { className: 'cpk-row', key: spec.key },
              h(
                'div',
                null,
                h('div', { className: 'cpk-label' }, spec.label),
                spec.hint ? h('div', { className: 'cpk-hint' }, spec.hint) : null,
              ),
              h(Field, { spec, value: cfg[spec.key], onChange: setField, disabled: false }),
            ),
          ),
        ),

        // 保存
        h(
          'div',
          { className: 'cpk-actions' },
          h('button', { className: 'cpk-btn primary', disabled: !!busy, onClick: save }, busy === 'save' ? '保存中…' : '保存'),
          h('button', { className: 'cpk-btn', disabled: !!busy, onClick: resetDefaults }, '填回默认值'),
        ),

        h(
          'div',
          { className: 'cpk-hint' },
          '配置存在 $DSH_HOME/coolapk-dive/config.json；缓存只在内存里，进程重启即清空。'
          + '酷安的完整评论区接口是封闭的（恒返回 403），所以这里只能带出「热门评论」那一两条。',
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-coolapk-dive')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'coolapk-dive: styles')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots || typeof slots.inject !== 'function') return

        slots.inject('settings.section', () =>
          slots.register(
            {
              name: 'settings.section',
              id: 'coolapk-dive',
              order: 32,
              label: '酷安探帖',
            },
            () => h(Boundary, null, h(Panel)),
          ),
        )
      },
    }
  },
})
