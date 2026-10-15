# 顾叙表情包库存 · 0.3.0

一个只读 MCP 工具 `show_sticker`，支持稳定 ID、确定性语境查询和 GitHub 动态库存。正常 UI 只显示图片：默认 160 CSS 像素、按内容上报高度、透明背景、无边框偏好；失败才显示提示和重试。ChatGPT 的调用栏由宿主控制。

## 职责与目录

- `incoming/`：尚未整理的原图，保留上传文件名，不参与检索。
- `stickers/`：已整理的正式图片，使用内容哈希 ID 和文件名。
- `catalog.json`：唯一正式目录；未被列入的图片不参与显示或检索。
- 根目录原有 JPEG 继续保留，已有直链保持有效。

**本仓库是公开仓库，`incoming/` 也是公开的。不得上传私人照片或任何不希望公开的图片。**

今后由日常聊天窗口中的顾叙看图、决定名称和语义，使用经过授权的 GitHub 接入发布。施工代码只实现字段、校验、同步和检索，不判断新增图片含义。展示 MCP 没有仓库写入工具或管理 HTTP 接口，不接收上传，不创建最终聊天 Skill。

## 稳定 ID、文件及上下架

ID = `stk-` + 原始文件字节 SHA-256 的前 12 个十六进制字符，路径为 `stickers/<id>.<jpeg|jpg|png|webp>`。支持单张 JPEG、PNG、WebP，不加入 GIF 或批量界面。每张图片最多 10 MiB。

当前猫猫实际 SHA-256：`c043f61536d6c07936f469f450308b76cbd9573debe058d36874f7151edf5f74`；默认 ID 为 `stk-c043f61536d6`。本次迁移采用用户指定的全部标题、原文和语义，未另行改写。

本地维护辅助命令 `node scripts/prepare-asset.js <图片路径>` 仅计算 ID 并检查重复；加 `--write` 才复制新文件。已有相同内容返回 `duplicate:true`，不会覆盖。它不填写目录、不生成名称和语义、不提供任何网络写接口。

修改标题或语义不改变 ID。修改图片字节必须使用新 ID；旧 ID 下图片内容不符时，整个新目录会被拒收。相同文件不重复入库。下架从 `catalog.json` 移除条目，保留历史图片文件。默认图片仍必须有有效目录条目。

发布新增图时，在**同一个 Git 提交**中加入图片和目录条目；语义修改或下架只改目录。维护者发布前运行 `npm run validate:catalog`。服务器会在下次超过两分钟缓存期限的工具调用中检查新提交；不需要重启、部署、改 UI 或重新连接 MCP。

## 目录字段

`schemaVersion` 当前只能为 `1`；`defaultId` 必须对应 `items` 中的图片。每项均须提供以下字段；没有内容时 `text` 可为空字符串，数组可为空，但数组内不得有空字符串。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | string | 内容哈希稳定 ID |
| `file` | string | 本仓库 `stickers/` 下与 ID 对应的图片路径 |
| `title` | string | 名称 |
| `text` | string | 图片原始文字 |
| `tags` | string[] | 内容与情绪标签 |
| `aliases` | string[] | 同义表达 |
| `contexts` | string[] | 具体适用语境 |
| `tone` | string[] | 态度和情绪倾向 |
| `avoid` | string[] | 不适用情形 |
| `alt` | string | 无障碍文字 |

字段不能用于提供任意外部图片网址。文件路径不接受 `incoming/`、绝对路径、URL、目录穿越、SVG、符号链接。目录支持最多 2000 项；字段长度和数组项数也受校验约束，见 `catalog.js`。

## 工具接口

唯一工具：`show_sticker`。完整接入交接见 `docs/MCP-HANDOFF.md`。

```json
{"id":"stk-c043f61536d6"}
```

```json
{"query":"猫猫 装凶 调侃"}
```

`id`、`query` 均可省略；`id` 优先；均省略返回默认图。未知 ID 报错，绝不替换。空查询和匹配不足返回 `no_match`，没有图片。正常调用不输出整份库存。

检索对文本做 NFKC、大小写、标点归一化；使用本机 Node/ICU 的中文分词，并为“猫猫、装凶”等分成单字的词保留词组。六个正向字段全部参与匹配，权重为 title 8、text 7、tags 7、aliases 7、contexts 6、tone 5；完整短语加权，去掉常见虚词，不使用单字巧合匹配。需达到分数和覆盖率门槛；同分按 ID 字典顺序固定排序。

`avoid` 命中完整短语，或其有效关键词全部出现在查询时排除该图；识别部分紧邻否定表达。它是保守的文本规则，不是开放式语义理解或安全分类器。查询必须带真实语境，不能在真难过或严肃冲突时只传“装凶 猫猫”。精确 `id` 不经过查询排除规则，因此由日常窗口决定是否适用。不调用模型、向量服务或收费 API；同义表达由目录的 `aliases` 提供。

