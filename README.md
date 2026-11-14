# 酷安探帖（dsh-coolapk-dive）

在 DeepSeek Harness 里搜酷安、读帖子正文，配图直接存到本地。

只读插件：**不登录、不点赞、不回帖、不收藏**，唯一的写盘动作是缓存帖子配图。

## 给 AI 的两个工具

| 工具 | 用途 |
| --- | --- |
| `coolapk_search` | 按关键词搜动态，返回标题 / 作者 / 时间 / 机型 / 点赞回复数 / 正文摘要 / 动态 id。`page` 可翻页（每页 7–10 条，能翻到很老的帖子）。 |
| `coolapk_read` | 用动态 id（或 `/feed/<id>` 链接）读完整正文，带作者、机型、IP 归属地、点赞回复数、配图（默认下载到本地并给出路径）、热门评论。 |

## 为什么不用网页版

`www.coolapk.com` 的动态页、话题页、用户页一律返回「请用酷安手机APP扫码查看」占位页，
网页搜索接口全部 404 —— 网页路线拿不到任何正文。所以插件走 `api.coolapk.com`，
自己算 `X-App-Token`（v2 算法，bcrypt），不依赖登录态。

相关实现都在 `lib/api.mjs`，其中三个坑已经踩过并写进注释：

1. **token v3 走不通**：v3 必须提供数字联盟 ID（DU 开头），随机设备号会被判「请求验证错误」。
   所以固定用 v2 + `X-Api-Version: 13` + `CoolMarket/13.2.0-2305171`；版本升到 14.x 会返回「请求方式错误(1)」。
2. **图片 URL 的 `@WxH` 后缀不能删**：删掉就是 404。
3. **图床对「浏览器 UA + `Accept: image/*`」返回 HTTP 567**：所以下载统一用 Dalvik UA 且不发 Accept。

## 拿不到的东西

酷安的完整评论区接口对外封闭，任何版本号/参数组合都恒返回
`{"status":403,"message":"评论接口异常，请尝试升级到新版酷安"}`。
`coolapk_read` 只能带出 `topReplyRows` 里那一两条「热门评论」，这是接口层面的限制，不是没做。

## 设置页

Harness 设置页 → 「酷安探帖」（在「刷贴吧」旁边）。可以改：

- 搜索条数、正文摘要字数
- 是否下载配图、单帖最多几张
- 是否带热门评论
- 请求超时、请求最小间隔（别把酷安惹毛）
- 内存缓存条数 / TTL

还有「自检一下」按钮：真打一次酷安接口，报出 token 生成耗时、HTTP 延迟、命中条数。
配置存 `$DSH_HOME/coolapk-dive/config.json`（0600），缓存只在内存里，进程退出即清。

## 文件

```
index.js            主机半端：工具注册 + 设置页 HTTP 接口
client.js           设置页 UI（settings.section）
lib/api.mjs         酷安 API 客户端（token v2 / 搜索 / 详情 / 取图）
lib/format.mjs      正文 HTML → 文本、markdown 渲染
lib/images.mjs      配图落盘
lib/config.mjs      配置读写
lib/cache.mjs       内存 LRU 缓存
lib/toolkit.mjs     工具定义适配（宿主有 dsh-tools 就用它，没有就自己转 JSON Schema）
lib/bcrypt.mjs      bcryptjs 3.0.3 单文件（vendored，ISC 许可见 lib/bcrypt.LICENSE）
test-host.mjs       用假 ctx 跑 apply()，验证工具注册 / 执行 / HTTP 路由
```

跑自测：

```powershell
$env:DSH_HOME="$HOME\.dsh"
node test-host.mjs
```

## 许可

MIT（`lib/bcrypt.mjs` 来自 bcryptjs，ISC）。
