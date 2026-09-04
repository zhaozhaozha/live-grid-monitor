# Windows 部署指南

## 结论先行

**不需要 Electron。** 两种用法，按需选择：

| 场景 | 方式 | 是否需要 Node |
|------|------|--------------|
| **日常使用 / 给同事** | 安装包（[Release 页](https://github.com/zhaozhaozha/live-grid-monitor/releases/latest) 下载 `LiveGridMonitor-x.y.z-Setup.exe`） | ❌ 内置运行时 |
| **改代码 / 二次开发** | `start-windows.bat` | ✅ 需 Node ≥22.5 |

两者跑的是同一套东西：后端是单端口设计，`server` 在 `8787` 端口同时提供 API 和托管前端构建产物（`web/dist`）。
所以运行时只有**一个 Node 进程**，浏览器访问 `http://localhost:8787`。

> 安装包是在 GitHub Actions 的 windows-latest runner 上真实构建的，
> 每次发版都会**静默安装 → 检查文件 → 检查桌面快捷方式 → 拉起服务做健康检查**，
> 冒烟测试不通过就不会发布。

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

## 二、安装方式

### 方式一：安装包（推荐 · 免装 Node）

1. 到 [Releases 页](https://github.com/zhaozhaozha/live-grid-monitor/releases/latest) 下载最新的 `LiveGridMonitor-<版本>-Setup.exe`
2. 双击安装（默认装到 `C:\Program Files\LiveGridMonitor`）
3. 桌面出现「Live Grid Monitor」快捷方式，**双击即启动，浏览器自动打开**

安装包内已内置 Node 运行时、ffmpeg 转码器、前端页面和 SQLite 驱动 —— **不需要预装任何东西**。
免装 Node 的关键在于 payload 里直接放了一份官方的 `node.exe`，快捷方式指向 `wscript.exe` + `start-silent.vbs`，
用 WMI `Win32_Process.Create` 启动（可拿到 PID 便于干净停止，且 `ShowWindow=0` 无控制台黑窗）。

安装后目录结构：

```
C:\Program Files\LiveGridMonitor\
├── runtime\node.exe         内置 Node 运行时
├── app\
│   ├── server\src\          后端源码
│   ├── server\node_modules\ 生产依赖（含 ffmpeg.exe）
│   ├── server\.env          端口 / Cookie 配置
│   ├── web\dist\            前端页面
│   └── data\                SQLite 数据库（首次运行自动建库）
├── start-silent.vbs         静默启动器（快捷方式指向它）
├── stop.vbs                 停止服务并回收转码进程
└── assets\app.ico           快捷方式图标
```

开始菜单另有四个入口：**停止服务**、**编辑配置**（改端口/Cookie）、**数据目录**（数据库位置）、**卸载**。

> 快捷方式走 `wscript.exe` + `start-silent.vbs`，不是直接指向 `node.exe`，
> 所以启动时**不会弹出控制台黑窗**；服务 PID 记在 `app\data\server.pid`，
> 停止时能连同 ffmpeg 转码子进程一起回收。

### 方式二：源码运行（需装 Node）

1. 把整个项目目录拷贝到 Windows 机器上（或 `git clone`）
2. **双击 `start-windows.bat`**
3. 等待自动完成「装依赖 → 构建前端 → 启动」，浏览器会自动打开

后续再启动，脚本会跳过已完成的步骤，秒开。

命令行等价操作：

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

### 7. 服务装完却起不来（已修复，记录以防回退）

曾出现过「安装包能装上、快捷方式也在，但双击后浏览器打不开」的情况。
根因是入口守卫**手动拼接** `file://` 前缀：

```js
// ❌ 错误写法
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) start()
```

| 平台 | `argv[1]` | 拼出的字符串 | 真实 `import.meta.url` | 结果 |
|------|-----------|-------------|----------------------|------|
| macOS | `/a/b/index.js` | `file:///a/b/index.js` | `file:///a/b/index.js` | ✅ 恰好相等 |
| Windows | `C:\a\b\index.js` | `file://C:\a\b\index.js` | `file:///C:/a/b/index.js` | ❌ 永不相等 |

Windows 上因此 `start()` 从未被调用，node 进程启动后直接退出码 0，
端口无人监听 —— **而这个 bug 在 macOS 上永远不会暴露**。

正确写法是交给平台感知的 API：

```js
import { pathToFileURL } from 'node:url'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start()
```

> 通用规则：任何拿 `import.meta.url` 和文件路径做比较的地方，
> 都必须走 `pathToFileURL`，不要手动加 `file://`。

## 四、安装包是怎么做出来的

**已落地方案：GitHub Actions + Inno Setup 安装包。**

macOS 上无法运行 Inno Setup（Windows 专属），所以构建放在 GitHub 的
`windows-latest` runner 上真实执行 —— 这样产出的 `setup.exe` 是能装能跑的真东西，
而不是凭空生成的产物。

触发方式：推送 `v*` 标签，或在 Actions 页面手动 `workflow_dispatch`。

```
.github/workflows/build-windows-installer.yml
  ↓ 装依赖 → 构建前端 → 组装 payload → 校验关键文件
  ↓ ISCC 编译 installer/windows-setup.iss
  ↓ 上传 artifact + 发布到 Release
```

### 为什么没走其他方案

| 方案 | 结论 |
|------|------|
| **Inno Setup 安装包（已选）** | 免装 Node、桌面快捷方式、开始菜单、卸载项一应俱全，维护成本最低 |
| Node SEA 单文件 exe | 不支持 require 原生模块；`ffmpeg.exe` 和 `web/dist` 都塞不进单文件，最终还是要外挂一堆附属文件，收益有限 |
| Electron 桌面壳 | 体积翻倍到 ~180MB，只为换一个无地址栏窗口，不划算 |
| Docker | Windows 需 Docker Desktop + WSL2，对个人用户太重 |

### 自己构建

```bash
# 推送标签即触发 Windows 构建
git tag v1.0.1 && git push origin v1.0.1

# 或在 GitHub Actions 页面手动触发（可指定 Node 版本）
```

构建产物在 Actions 运行页的 Artifacts 区（`LiveGridMonitor-Setup`），
打标签触发时会自动附加到对应 Release。

---

## 五、常见问题

**Q：换机器后数据还在吗？**
数据库在 `data/live-grid.db`，该目录被 `.gitignore` 忽略（属用户隐私）。拷贝整个目录即可迁移数据。

**Q：能多人同时访问吗？**
可以。服务端监听 `0.0.0.0`，局域网其他设备访问 `http://<你的内网IP>:8787` 即可（注意放行防火墙）。

**Q：前端改了代码后要重新构建吗？**
要。改完执行 `npm run build`，再重启服务。开发期可用 `npm run dev` 获得热更新。
