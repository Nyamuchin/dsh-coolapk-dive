/**
 * 工具注册的薄封装。
 *
 * 宿主如果提供 `dsh-tools`，就用它的 defineTool；否则（本机就是这样：
 * `node -e "import('dsh-tools')"` 会 ERR_MODULE_NOT_FOUND）自己把「参数映射」
 * 转成宿主接受的 JSON Schema。
 *
 * 注意宿主 output.schema 只接受 object —— 工具 execute 必须返回对象，
 * 返回字符串会被判 `returned invalid output: "value" must be an object`。
 */
let base = (spec) => spec
let usingHost = false
try {
  const m = await import('dsh-tools')
  if (typeof m.defineTool === 'function') {
    base = m.defineTool
    usingHost = true
  }
} catch {
  /* 宿主没这个包：走兜底分支 */
}

/** 渲染层：优先用 execute 返回对象里的 markdown 字段，模型读起来最省 token */
export const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => {
    if (typeof value === 'string') return [{ type: 'text', text: value }]
    const md = value && typeof value === 'object' ? value.markdown : undefined
    return [{ type: 'text', text: typeof md === 'string' && md ? md : JSON.stringify(value, null, 2) }]
  },
}

/**
 * 把参数映射转 JSON Schema。
 * 入参形如 { q: { type: 'string', description: '…', required: true } }，
 * 只有显式 required: true 的才进 required。
 */
export function toJsonSchema(params) {
  if (!params || typeof params !== 'object') {
    return { type: 'object', properties: {}, required: [], additionalProperties: false }
  }
  if (params.type === 'object') return params
  const properties = {}
  const required = []
  for (const [key, schema] of Object.entries(params)) {
    if (!schema || typeof schema !== 'object') continue
    const { required: isRequired, ...rest } = schema
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

export function defineTool(spec) {
  if (usingHost) return base({ output: textOutput, ...spec })
  return base({ output: textOutput, ...spec, parameters: toJsonSchema(spec.parameters) })
}
