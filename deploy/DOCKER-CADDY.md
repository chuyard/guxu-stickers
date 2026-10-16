# 现有服务器升级说明 · 0.4.0

这是技术参考。与夏初实际交互时，每次只提供一个明确操作；不要让她一次执行所有阶段。

## 已核对的基线

Ubuntu 24.04、x86_64、用户 ubuntu；Docker 需 sudo；宿主没有 Node/npm，有 Python 3。Caddy 使用 `/etc/caddy/Caddyfile`。OB 容器 `ombre-brain` 使用 `127.0.0.1:18001`，表情包容器 `guxu-stickers` 使用 `127.0.0.1:8788`。升级前正式服务是 0.2.0；本次已于 2026-10-15 16:27 升级为 0.3.0，随后完成两端及动态库存验收。以下升级流程保留为维护参考，普通库存更新不执行该脚本。

Caddy 已有 `/stickers/*` 剥前缀反代到 8788，其余仍到 OB。新版本不覆盖 Caddy、不重启 Caddy、不改 OB 服务。`Caddyfile.verified-server` 仅保留核对参考。

## 发布和升级顺序

1. 通过经授权的 GitHub 接入，把本次代码、目录和迁移图片发布到仓库。保留原根目录 JPEG。
2. 服务器直接拉取指定发布提交的代码，不要求用户下载代码到个人电脑；不假设服务器已安装 git，可用已核对的 curl + Python zipfile。
3. 在拉取的源码目录执行 `bash deploy/update-inventory.sh`。

脚本先构建 `guxu-stickers:0.4.0`（镜像内运行测试与本地目录校验），再用临时容器只读检查 GitHub 正式目录及图片。通过后才停止旧表情包容器、改名保留备份，启动新容器，挂载 `guxu-stickers-catalog` 持久缓存卷。新服务需联网读取库存，因此就绪等待最多约 90 秒；短暂连接拒绝不会立即导致误回退。等待或 MCP 验证失败则自动恢复旧容器。

必须以服务器实际构建与检查输出作为部署结果；开发环境没有 Docker，不能宣称镜像已构建。

## 公网和连接

端点仍为 `https://ob.chuyard.cn/stickers/mcp`；健康为 `https://ob.chuyard.cn/stickers/healthz`。升级后健康版本应为 0.4.0，catalog 有 40 位提交、正式条目和 status ok。执行镜像内 `scripts/check-mcp.js` 核对 ID、query、no_match、avoid、默认项及 v5 UI。工具契约未变，无需刷新连接。

本次唯一工具改名为 `show_sticker`，增加可选 `id`、`query` 参数；UI URI 为 `ui://guxu-stickers/inventory-image-v5.html`。按官方要求刷新连接元数据；当前账户若仍找不到刷新入口，新建一次“顾叙表情包库存”，身份验证选无需身份验证。不要删除现有可用连接来试错。

确认参数出现后在新调用中复测电脑和 iPhone。宿主顶部调用文字不受插件样式控制；插件正常内容只有图片。后续库存数据变化不得再要求连接刷新。

## 第二张图片真实动态验收

首次部署只把用户指定猫猫列入目录。`test/fixtures/inventory-check.png` 是未上线的蓝黄色棋盘格技术验收图，不参与查询。

部署并连接成功后，记录容器 ID、State.StartedAt、State.Pid 和健康 catalog.commit。再通过 GitHub 接入将该测试图片按实际哈希复制至 `stickers/`，并加入目录，使用技术验收名称、tags 和 alt；保持默认猫猫不变。同一提交发布目录和图片。

等待当前缓存超过约两分钟后，在原连接中按第二图 ID 调用，并核对返回图片固定在新提交。再次检查容器 ID、StartedAt 和 Pid 与之前相同，未部署、未重启、未重新连接。记录桌面和 iPhone 显示。本地可控时钟测试只证明逻辑，不能冒充这个真实验收。

验收后可以只从目录下架测试图，保留正式历史文件；不得覆盖默认猫猫。把真实记录补入 VALIDATION.md 与 docs/MCP-HANDOFF.md，再交接日常窗口写 Skill。

## 本次已验收状态

初始运行代码提交 ec7d35eb3a4e7bf5e264e4ed58244690fe3f32e8；旧容器备份 guxu-stickers-before-inventory-20261015-162703。正式连接“顾叙表情包库存”已识别 show_sticker(id?,query?)；用户确认电脑和 iPhone 正常。真实第二图加图前后容器 ID、StartedAt、PID 均相同，动态更新通过。详见 VALIDATION.md 和 docs/MCP-HANDOFF.md。
