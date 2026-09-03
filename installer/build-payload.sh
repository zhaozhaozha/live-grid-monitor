#!/usr/bin/env bash
# 组装 Windows 安装包的 payload 目录（在 Windows runner 上执行）。
#
# 产物结构（安装后即为 {app} 目录）：
#   runtime/node.exe           Windows Node 运行时（单文件版，用户无需预装 Node）
#   app/server/src             后端源码
#   app/server/node_modules    生产依赖（含 ffmpeg-static 的 win32 ffmpeg.exe）
#   app/server/.env            运行配置（端口 / 平台 Cookie）
#   app/web/dist               前端构建产物（由后端同一端口托管）
#   app/data                   数据库目录（首次运行自动建库）
#   start-silent.vbs           静默启动器（快捷方式指向它）
#   stop.vbs                   停止服务并回收 ffmpeg 子进程
#   assets/app.ico             快捷方式图标
#
# 用法: bash installer/build-payload.sh [node版本]
set -euo pipefail

# 注意：必须放在 installer/ 下。ISCC 编译 .iss 时，[Files] 里的相对路径
# 以 .iss 所在目录为基准，若 payload 放在仓库根会报
# "No files found matching ...\installer\payload\*"
NODE_VERSION="${1:-22.14.0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAYLOAD="$ROOT/installer/payload"

echo "==> 组装 payload（Node ${NODE_VERSION}）"

rm -rf "$PAYLOAD"
mkdir -p "$PAYLOAD/runtime" "$PAYLOAD/app/server" "$PAYLOAD/app/data" "$PAYLOAD/assets"

# 1) Node 运行时：官方单文件 node.exe
echo "  · 下载 Node 运行时 win-x64"
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe" -o "$PAYLOAD/runtime/node.exe"

# 2) 后端源码
echo "  · 复制后端源码"
cp -r "$ROOT/server/src" "$PAYLOAD/app/server/src"
cp "$ROOT/server/package.json" "$PAYLOAD/app/server/package.json"

# 3) 生产依赖（含 ffmpeg-static；better-sqlite3 为 optional，装不上不阻断）
echo "  · 安装生产依赖"
(cd "$PAYLOAD/app/server" && npm install --omit=dev --no-audit --no-fund)

# 4) 前端产物
echo "  · 复制前端产物"
mkdir -p "$PAYLOAD/app/web"
cp -r "$ROOT/web/dist" "$PAYLOAD/app/web/dist"

# 5) 启动器、图标、默认配置
echo "  · 复制启动器与配置"
cp "$ROOT/installer/start-silent.vbs" "$PAYLOAD/start-silent.vbs"
cp "$ROOT/installer/stop.vbs" "$PAYLOAD/stop.vbs"
cp "$ROOT/installer/assets/app.ico" "$PAYLOAD/assets/app.ico"
cp "$ROOT/installer/app.env" "$PAYLOAD/app/server/.env"

echo "==> payload 就绪"
du -sh "$PAYLOAD" 2>/dev/null || true
find "$PAYLOAD" -maxdepth 2 -type d | sed "s|$PAYLOAD|payload|"
