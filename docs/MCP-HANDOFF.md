# 日常聊天窗口接口交接（待真实部署验收后确认）

施工窗口不创建聊天调用 Skill，不维护未来图片的语义。日常窗口看图后，使用经授权的 GitHub 接入同时更新正式图片及目录；展示 MCP 永远只读。

- 服务版本：0.3.0
- 最终唯一工具名称：`show_sticker`
- 正式端点：`https://ob.chuyard.cn/stickers/mcp`
- 连接建议名称：`顾叙表情包库存`（**尚未新建/刷新，实际名称须验收后填写**）
- UI 资源：`ui://guxu-stickers/inventory-image-v5.html`
- 参数：`id?: string`（去首尾空白后 1～80 字符），`query?: string`（最长 1000 字符，空查询返回无匹配）。只有这两个业务参数；均可省略。`id` 优先，均省略选默认项。

## 工具完整描述

只读显示正式库存中的单张表情包。id 精确选图，不存在则报错且不替换；query 综合匹配标题、原文、标签、同义表达、适用语境和语气，并排除与 avoid 明显冲突的结果，匹配不足返回没有合适的表情包。同时提供 id 和 query 时以 id 为准；均省略则显示默认图片。查询应包含当前聊天的实际语境，尤其是真难过、认真表达不满或严肃冲突等限制；不要只保留正面关键词。只检索仓库已发布目录，不生成图片、不写入仓库。调用后自然回应，不播报工具过程；数据返回不代表客户端图片已加载。

## 返回结构

成功的 `structuredContent`：

```json
{
  "status": "ok",
  "sticker": {
    "id": "stk-c043f61536d6",
    "title": "坏东西猫猫",
    "alt": "气鼓鼓的橘猫，配字：坏东西！你是个坏东西！",
    "imageUrl": "https://cdn.jsdelivr.net/gh/chuyard/guxu-stickers@<40位提交SHA>/stickers/stk-c043f61536d6.jpeg"
  },
  "catalog": {"commit": "<40位提交SHA>", "stale": false},
  "selection": {"mode": "id"},
  "error": null
}
```

`selection.mode` 为 `id`、`default` 或 `query`。查询命中时另有数字 `score` 和 `matchedFields:string[]`，不表示概率。外层 `content` 为图片标题的一条 text；成功 `_meta.presentation` 为 `{imageSize:160,padding:0,radius:8}`。`stale:true` 表示正在使用上次有效的降级缓存；无需据此重试选另一张图。

无匹配的 `structuredContent`：

```json
{
  "status": "no_match",
  "sticker": null,
  "catalog": {"commit": "<40位提交SHA>", "stale": false},
  "selection": {"mode": "query"},
  "error": null
}
```

外层 `content:[{type:"text",text:"没有合适的表情包。"}]`，不设置 `isError:true`。停止发图，不虚构结果或强行换成默认图。

未知 ID 的 `structuredContent`：

```json
{
  "status": "error",
  "sticker": null,
  "catalog": {"commit": "<40位提交SHA>", "stale": false},
  "selection": null,
  "error": {"code": "ID_NOT_FOUND", "message": "未找到指定表情包：stk-000000000000"}
}
```

外层 `isError:true`，`content` 为错误信息。无可用目录时同样返回 `status:"error"`、`sticker:null`、`selection:null`，但 `catalog:null`、错误码 `CATALOG_UNAVAILABLE`。参数类型或长度错误由 MCP SDK 返回标准参数校验错误，可能不含上述业务 `structuredContent`；不应声称显示成功。

## 动态更新验收状态

本地：通过真实 MCP 客户端在同一运行中的 HTTP 服务、同一连接中新增第二张技术测试图并调用，然后下架；进程 PID、端口、工具定义和 UI HTML 均不变。缓存通过可控时钟超过 120 秒触发，不用等待真实两分钟。

线上：尚未发布新库存与升级容器；需部署后在 GitHub 新增第二图、等待缓存过期并成功调用，记录前后提交、容器 StartedAt、实际 ID 和连接名称。真实电脑和 iPhone 本版显示也待复测。不得把本地模拟的提交 SHA 或时钟测试当成这项线上验收。

## 日常维护边界

每张新图的名称、原文、标签、同义表达、contexts、tone、avoid 和 alt 均由日常窗口看图后决定；施工窗口不接管。图片清单只存在 `catalog.json`，不抄进 HTML 或聊天 Skill。最终聊天 Skill 待接口完成验收后，由日常窗口另行编写。
