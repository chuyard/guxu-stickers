# 日常聊天窗口接口交接 · 0.4.0

施工窗口不创建聊天调用 Skill，不维护未来图片的语义。日常窗口看图后，使用经授权的 GitHub 接入同时更新正式图片及目录；展示 MCP 永远只读。

- 服务版本：0.4.0
- 最终唯一工具名称：`show_sticker`
- 正式端点：`https://ob.chuyard.cn/stickers/mcp`
- 正式连接名称：`顾叙表情包库存`（用户已按此名称连接，16:34 已实际识别新工具，16:37 确认电脑与 iPhone 正常）。旧的 `顾叙表情包` 连接仍保存旧定义，日常 Skill 应选本库存版。
- UI 资源：`ui://guxu-stickers/inventory-image-v5.html`
- 实际 MCP 工具描述与完整输入/输出 JSON Schema：见同目录 `show-sticker.contract.json`，由服务注册的真实描述导出，不包含库存清单。
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

## 动态更新验收结果：通过

2026-10-15 已完成真实 GitHub → 已运行的 Docker MCP → 原库存连接实际工具调用验证。

- 初始发布及服务器运行代码提交：`ec7d35eb3a4e7bf5e264e4ed58244690fe3f32e8`，版本 0.3.0，初始目录 1 张猫猫。
- 服务器本机和公网 `scripts/check-mcp.js` 均通过：准确 ID、ID 优先、未知 ID、不匹配、query、avoid、默认项、参数和 v5 UI。
- 新连接真实调用 `show_sticker({})` 返回默认猫猫。夏初于 16:37 确认“**两端正常**”：电脑和 iPhone 显示及紧凑尺寸通过。
- 第二图数据提交：`98fa40abb714958c290a7d7472275484b7cb29b3`。该提交**仅修改** `catalog.json` 与新增 `stickers/stk-4e881445537b.png`，没有修改服务代码、工具定义或 UI。
- 沿用 `顾叙表情包库存` 的同一工具接入，实际调用 `show_sticker({"id":"stk-4e881445537b"})` 成功。返回 `status:"ok"`、`selection.mode:"id"`、`catalog.commit:"98fa40abb714958c290a7d7472275484b7cb29b3"`、`stale:false`，图片地址也锁定该提交。
- 夏初在加图前与加图后两次执行 Docker inspect，三项完全相同：
  - 容器：`5245cee21a2724ba22dd33d22cbaebff319c3753009c30c88c35c33029074b74`
  - 启动：`2026-10-15T08:27:12.886266747Z`（北京时间 16:27:12）
  - PID：`758533`
- 证明这次加图没有重建、重新部署、重启容器或进程，也没有重新连接 MCP。目录与图片由新提交自动生效。
- 验收后的交付目录恢复为用户指定的默认猫猫；技术测试图从目录下架，正式历史文件保留，不删除、不覆盖。

测试图为蓝黄色棋盘格，仅用于库存架构验收，不属于日常聊天语义维护。客户端是否真正加载图片不能仅凭工具返回判定；两端紧凑显示确认针对本版默认猫猫卡片，第二图记录的是实际调用和数据更新成功。

## 日常维护边界

每张新图的名称、原文、标签、同义表达、contexts、tone、avoid 和 alt 均由日常窗口看缩略图后决定。新图可用 `stk-001` 式编号；夏初上传实际原图后，顾叙必须读取真实文件、计算完整 SHA-256 并在目录中绑定，验证通过才发布目录。图片清单只存在 `catalog.json`，不抄进 HTML 或聊天 Skill。
