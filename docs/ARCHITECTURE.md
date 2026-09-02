# 架构设计（v1.0）

## 1. 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│  浏览器 (React + Vite)                                        │
│                                                               │
│  ┌─────────┬─────────┬─────────┐                             │
│  │ Tile 1  │ Tile 2  │  ...    │  ← 3×3 宫格                  │
│  │ video   │ video   │         │     hls.js / mpegts.js       │
│  │ AdDetect│ AdDetect│         │     静音 + 最低画质           │
│  └────┬────┴────┬────┴─────────┘                             │
│       │ 抽帧/音频特征（本地计算，不上行视频）                    │
│       └──────────┼───────────────► 上报广告段开/闭             │
└──────────────────┼───────────────────────────────────────────┘
                   │  REST (JSON)
┌──────────────────▼───────────────────────────────────────────┐
│  Node 后端 (Fastify)                                          │
│                                                               │
│  routes/   rooms · streams · metrics · reports                │
│     │                                                         │
│  services/ streamResolver（流地址 + TTL 缓存）                 │
│            poller（定时采集 + 场次生命周期）                    │
│     │                                                         │
│  adapters/ douyin · kuaishou · taobao · wxchannel · xhs · direct│
│     │                                                         │
│  db/       SQLite（双驱动：better-sqlite3 ⇄ node:sqlite）      │
└──────────────────────────────────────────────────────────────┘
```

## 2. 关键设计决策

### 2.1 为什么必须前后端分离

| 需求 | 纯前端能做到吗 | 原因 |
|---|---|---|
| 多画面播放 | ✅ | hls.js / mpegts.js 纯浏览器 |
| 解析"分享链接→流地址" | ❌ | 需要跟踪 302、调平台接口，浏览器跨域直接被拦 |
| 采集在线人数 | ❌ | 平台接口无 CORS 头，浏览器拿不到 |
| 数据持久化 | ⚠️ | localStorage 容量有限、无法多端共享 |
| 广告识别 | ✅ | 本地算，反而更快 |

结论：**画面在前端，数据与解析在后端**。

### 2.2 为什么流地址要缓存

平台返回的 `pull_url` 有有效期（抖音约 30 分钟）。如果每个格子每次重连都重新请求：

- 9 格 × 频繁重连 = 高频调用平台接口 → 触发风控
- 用户手动"重新拉流"时反而应该强制刷新

因此实现 TTL 缓存（默认 30 分钟），并提供 `?force=1` 强制刷新。

### 2.3 为什么识别放前端

见 [`AD_DETECTION.md`](./AD_DETECTION.md#2-为什么放在浏览器端)。

### 2.4 为什么用适配器模式

国内平台接口**变化极快**（抖音一年变更多次，快手风控周级更新）。
把所有平台差异收敛到 `adapters/` 下的独立文件，好处：

- 平台挂了只影响该平台，不污染主流程
- 新增平台 = 新增一个文件 + 在 `adapters/index.js` 注册一行
- 每个适配器自带 `stability` 标记与 `hint`，前端可直接展示可操作提示

### 2.5 数据库双驱动

`better-sqlite3` 需要原生编译（可能缺 Xcode CLT 失败），
`node:sqlite` 是 Node 22.5+ 内置但属实验性 API。

实现 `openDatabase()` 依次尝试，优先 `better-sqlite3`、失败回落 `node:sqlite`，
保证**零原生依赖也能跑**，同时不牺牲兼容性。

## 3. 目录结构

```
live-grid-monitor/
├── docs/                       文档
│   ├── PRD.md                 产品需求（本文的上游）
│   ├── ARCHITECTURE.md        架构设计
│   ├── AD_DETECTION.md        广告识别算法说明
│   └── API.md                 接口文档
├── server/                    后端
│   ├── src/
│   │   ├── index.js           Fastify 入口
│   │   ├── config.js          配置（环境变量）
│   │   ├── db/index.js        SQLite 连接 + Schema
│   │   ├── adapters/          平台适配器（可插拔）
│   │   ├── services/          streamResolver / poller
│   │   └── routes/            rooms / streams / metrics / reports
│   └── scripts/smoke.mjs      冒烟测试（30 项）
└── web/                       前端
    └── src/
        ├── App.jsx            主界面 + 视图切换
        ├── lib/player.js      低码率静音播放器
        ├── lib/adDetector.js  广告识别核心
        ├── hooks/useAdDetector.js
        └── components/        MonitorGrid / StreamTile / AddRoomDialog / ReportPanel
```

## 4. 数据流

### 4.1 添加一个直播间

```
粘贴链接
  → detectPlatform(url)          自动识别平台
  → POST /api/rooms/parse        解析预览（不落库）
  → POST /api/rooms              落库 + 分配宫格 slot
  → MonitorGrid 渲染 StreamTile
  → GET /api/streams/:id         取流地址（带缓存）
  → createLowBitratePlayer()     挂载 hls.js / mpegts.js
