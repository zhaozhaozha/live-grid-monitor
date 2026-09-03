# Windows 部署指南

## 结论先行

**不需要封装成桌面应用(exe)，也不需要 Electron。**

本项目的后端是单端口设计：`server` 在 `8787` 端口同时提供 API 和托管前端构建产物（`web/dist`）。
所以 Windows 上只有**一个 Node 进程**在跑，双击 `start-windows.bat` 即可，浏览器访问 `http://localhost:8787`。

```
┌─────────────────────────────┐
│  浏览器 localhost:8787      │
└──────────┬──────────────────┘
           │ 同一端口
┌──────────▼──────────────────┐
│  Fastify server (node)      │
│   /api/*     → 接口         │
│   /*         → web/dist 静态 │
│   ffmpeg     → HEVC 转码     │
│   SQLite     → data/*.db     │
└─────────────────────────────┘
```

---

## 一、环境要求

| 项目 | 要求 | 说明 |
|------|------|------|
| 操作系统 | Windows 10 / 11 (x64) | 无需 WSL |
| Node.js | **≥ 22.5（推荐 LTS）** | 低于 22.5 也能用，但见下方 SQLite 说明 |
| 网络 | 首次安装需联网 | `ffmpeg-static` 的 postinstall 会下载约 30MB 二进制 |
| 磁盘 | 约 400MB | 含 node_modules + ffmpeg |

> 装 Node 时一路下一步即可，**不需要**勾选 "Automatically install necessary tools"（那是给 C++ 原生模块编译用的，本项目默认路径不依赖它）。

---

## 二、三步上手

### 方式 A：一键启动（推荐）

1. 把整个项目目录拷贝到 Windows 机器上（或 `git clone`）
2. **双击 `start-windows.bat`**
3. 等待自动完成「装依赖 → 构建前端 → 启动」，浏览器会自动打开

后续再启动，脚本会跳过已完成的步骤，秒开。

### 方式 B：命令行

```bat
npm install        :: 首次：安装依赖（根目录，走 npm workspaces）
npm run build      :: 首次：构建前端到 web/dist
npm start          :: 启动，访问 http://localhost:8787
```

---

## 三、Windows 特有问题与处理

### 1. SQLite 驱动（双驱动自动降级）

`server/src/db/index.js` 实现了双驱动：

1. 优先 `better-sqlite3`（原生模块，兼容性最好）
2. 失败则回落到 Node 22.5+ 内置的 `node:sqlite`（**零原生依赖**）

因此在 Windows 上：

- **Node ≥ 22.5**：即使 `better-sqlite3` 编译失败也能正常跑，会自动用内置驱动
- **Node < 22.5**：必须装好 `better-sqlite3`，否则启动报「未找到可用的 SQLite 驱动」

为此 `better-sqlite3` 已放在 `optionalDependencies` —— 装不上不会阻断 `npm install`。

查看当前使用的驱动：

```bat
curl http://localhost:8787/api/health
```

### 2. 中文乱码

`start-windows.bat` 开头有 `chcp 65001` 切到 UTF-8。
若控制台中文仍显示为乱码，用记事本打开该 bat →「文件 → 另存为」→ 编码选 **ANSI** → 保存，然后把第一行的 `chcp 65001 >nul` 删掉。

### 3. 端口被占用

默认 `8787`。修改方式（任选其一）：

```bat
set PORT=9000 && npm start
```

或在项目根目录建 `.env` 文件：

```ini
PORT=9000
POLL_INTERVAL_SEC=30
```

### 4. Windows 防火墙首次弹窗

Node 监听 `0.0.0.0` 时 Windows 会弹「是否允许访问网络」。
**仅本机使用请点「取消」**——不影响 `localhost` 访问。若需局域网内其他设备访问，点「允许」。

### 5. 杀毒软件误报 ffmpeg

`ffmpeg-static` 释放的 `ffmpeg.exe` 偶尔被 Windows Defender 拦截。
若淘宝 HEVC 房间转码失败（画面提示 HEVC 不支持），检查 `node_modules/ffmpeg-static/` 下 exe 是否被隔离，加白名单即可。

### 6. 抓取平台数据需要 Cookie（可选）

抖音/京东/快手等平台在无 Cookie 时可能只能拿到低码率流或公开信息。
在项目根目录 `.env` 中按平台配置：

```ini
DOUYIN_COOKIE=xxxx
JD_COOKIE=xxxx
KUAISHOU_COOKIE=xxxx
TAOBAO_COOKIE=xxxx
```

---

## 四、是否需要进一步封装成 exe？

| 方案 | 适用人群 | 体积 | 工作量 |
|------|---------|------|--------|
| **A. 一键 bat（当前）** | 自己用、团队内技术同学 | — | ✅ 已完成 |
| **B. Node SEA 单文件 exe** | 想给非技术同事，免装 Node | ~120MB | 约 1-2 小时 |
| **C. Electron 桌面壳** | 要无地址栏窗口、托盘、开机自启 | ~180MB | 半天+ |
| **D. Docker** | 服务器常驻、多人共享 | 镜像 ~300MB | 约 1 小时 |

**建议**：如果只是自己或技术同事在 Windows 上用，**方案 A 完全够**，别为「看起来像个软件」付出打包维护成本。

方案 B 的已知难点（若后续要做，先记着）：

- Node SEA 不支持 `require` 原生模块 → 必须走 `node:sqlite` 分支，需锁 Node 22.5+
- `ffmpeg.exe` **无法打进 exe**，只能作为同目录附属文件分发
- `web/dist` 需作为外部目录随行，或用 `sea-config.json` 的 `assets` 内联
- 沙箱是 macOS，产出的是 `.exe` 但**无法在本机实跑验证**，需在 Windows 上回归

---

## 五、常见问题

**Q：换机器后数据还在吗？**
数据库在 `data/live-grid.db`，该目录被 `.gitignore` 忽略（属用户隐私）。拷贝整个目录即可迁移数据。

**Q：能多人同时访问吗？**
可以。服务端监听 `0.0.0.0`，局域网其他设备访问 `http://<你的内网IP>:8787` 即可（注意放行防火墙）。

**Q：前端改了代码后要重新构建吗？**
要。改完执行 `npm run build`，再重启服务。开发期可用 `npm run dev` 获得热更新。
