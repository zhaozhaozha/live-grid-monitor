# 直播监控矩阵 · Live Grid Monitor

多平台直播间**九宫格监控台**：低码率多画面预览 + 开播时长 / 在线人数 / 广告时段自动采集 + 数据报表。

```
┌──────────┬──────────┬──────────┐
│ 抖音·A   │ 快手·B   │  直链·C  │   静音 · 最低画质 · 9 路并发
│ 👥1.2w   │ 👥3,400  │  👥 —    │   实时在线 / 开播时长角标
│ ⏱01:23:10│ ⏱00:12:04│ ⏱00:05:31│
├──────────┼──────────┼──────────┤
│  ▓▓▓▓░░  │  ▓░░░░░  │  ▓▓▓░░░  │   底部进度条 = 广告置信度
│  广告中   │  直播中   │  直播中   │   超过阈值自动记录广告时段
└──────────┴──────────┴──────────┘
```

## ✨ 1.0 能力

| 能力 | 说明 |
|---|---|
| **九宫格监控墙** | 固定 3×3，每格独立播放，单格异常不影响其他格 |
| **低码率静音** | 全程 `muted`；HLS 锁最低档并禁用 ABR 升档，FLV 由后端挑最低档 |
| **链接即接入** | 粘贴直播间分享链接，自动识别平台并解析出流地址 |
| **开播时长** | 自动维护"场次"生命周期，连续 3 次判定离线才关场（防断流切分） |
| **在线人数** | 默认 30s 轮询采样，记录峰值 / 均值 / 时间曲线 |
| **广告自动识别** | 抽帧 dHash + 音频 RMS + 关键词，多信号融合打分 + 滞回状态机 |
| **人工校正闭环** | 误报/漏报一键修正，并自适应微调识别阈值 |
| **数据报表** | 总览卡片 / 按房间聚合 / 单房间明细 / CSV 导出（Excel 不乱码） |

## 🎯 平台支持

| 平台 | 画面 | 在线人数 | 状态 |
|---|---|---|---|
| 抖音 | ✅ | ✅ | `stable` |
| 快手 | ✅ | ✅ | `experimental`（建议配 Cookie） |
| 淘宝直播 | ⚠️ | ⚠️ | `experimental`（Cookie 通道，详见下方说明） |
| 京东直播 | ⚠️ | ❌ | `experimental`（web 端入口已下线，见下方说明） |
| m3u8 / flv 直链 | ✅ | ❌ | `stable`（兜底 + 联调通道） |
| 微信视频号 | ❌ | ❌ | `stub` — 无公开 Web 接口 |
| 小红书 | ❌ | ❌ | `stub` — 需 x-s / x-t 动态签名 |

### 淘宝 / 京东的 `experimental` 边界

- **淘宝**：流地址由 mtop 接口下发，需登录 Cookie（含 `_m_h5_tk`）；部分接口已升级 mtgsig 强签名，
  老通道被拒时请把抓包得到的直链用「直链」模式接入（不受签名影响）。在线人数视接口返回而定。
- **京东**：2026 年实测 web 端直播入口已下线（`live.jd.com` 跳转 `jd.com`，老公开接口关闭），
  服务端无法直接解析流地址 → 请在京东 App / 浏览器抓包拿 `.m3u8`/`.flv` 直链接入。
  适配器保留链接识别与 liveId 提取，可先作为占位房间保存。

> 解析失败不再阻止添加：任何平台的分享链接都会以**占位房间**保存（宫格上显示失败原因），
> 可稍后补 Cookie 或「刷新流地址」重试；想立刻看到画面就走「直链」模式。
> 新平台接入指南见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#5-扩展指南新增一个平台)。

## 🚀 快速开始

### 环境要求

Node.js **18.18+**（用内置 `node:sqlite` 则需 **22.5+**）

### 开发模式（两个终端）

```bash
# 终端 1：后端
cd server && npm install && npm run dev     # http://localhost:8787

# 终端 2：前端
cd web && npm install && npm run dev        # http://localhost:5173
```

前端已把 `/api` 代理到 8787，直接开 5173 即可。

### 生产模式（单端口）

```bash
cd web && npm install && npm run build
cd ../server && npm install --omit=dev && PORT=8787 npm start
```

后端检测到 `web/dist` 存在时会一并托管静态资源，访问 `http://localhost:8787`。

### 30 秒验证

1. 打开页面，点任一空格 → **添加直播间**
2. 粘贴一个公开 HLS 测试流（验证播放链路，与平台解析解耦）：
   ```
   https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
   ```
3. 点「解析」→「添加到宫格」，画面应静音播放，底部出现置信度进度条

## ⚙️ 配置

复制 `server/.env.example` 为 `server/.env`：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 后端端口 |
| `DB_FILE` | `./data/live-grid.db` | SQLite 路径 |
| `POLL_INTERVAL_SEC` | `30` | 采集间隔（**过低会触发平台风控**） |
| `OFFLINE_GRACE_COUNT` | `3` | 连续几次判定离线才关场 |
| `STREAM_CACHE_TTL_SEC` | `1800` | 流地址缓存时长 |
| `AD_SCORE_THRESHOLD` | `0.62` | 广告识别默认阈值 |
| `DOUYIN_COOKIE` | — | 抖音 Cookie（遇风控时填） |
| `KUAISHOU_COOKIE` | — | 快手 Cookie |
| `TAOBAO_COOKIE` | — | 淘宝 Cookie（须含 `_m_h5_tk`，出流依赖登录态） |

### 抖音/快手提示风控怎么办？

在浏览器打开 `live.douyin.com` 登录后，F12 → Network → 任选一个请求 → 复制 `Cookie` 请求头，
粘到添加弹窗的「Cookie」框或 `.env` 的 `DOUYIN_COOKIE`。

## 🧪 测试

```bash
cd server && npm test
```

43 项冒烟测试，覆盖平台识别、适配器契约与降级提示、场次生命周期、广告段结算、报表聚合。
**不需要**安装 `fastify` / `better-sqlite3` 即可运行（会回落到内置 `node:sqlite`）。

## 📁 文档

| 文档 | 内容 |
|---|---|
| [`docs/PRD.md`](./docs/PRD.md) | 产品需求：背景、功能清单、验收标准、里程碑 |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | 架构决策、数据流、新增平台扩展指南 |
| [`docs/AD_DETECTION.md`](./docs/AD_DETECTION.md) | 广告识别算法：信号、权重、状态机、已知局限 |
| [`docs/API.md`](./docs/API.md) | REST 接口文档 |

## 🔧 技术栈

- **前端**：React 18 + Vite 5，`hls.js`（HLS）+ `mpegts.js`（FLV）
- **后端**：Node + Fastify 4
- **存储**：SQLite（双驱动：`better-sqlite3` ⇄ 内置 `node:sqlite`）

## ⚠️ 使用须知

本项目用于**自有直播间的运营复盘与公开直播间的公开数据观察**。
请遵守各平台的用户协议与 `robots.txt`，合理控制采集频率（默认 30s 已足够保守），
不要用于抓取非公开数据或对平台造成压力。

## 📄 许可

MIT
