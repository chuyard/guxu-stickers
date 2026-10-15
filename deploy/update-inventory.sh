#!/usr/bin/env bash
set -euo pipefail
sticker_project="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
sticker_backup="guxu-stickers-before-inventory-$(date +%Y%m%d-%H%M%S)"
sudo docker inspect guxu-stickers >/dev/null
sudo docker build -t guxu-stickers:0.3.0 "$sticker_project"
# Prove the published repository is usable before touching the running 0.2.0 container.
sudo docker run --rm guxu-stickers:0.3.0 node scripts/check-repository.js
sticker_restore() {
  trap - ERR
  printf '更新未通过，恢复原容器：%s\n' "$sticker_backup"
  if sudo docker inspect "$sticker_backup" >/dev/null 2>&1; then
    if sudo docker inspect guxu-stickers >/dev/null 2>&1; then
      sudo docker logs --tail 30 guxu-stickers || true
      sudo docker stop guxu-stickers || true
      sudo docker rename guxu-stickers "guxu-stickers-inventory-failed-$(date +%Y%m%d-%H%M%S)" || true
    fi
    sudo docker rename "$sticker_backup" guxu-stickers
  fi
  sudo docker start guxu-stickers
}
trap sticker_restore ERR
sudo docker stop guxu-stickers
sudo docker rename guxu-stickers "$sticker_backup"
sudo docker run -d --name guxu-stickers --restart unless-stopped \
  -p 127.0.0.1:8788:8788 -e PUBLIC_ORIGIN=https://ob.chuyard.cn \
  -e CATALOG_CACHE_FILE=/data/catalog-cache.json \
  --mount type=volume,source=guxu-stickers-catalog,target=/data \
  guxu-stickers:0.3.0
sticker_ready=0
for sticker_attempt in {1..45}; do
  if curl --fail --silent --max-time 3 http://127.0.0.1:8788/healthz; then
    sticker_ready=1
    break
  fi
  sleep 2
done
if [[ "$sticker_ready" != 1 ]]; then
  printf '服务未在等待时间内就绪。\n' >&2
  false
fi
printf '\n'
sudo docker exec guxu-stickers node scripts/check-mcp.js
trap - ERR
printf '\n库存版更新完成，原容器保留为：%s\n' "$sticker_backup"
printf '下一步只需本次刷新连接元数据，确认唯一工具 show_sticker(id?, query?)。\n'