## 动态同步和缓存

服务启动读取 GitHub `main` 当前提交并完成校验；之后使用有效缓存，超过约 120 秒的下一次工具调用才检查提交。健康轮询不会触发 GitHub 请求。并发调用共享同一次同步。

1. 使用 GitHub 提交 API 和条件请求检查 SHA。
2. 从该 SHA 读取完整 Git 树和 `catalog.json`，验证目录 Git blob 哈希。
3. 校验字段、重复 ID、默认项、文件路径和实际文件存在性，拒绝符号链接或不完整 Git 树。
4. 校验新增或变更图片的字节签名、SHA-256 ID、Git blob SHA、大小和扩展名；未变图片复用已验证记录。
5. 所有条目通过后才原子替换内存快照；UI 图片网址也固定为同一 40 位提交 SHA 下的本仓库 jsDelivr 地址。
6. 原子写入本地缓存。Docker 命名卷 `guxu-stickers-catalog` 保存最后有效目录及验证记录，重启后断网仍可用。

同步、限流、目录或图片校验失败时，继续使用上份有效快照，健康状态为 `degraded`。既没有有效磁盘缓存、也无法成功读仓库时启动失败，不伪造库存成功。缓存保存失败单列 `cachePersistenceError`；当前内存库存继续可用。

`GET /healthz` 提供版本、当前提交、条目数、最后尝试时间、最后成功同步时间、同步状态、错误和刷新间隔。有效旧缓存仍可用时返回 HTTP 200；无有效缓存返回 503。`ok:true` 只表示有库存可服务，不代表 UI 已加载或同步没有告警。

图片 CDN 冷缓存可能需要时间；组件失败时可以重试。所有地址固定提交，不会把新目录与 `@main` 下旧图片拼在一起。

## 本地运行与测试

Node.js >=22，推荐 Docker 中相同的 Node 24。无需 OpenAI API Key，也无需仓库写入凭据。

```bash
npm ci
npm test
npm run validate:catalog
npm start
```

启动前须先把有效目录和图片发布到 GitHub。仅本地验证目录不会代替线上目录。`ENABLE_PREVIEW=1 npm start` 启用 `/preview`，默认关闭。

浏览器测试需要环境已有的 Playwright 和 Chromium：`PLAYWRIGHT_MODULE=<模块路径> QA_CHROMIUM_EXECUTABLE=<浏览器路径> node test/browser-smoke.cjs`。它验证标准宿主、旧兼容桥接和紧凑高度，不替代真实 iPhone 验收。

## 升级与连接

服务器已核对为 Ubuntu 24.04、Docker、宿主 Caddy。容器绑定 `127.0.0.1:8788`；Caddy 现有 `/stickers/*` 转发不需改动，OB 容器不需改动。部署使用 `deploy/update-inventory.sh`，先构建、运行测试并验证线上仓库，再切换容器；失败自动回退，保留旧容器。

本次 0.2.0 → 0.3.0 会把工具统一为 `show_sticker(id?,query?)`，UI 资源升级为 `ui://guxu-stickers/inventory-image-v5.html`，需要一次连接元数据刷新；如果当前账号没有刷新入口，可以新建一次“顾叙表情包库存”连接。端点仍为 `https://ob.chuyard.cn/stickers/mcp`，展示工具仍为无需身份验证。先确认新参数已识别，再验收。

**之后普通库存变更只提交仓库数据，不改变工具定义和 UI 资源，不需要重新连接。**

本次已完成真实部署、电脑/iPhone 紧凑 UI、以及新增第二图而不重启/部署/重连的验收。实际过程和证据见 `VALIDATION.md`；日常窗口完整交接见 `docs/MCP-HANDOFF.md`。施工窗口没有创建聊天 Skill。

正式使用连接为 **顾叙表情包库存**，新工具 `show_sticker(id?, query?)` 已识别。旧的“顾叙表情包”仍保存旧工具定义，不用于本版日常调用。普通库存更新不再需要新建连接。测试图已从目录下架，历史文件保留。

协议与同步测试使用独立固定目录样例，今后增减实际库存不会改变测试用例的数量假设；实际 `catalog.json` 与文件仍由 `npm run validate:catalog` 单独校验。

官方参考：
- https://developers.openai.com/plugins/reference
- https://developers.openai.com/plugins/build/chatgpt-ui
- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://docs.github.com/en/rest/commits/commits
- https://docs.github.com/en/rest/git/trees
- https://www.jsdelivr.com/documentation