```

### 4.2 数据采集

```
定时器（30s）
  → 遍历 enabled 房间
  → adapter.fetchRoomInfo()      拿最新标题/状态
  → adapter.fetchMetrics()       拿在线人数
  → 写 metrics_samples
  → 维护 live_sessions（0→1 开播建场；连续 3 次离线关场）
  → 关场时结算 duration / peak / avg / ad_count / ad_duration
```

### 4.3 广告识别与上报

```
每秒抽帧 → dHash → 滑动窗口(30s) → 特征 → 融合打分
  → 滞回状态机
  → LIVE→AD：POST /api/metrics/ad-segments/open   拿 segmentId
  → AD→LIVE：POST /api/metrics/ad-segments/:id/close   结算时长（<5s 丢弃）
```

## 4.5 平台适配器现状（2026-09 实测）

| 适配器 | 状态 | 说明 |
|---|---|---|
| `douyin` | `stable` | 免登录取流（房间 enter 接口），风控时可注入 Cookie |
| `kuaishou` | `experimental` | 建议配 Cookie |
| `taobao` | `experimental` | 现行接口 `mtop.roomstudio.live.detail.get/1.0`（tbzb.taobao.com 页面在用）。**mtop 两跳 token 交换**：首访空 token 触发 Set-Cookie 下发 `cookie2`/`_m_h5_tk`/`_m_h5_tk_enc` 三件套 → 完整带回 + md5(`token&t&appKey&data`) 签名重试（缺 `_m_h5_tk_enc`/`cookie2` 会 `ILLEGAL_ACCESS`）。实测**匿名可用、无需登录 Cookie**：返回直播状态（看 `streamStatus`/`roomStatus`，`status` 为 0 也可能在播）、标题、`viewCount` 在线人数、`startTime` 开播时间、多档 flv/m3u8 流（`liveUrl`/`liveUrlList`）。有 Cookie 时注入可提高抗风控能力 |
| `jd` | `experimental` | **实测（2026-09-03）**：web 端直播在 `lives.jd.com`（Vue SPA，hash 路由 `#/<liveId>`；3.cn / u.jd.com 短链 302 跳转至此）。数据走 `api.m.jd.com/client.action` 网关（`appid=h5-live`），关键接口 `getImmediatePlayToM`（body 传 `liveId`），**匿名可调、无需 eid 指纹与登录**：返回直播状态（`status:1`=直播中）与播放地址（`h5VideoUrl` m3u8 / `videoUrl` flv，单一清晰度）。房间标题/在线人数走内部推送通道（非 REST），1.0 未实现 → 标题留空、在线为 null |
| `wxchannel` / `xiaohongshu` | `stub` | 无公开 Web 接口 / 需动态签名，仅 URL 识别 + 骨架 |
| `direct` | `stable` | 兜底：m3u8 / flv 直链，也是所有平台的「抓包接入」通道 |

解析失败不再阻止添加房间：`POST /api/rooms` 会以**占位房间**保存（附 `last_error`），
宫格上显示原因，可补 Cookie 或「刷新流地址」重试。

## 5. 扩展指南：新增一个平台

以「视频号」为例（骨架已存在，只需补三个方法）：

```js
// server/src/adapters/wxchannel.js
import { BaseAdapter, AdapterError } from './base.js'

export class WxChannelAdapter extends BaseAdapter {
  static platform = 'wxchannel'
  static label = '微信视频号直播'
  static stability = 'experimental'
  static urlHints = ['https://channels.weixin.qq.com/live/xxxx']

  matchUrl(url) { return /channels\.weixin\.qq\.com/.test(url) }

  async fetchRoomInfo(url, opts) {
    // 返回 { roomId, title, anchorName, avatarUrl, isLive, raw }
  }
  async fetchStreamUrl(roomId, opts) {
    // 返回 { url, format: 'flv'|'hls', quality, qualities, expiresAt }
  }
  async fetchMetrics(roomId, opts) {
    // 返回 { isLive, onlineCount, likeCount }
  }
}
```

然后在 `server/src/adapters/index.js` 的 `ADAPTER_CLASSES` 数组中加入该类即可。
前端会自动在「添加直播间」弹窗的平台下拉里出现。

**调测技巧**：先随便找一个公开的 m3u8 测试流，用「直链适配器」验证前端播放链路；
确认播放没问题后再攻平台解析，能把问题域一分为二。

## 6. 部署

### 开发

```bash
cd server && npm install && npm run dev   # :8787
cd web    && npm install && npm run dev   # :5173（/api 已代理到 8787）
```

### 生产（单端口）

```bash
cd web && npm run build
cd ../server && npm install --omit=dev && PORT=8787 npm start
```

后端检测到 `web/dist` 存在时会一并托管静态资源，直接访问 `http://localhost:8787` 即可。
