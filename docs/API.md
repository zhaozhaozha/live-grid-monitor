# 接口文档（v1.0）

基础路径：`http://localhost:8787`
所有请求/响应均为 `application/json; charset=utf-8`（CSV 导出除外）。

---

## 系统

### `GET /api/health`

健康检查 + 已注册平台列表。

```json
{ "ok": true, "version": "1.0.0", "time": "2026-09-02T13:00:00.000Z",
  "platforms": ["douyin","kuaishou","taobao","wxchannel","xiaohongshu","direct"] }
```

---

## 直播间 `/api/rooms`

### `GET /api/rooms`

房间列表，按 `slot` 升序。

```json
{ "items": [{ "id":"room_xxx","platform":"douyin","share_url":"https://live.douyin.com/123",
              "title":"...","anchor_name":"...","slot":0,"quality":"lowest","enabled":true }] }
```

### `GET /api/rooms/platforms`

平台能力清单，用于「添加直播间」弹窗。

```json
{ "items": { "douyin": { "platform":"douyin","label":"抖音直播","stability":"stable",
                         "urlHints":["https://live.douyin.com/712345678901"],"needCookie":true } } }
```

`stability` 取值：`stable` / `experimental` / `stub`。

### `GET /api/rooms/live`

实时快照。前端每 10s 拉一次，用于宫格角标。

```json
{ "at": "2026-09-02T13:00:00.000Z",
  "items": {
    "room_xxx": {
      "online_count": 1234, "like_count": 5678, "is_live": true,
      "sampled_at": "2026-09-02T13:00:00.000Z",
      "session_start": "2026-09-02T12:30:00.000Z",
      "session_id": "ses_xxx",
      "ad_open": { "id": "ad_xxx", "since": "2026-09-02T12:58:00.000Z" }
    }
  }}
```

### `POST /api/rooms/parse`

解析分享链接（**不落库**），用于添加前预览。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | ✅ | 直播间分享链接 |
| `platform` | string | | 不传则自动识别 |
| `cookie` | string | | 平台 Cookie |

成功：

```json
{ "ok": true, "platform":"douyin", "roomId":"7...", "title":"...",
  "anchorName":"...", "avatarUrl":"...", "isLive": true }
```

失败 `422`：

```json
{ "error":"未取到流地址，可能需要配置有效 Cookie", "code":"NO_STREAM", "hint":"在 .env 中设置 DOUYIN_COOKIE 后重试" }
```

错误码：`PARSE_FAILED` / `ROOM_NOT_FOUND` / `NOT_LIVE` / `NO_STREAM` / `API_ERROR` / `API_DEPRECATED`（京东入口下线） / `RISK_CONTROL`（淘宝签名/风控） / `NOT_IMPLEMENTED` / `TIMEOUT` / `NETWORK` / `HTTP_ERROR` / `UNKNOWN_PLATFORM`。

### `POST /api/rooms`

添加房间。

| 字段 | 类型 | 说明 |
|---|---|---|
| `url` | string | ✅ |
| `platform` | string | 可选，默认自动识别 |
| `slot` | number | 0–8，不传自动分配 |
| `cookie` | string | 可选，房间级 Cookie |
| `quality` | string | 默认 `lowest` |

占满 9 格返回 `409`。

解析行为（1.0）：**分享链接解析失败不再拒绝添加**——返回 `201` 并携带 `warning` 字段
（失败原因），房间以占位状态保存（`last_error` 有值），可补 Cookie 或「刷新流地址」重试：

```json
{ "item": { "id":"room_xxx", "...": "..." }, "warning": "京东直播 web 端入口已下线..." }
```

### `PATCH /api/rooms/:id`

可更新字段：`title` / `anchor_name` / `slot` / `quality` / `enabled` / `cookie` / `share_url`。

### `DELETE /api/rooms/:id`

删除房间（级联删除场次、采样、广告段、流缓存）。

### `POST /api/rooms/:id/close-session`

手动结算当前进行中的场次。

---

## 流地址 `/api/streams`

### `GET /api/streams/:roomId`

```json
{ "ok": true, "url": "https://.../xxx.flv", "format": "flv",
  "quality": "sd1", "qualities": ["sd1","sd2","hd1"], "cached": false, "expiresAt": 1756... }
```

`?force=1` 跳过缓存强制重新解析。

---

## 指标上报 `/api/metrics`

### `POST /api/metrics/ad-segments/open`

广告段开始。

```json
{ "roomId":"room_xxx", "startAt":"2026-09-02T13:00:00.000Z",
  "confidence": 0.78,
  "signals": { "repeatRatio":0.4, "sceneChangeRate":0.5, "audioStability":0.6, "keywordScore":0 } }
```

→ `201 { "id": "ad_xxx" }`

### `POST /api/metrics/ad-segments/:id/close`

广告段结束并结算时长。

```json
{ "endAt": "2026-09-02T13:05:00.000Z", "note": "可选备注" }
```

时长 < 5s 的段会被自动丢弃：

```json
{ "ok": true, "discarded": true, "reason": "duration<5s" }
```

### `POST /api/metrics/ad-segments/manual`

人工校正。

| 字段 | 类型 | 说明 |
|---|---|---|
| `roomId` | string | ✅ |
| `startAt` / `endAt` | string | ✅ ISO 时间 |
| `isAd` | boolean | `true` 补标为广告，默认 `true` |
| `note` | string | 备注 |

`isAd=false` 时，把覆盖区间内的自动段标记 `verified=1`（保留数据供回溯）。

### `GET /api/metrics/ad-segments`

查询参数：`roomId`、`from`、`to`。最多返回 500 条。

---

## 报表 `/api/reports`

所有报表接口支持 `days`（默认 7）或 `from` / `to`（ISO 时间）。

### `GET /api/reports/summary`

```json
{ "range": {...}, "activeRooms": 9, "sessionCount": 42, "totalLiveSec": 360000,
  "totalLiveHours": 100.0, "peakOnline": 12345, "totalAdSec": 90000,
  "totalAdCount": 130, "adRatio": 0.25 }
```

### `GET /api/reports/by-room`

```json
{ "items": [{ "id":"room_xxx","platform":"douyin","title":"...","anchor_name":"...",
              "sessionCount":5,"liveSec":18000,"liveHours":5.0,"peakOnline":3000,
              "avgOnline":1200,"adCount":12,"adSec":3600,"adHours":1.0,"adRatio":0.2 }] }
```

### `GET /api/reports/room/:id`

单房间明细：`room` / `sessions` / `onlineSeries`（`[{t, v}]`）/ `adSegments`。

### `GET /api/reports/export.csv`

CSV 导出，带 UTF-8 BOM（Excel 直接打开不乱码）。

| 列 | 说明 |
|---|---|
| 平台 / 直播间 / 主播 | 房间元信息 |
| 开播时间 / 下播时间 | 场次起止（本地时区） |
| 直播时长(秒) / 峰值在线 / 平均在线 | 场次指标 |
| 广告段数 / 广告时长(秒) / 广告占比 | 广告指标 |
