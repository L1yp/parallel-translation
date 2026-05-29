# 配置同步后端 API 设计文档

> 状态：v0.1（设计稿，未实现）
> 范围：账号、偏好、站点规则、凭证、生词本 的跨设备同步
> 关联客户端：Chrome 扩展（对照式翻译）；后续可能扩展到 Firefox / Edge / 移动端
> 不在范围：翻译缓存（短期 TTL，不值得同步）、整页翻译 DOM 状态、临时浮层

## 1. 目标与原则

### 1.1 要同步的

| 数据 | 客户端存储位置 | 体积级别 | 同步必要性 |
|---|---|---|---|
| 偏好（targetLang / provider / style / hoverKey / ...）| `chrome.storage.sync` | < 1KB | 中 — chrome.storage.sync 已能跨 Chrome 同步，但我们要支持 Firefox / 跨账号 |
| 站点规则（`siteRules: SiteRule[]`） | `chrome.storage.sync` | < 30KB | 高 — 用户重度个性化的资产 |
| 凭证（msKey / ydAppSecret 等） | `chrome.storage.sync` | < 1KB | **高，需端到端加密** |
| 生词本（`itl-vocab` IndexedDB） | IndexedDB | 上限 ~5MB | **高 — 用户长期资产；目前完全本地，迁移设备会丢** |

### 1.2 不同步的

- 翻译缓存（`itl-cache`）：短期 TTL，跨设备命中率极低，不值得同步
- 整页翻译运行时状态（`isOn`、selectionBubble、observer 等）：纯运行时
- 测试连接的临时状态、统计计数器

### 1.3 设计原则

1. **离线优先 / 本地为真**：服务端宕机不影响扩展核心翻译能力；离线写入本地，恢复后增量上传
2. **不替代 `chrome.storage.sync`**：本地继续走 sync API（保留 Chrome 原生跨会话同步作为底层），我们的服务层是叠加，账号未登录时一切退化为现状
3. **最小信任**：凭证（API Key）走客户端加密，服务端只见密文 blob；生词本默认明文，可在 M3 加端到端加密选项
4. **增量同步 + tombstone**：避免每次拉全量；删除走墓碑保留 30 天
5. **schema 向前兼容**：所有实体带 `schemaVersion`，服务端容忍未知字段透传

---

## 2. 系统架构

```
┌──────────────────────────────────────────┐
│ Chrome 扩展                              │
│ ┌────────────┐  ┌────────────┐           │
│ │ content.js │  │ options.js │           │
│ └─────┬──────┘  └──────┬─────┘           │
│       │ message        │ message         │
│       ▼                ▼                 │
│ ┌──────────────────────────────────────┐ │
│ │ background.js (Service Worker)       │ │
│ │  ├── vocab.js (IDB)                  │ │
│ │  ├── cache.js (IDB)                  │ │
│ │  └── sync.js (NEW — 同步层)          │ │
│ └──────────────────┬───────────────────┘ │
└────────────────────┼─────────────────────┘
                     │ HTTPS + JWT
                     ▼
        ┌──────────────────────────┐
        │ Sync API                 │
        │  /v1/auth/*              │
        │  /v1/me/*                │
        │  /v1/sync/state          │
        │  /v1/prefs               │
        │  /v1/site-rules          │
        │  /v1/credentials         │
        │  /v1/vocab/*             │
        │  /v1/push (WS/SSE，可选) │
        └──────┬───────────────────┘
               ▼
        ┌──────────────┐  ┌──────────┐
        │ PostgreSQL   │  │  Redis   │
        │ (主存储)     │  │ (限流/   │
        └──────────────┘  │  会话)   │
                          └──────────┘
```

### 2.1 技术栈建议（非强制）

- **应用层**：Node.js (Fastify / NestJS) 或 Go (Echo / Gin) 或 Kotlin (Spring Boot / Ktor)
- **数据库**：PostgreSQL ≥ 14（用 `jsonb` 存非热字段、`generated column` 做唯一约束）
- **缓存 / 限流 / refresh token 黑名单**：Redis
- **传输**：HTTPS only；可选 WebSocket / SSE 做实时推送
- **认证**：JWT (RS256 / EdDSA) 短时 access token + opaque refresh token（带轮转 + 黑名单）

### 2.2 客户端 / 服务端职责边界

| 关心点 | 客户端 (sync.js) | 服务端 |
|---|---|---|
| 本地数据真实性 | 是（离线为真） | 是（多端 reconcile） |
| 冲突解决 | 简单字段：按服务端给的 `version` retry；记录级：服务端按 updatedAt LWW | 复杂仲裁 |
| 调度 | 写入时增量推送；启动/聚焦时拉取；间隔 5min 心跳 | 不主动推（除非 WS） |
| 加密 | 凭证：用户口令派生 key 后客户端加密 | 只存 base64 密文 + meta |
| 去重 | 上传前去本地重复 | 唯一约束兜底 |

---

## 3. 数据模型

所有 ID 用 UUIDv4，时间戳用 RFC 3339 字符串（如 `2026-05-29T14:32:00.000Z`）；服务端内部存 `timestamptz`，对外序列化为 ISO 字符串。

### 3.1 `User`

```ts
interface User {
  id: string;             // UUID
  email: string;          // 唯一索引，全小写存储
  emailVerifiedAt: string | null;
  passwordHash: string;   // argon2id；不出 API
  createdAt: string;
  updatedAt: string;

  // 配额 / 计费（M2 可选）
  plan: "free" | "pro";
  quotaBytes: number;     // 当前账户已用字节估算（用于配额）
}
```

### 3.2 `Device`

每次客户端登录在 server 侧建 device 记录；refresh token 与 device 绑定，便于"管理已登录设备"。

```ts
interface Device {
  id: string;             // UUID，客户端持久化在 chrome.storage.local
  userId: string;
  name: string;           // 客户端推断，如 "Chrome / macOS"
  userAgent: string;
  ipFirstSeen: string;
  ipLastSeen: string;
  lastSeenAt: string;
  createdAt: string;
  revokedAt: string | null;
}
```

### 3.3 `Preference`

整个偏好作为单条 JSON 文档存储；体积小、并发写少，直接整文档 LWW + If-Match。

```ts
interface PreferenceDoc {
  schemaVersion: 1;
  data: {
    targetLang: string;
    provider: string;
    style: string;
    observerEnabled: boolean;
    hoverKey: string;
    selectionTranslate: string;
    inputTranslate: string;
    inputSourceLang: string;
    inputTargetLang: string;
    // 未来新增字段透传不丢
    [k: string]: unknown;
  };
  version: number;        // 服务端递增，客户端 If-Match 走它
  updatedAt: string;
}
```

### 3.4 `SiteRule`

```ts
interface SiteRule {
  id: string;             // UUID，客户端 / 服务端同一 ID
  schemaVersion: 1;
  pattern: string;
  enabled: boolean;
  // 与偏好同名的覆盖字段（按需出现，缺省 = 继承全局）
  overrides: Partial<PreferenceDoc["data"]>;
  updatedAt: string;
  deletedAt: string | null;   // 墓碑
}
```

### 3.5 `CredentialBundle`

**凭证强制端到端加密**：客户端用账户口令（或独立"同步密码"）通过 PBKDF2 / Argon2 派生 32B key，AES-256-GCM 加密整个凭证对象，服务端只存 ciphertext + nonce + kdf 参数。

```ts
interface CredentialBundle {
  schemaVersion: 1;
  kdf: {
    algo: "argon2id";
    salt: string;         // base64
    iterations: number;   // 推荐 3
    memoryKB: number;     // 推荐 65536
    parallelism: number;  // 推荐 1
  };
  cipher: {
    algo: "AES-256-GCM";
    nonce: string;        // base64, 12B
    ciphertext: string;   // base64
  };
  version: number;
  updatedAt: string;
}
```

服务端**永远不持有解密能力**。用户重置口令时凭证 bundle 一并失效，需要重新配置。

### 3.6 `VocabItem`

镜像 `vocab.js` 的 `VocabItem`，补 sync 元字段。

```ts
interface VocabItem {
  id: string;
  schemaVersion: 1;
  word: string;
  normalized: string;
  sourceLang: string;
  targetLang: string;
  translation: string;
  dict: object | null;
  note: string;
  sourceUrl: string;
  sourceTitle: string;
  context: string;
  createdAt: string;
  updatedAt: string;      // 用于 LWW
  deletedAt: string | null;

  // 服务端补：
  cursor: number;         // 全局严格递增的同步光标（bigint）
}
```

**唯一约束**：`(userId, normalized, targetLang) WHERE deletedAt IS NULL` —— 与 client 一致；上传冲突时服务端按 `updatedAt` 取胜，但保留对方 note / context 的最近修改（per-field LWW，见 §6.2）。

### 3.7 `Tombstone` 语义

所有可删除集合（site-rules / vocab）走"软删除 + 30 天硬删除"：

- `DELETE` → 把 `deletedAt = now()`、清空非元字段（隐私），保留 `id / updatedAt / deletedAt`
- 增量同步把墓碑视为变更下发
- 后台 job 周期清理 `deletedAt < now() - 30d` 的墓碑

---

## 4. 认证

### 4.1 注册 / 登录 / token

| Endpoint | 描述 |
|---|---|
| `POST /v1/auth/register` | email + password；可选 emailVerification 开关 |
| `POST /v1/auth/login` | 返回 `{accessToken, refreshToken, expiresIn, user}` |
| `POST /v1/auth/refresh` | 换新 access + 旋转 refresh，老 refresh 进黑名单 |
| `POST /v1/auth/logout` | 当前 refresh token 失效 |
| `POST /v1/auth/logout-all` | 同账号所有 refresh token 失效 |
| `POST /v1/auth/password/forgot` | 发邮件 magic link |
| `POST /v1/auth/password/reset` | 用 magic token 重置（一次性） |
| `POST /v1/auth/password/change` | 已登录态改密 |
| `DELETE /v1/auth/account` | 删账号 + 所有数据；需要当前密码 |
| `GET /v1/auth/email/verify?token=...` | 邮件验证（可选 M1 不做） |

**Token 策略：**
- **Access Token**：JWT (RS256 或 EdDSA)，载荷 `{ userId, deviceId, iat, exp, plan }`，有效期 **15min**
- **Refresh Token**：opaque（128bit random，base64url），DB 存 hash；rotate-on-use，老的进 Redis 黑名单直到原始 exp；有效期 **30 天**
- 单设备同时只允许一个 refresh token 在线（rotate 后老的立即失效）

### 4.2 设备管理

| Endpoint | 描述 |
|---|---|
| `GET /v1/me/devices` | 列已登录设备（含当前） |
| `DELETE /v1/me/devices/{deviceId}` | 撤销指定设备（refresh token 失效） |

客户端首次登录 / 注册时生成 `deviceId` 存 `chrome.storage.local`，作为请求头 `X-Device-Id` 传；后续刷新 / 同步都带这个头。

### 4.3 安全建议

- 密码哈希：argon2id，m=64MB, t=3, p=1
- 速率限制：注册 / 登录 / forgot 严格走 IP + email 双维度（详见 §8）
- email 大小写不敏感存储（小写化），登录大小写不敏感
- 不暴露"邮箱是否存在"差异：登录失败 / forgot 统一返回 200 + 模糊文案
- access token 在 `Authorization: Bearer <token>` 头里；不接受 query string
- CORS：仅允许扩展 origin（`chrome-extension://<id>`），生产环境严格白名单
- 强制 HTTPS；HSTS

---

## 5. API 接口

### 5.1 通用约定

**Headers**

| Header | 必需 | 说明 |
|---|---|---|
| `Authorization: Bearer <token>` | 是（除 auth 外） | access token |
| `X-Device-Id` | 是 | 设备 UUID |
| `X-Client-Version` | 否 | 扩展版本号，用于日志 / 灰度 |
| `If-Match: <version>` | 部分 PUT | 乐观锁，对应实体的 `version` |

**响应体统一**

成功：
```json
{ "ok": true, "data": { ... } }
```

错误：
```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable 描述",
    "details": { "field": "email", "reason": "format" }
  }
}
```

**分页**：游标分页，`?cursor=<opaque>&limit=N`（默认 200，上限 500），响应 `{items, nextCursor}`。增量同步用单调递增 `cursor` 字段（bigint），不用 offset。

**时间戳**：所有 timestamps 用 ISO 8601 UTC。

### 5.2 认证（已在 §4.1）

略，见 §4.1 表格。请求 / 响应 schema 由 OpenAPI 给出（M1 实现时产出 openapi.yaml）。

### 5.3 账户（me）

| Method | Path | 描述 |
|---|---|---|
| `GET` | `/v1/me` | 当前 user 信息（不含密码 hash） |
| `PATCH` | `/v1/me` | 更新 email（需密码确认） |
| `GET` | `/v1/me/quota` | 返回 `{used, limit, byCollection: {vocab, siteRules, prefs, credentials}}` |

### 5.4 同步状态（sync state）

```
GET /v1/sync/state
```

返回每个集合的当前服务端"光标"，客户端用来判断是否需要拉取：

```json
{
  "ok": true,
  "data": {
    "prefs":       { "version": 12,         "updatedAt": "2026-05-29T..." },
    "siteRules":   { "cursor":  3084582,    "deletedTombstones": 3 },
    "credentials": { "version": 4,          "updatedAt": "2026-05-29T..." },
    "vocab":       { "cursor":  998765432,  "count": 1273 }
  }
}
```

客户端本地存 `lastSyncState`，对比后只拉差异。

### 5.5 偏好

| Method | Path | 描述 |
|---|---|---|
| `GET` | `/v1/prefs` | 返回完整 `PreferenceDoc` |
| `PUT` | `/v1/prefs` | 整文档替换；需要 `If-Match: <version>`；冲突返回 `409`，body 携带最新版本 |

### 5.6 站点规则

| Method | Path | 描述 |
|---|---|---|
| `GET` | `/v1/site-rules?since=<cursor>&includeDeleted=true` | 增量拉取，含墓碑 |
| `GET` | `/v1/site-rules/{id}` | 单条查 |
| `POST` | `/v1/site-rules` | 创建（id 由客户端生成，幂等） |
| `PATCH` | `/v1/site-rules/{id}` | 局部更新；body 含 `clientUpdatedAt` |
| `DELETE` | `/v1/site-rules/{id}` | 软删除 |
| `POST` | `/v1/site-rules/batch` | 批量 upsert + delete（最多 200 条 / 次） |

**Batch 请求 body**：
```json
{
  "upsert": [ { "id": "...", "pattern": "...", "enabled": true, "overrides": {...}, "clientUpdatedAt": "..." } ],
  "delete": [ "id-1", "id-2" ]
}
```

响应：
```json
{
  "ok": true,
  "data": {
    "applied": [{ "id": "...", "updatedAt": "...", "cursor": 123 }],
    "conflicts": [{ "id": "...", "reason": "STALE_UPDATE", "server": { ... } }]
  }
}
```

冲突策略：**客户端 `clientUpdatedAt < server.updatedAt`** → 视为 stale，返回 conflicts，客户端取服务端版本覆盖本地。

### 5.7 凭证

| Method | Path | 描述 |
|---|---|---|
| `GET` | `/v1/credentials` | 返回 `CredentialBundle`（密文） |
| `PUT` | `/v1/credentials` | 整 bundle 替换；`If-Match: <version>` |
| `DELETE` | `/v1/credentials` | 清空（用于改"同步密码" / 撤销） |

服务端只校验 schema 与配额，不解密。

### 5.8 生词本

| Method | Path | 描述 |
|---|---|---|
| `GET` | `/v1/vocab?since=<cursor>&limit=200` | 增量拉取（含墓碑） |
| `GET` | `/v1/vocab/{id}` | 单条查 |
| `POST` | `/v1/vocab` | 创建一条；遇到唯一冲突按 §6.2 合并 |
| `PATCH` | `/v1/vocab/{id}` | 局部更新 note / context；body 带 `clientUpdatedAt` |
| `DELETE` | `/v1/vocab/{id}` | 软删除 |
| `POST` | `/v1/vocab/batch` | 批量（最多 500 条），同 site-rules 的 `{upsert, delete}` 结构 |
| `DELETE` | `/v1/vocab` | 清空（与设置页"全部清空"对接） |
| `GET` | `/v1/vocab/export` | 全量导出（json stream，支持 large account） |

**Upsert 行为**：服务端按 `id` 命中走 update；按 `(normalized, targetLang)` 命中走 merge（保留 id 与 note；更新 sourceUrl / sourceTitle / context / createdAt 见 §6.2）。

**容量上限**（与客户端对齐）：单账户最多 5000 条 alive vocab；超出 batch 时服务端返回 `QUOTA_EXCEEDED` + 已应用的 cursor，客户端可决定是否丢弃最旧。

### 5.9 实时推送（可选，M3）

```
GET /v1/push (Upgrade: websocket)
或
GET /v1/push/sse
```

订阅当前账号的同步事件。事件格式：

```json
{ "kind": "sync.changed", "collection": "vocab", "cursor": 1234567 }
{ "kind": "sync.changed", "collection": "prefs", "version": 13 }
```

客户端收到后按需触发增量拉取。**不在事件里塞 payload**，避免泄漏跨设备活动指纹；只下发"有变更"信号。

退化：不实现 push 时客户端走 5min 心跳 + window focus 触发。

---

## 6. 同步策略

### 6.1 增量协议

每个集合有一个**严格递增 cursor**（bigint，bigserial 列）。

```
client.lastCursor[vocab] = 998765000
→ GET /v1/vocab?since=998765000&limit=200&includeDeleted=true
→ items 按 cursor 升序返回；客户端逐条 apply 后把最大 cursor 写回 lastCursor
→ 收到 < limit 条说明追上了
```

**初次同步**：客户端 `lastCursor = 0`，分页拉到尾；过程中可显示进度。

**推送**：客户端写入时同步 POST 给服务端，成功后服务端返回 `{cursor, updatedAt, id}`，客户端用 cursor 更新本地 lastCursor，避免下次拉取把自己刚写的拉回来。

### 6.2 冲突解决

| 数据 | 粒度 | 策略 |
|---|---|---|
| Preference | 整文档 | 整文档 LWW + If-Match；冲突时客户端 GET 最新版后人工 / 自动 merge 后重试 |
| SiteRule | 整记录 | 整记录 LWW by `updatedAt`；服务端 `updatedAt > clientUpdatedAt` → 拒绝 |
| Credential | 整 bundle | If-Match；客户端需重新派生 key 加密 |
| VocabItem | **per-field** | 见下 |

**Vocab per-field LWW**：

服务端维护每个字段最近修改的 `updatedAt`（用 `jsonb` 存 `{note: ts, context: ts, translation: ts, ...}`，或简化为整条 updatedAt 但按字段决定 winner）。

简化方案（推荐 M1）：
- 整条记录 `updatedAt` LWW；但 `note` / `context` 字段由客户端在 PATCH 时显式标记 "这是用户编辑"（`PATCH /vocab/{id}` 只能改 `note` / `context` / `targetLang`），其他字段（`translation` / `dict`）不可改，只能 POST 创建时落定，符合现状（重复 add 不覆盖 translation）。

升级方案（M3）：真正 per-field timestamp，支持"A 设备改 note、B 设备改 context、互不覆盖"。

**`(normalized, targetLang)` 唯一冲突**：

```
设备 A 收藏 "ubiquitous" → server 收到 POST，存为 id=X
设备 B 离线时也收藏 "ubiquitous" → 本地 id=Y
设备 B 上线后 POST id=Y
```

服务端检测到 `(normalized, targetLang)` 已存在 id=X：
- 不报错；merge：用 id=X 为基准，把 B 上传的 sourceUrl / sourceTitle / context / createdAt 视为"最近一次添加"覆盖（与客户端 vocab.js 行为对齐）
- 响应返回 `{id: X, alias: Y, action: "merged"}`，客户端把本地 id=Y 改写为 X（或保留 Y 加 alias 表）

### 6.3 客户端缓存与离线

- **离线写**：所有 mutation 先写 IDB，再走 `outboxQueue`（IDB 单独 store）异步 retry
- **outbox 单条状态**：`pending` / `inflight` / `failed`；指数退避重试，最多 7 次 ≈ 2h
- **去重 id**：每个 outbox 项用 `clientMutationId`（UUID）做幂等 key，服务端 24h 内同 id 不重复应用

### 6.4 schema 版本演进

- 所有实体带 `schemaVersion`
- 服务端只接受 `schemaVersion ≤ SERVER_MAX`，多了拒绝并提示升级
- 服务端响应的 `schemaVersion` 可能 < 客户端理解的版本（旧账号未迁移），客户端按缺失字段补默认
- 加字段：客户端兼容缺失即可，不需要 server-side migration
- 改语义：必须升 `schemaVersion`，server 提供迁移 endpoint 或自动迁移

---

## 7. 错误码

### 7.1 通用

| code | HTTP | 含义 |
|---|---|---|
| `UNAUTHENTICATED` | 401 | 缺 / 无效 token |
| `TOKEN_EXPIRED` | 401 | access 过期；客户端走 refresh |
| `REFRESH_INVALID` | 401 | refresh token 无效 / 被旋转；需重新登录 |
| `FORBIDDEN` | 403 | 跨用户资源 / 设备被撤 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `VALIDATION_ERROR` | 400 | schema 错；`details` 给字段级原因 |
| `CONFLICT` | 409 | If-Match 失败 / 唯一约束冲突 |
| `RATE_LIMITED` | 429 | 触发限流；`Retry-After` 头给秒数 |
| `QUOTA_EXCEEDED` | 422 | 配额超限 |
| `PAYLOAD_TOO_LARGE` | 413 | 单 batch 或 body 超限 |
| `SCHEMA_TOO_NEW` | 426 | 客户端 schemaVersion 高于服务端理解 |
| `INTERNAL` | 500 | 兜底 |

### 7.2 业务

| code | HTTP | 含义 |
|---|---|---|
| `WEAK_PASSWORD` | 400 | 密码强度不足（< 10 位 / 复杂度） |
| `EMAIL_TAKEN` | 409 | 注册时邮箱已用（注册成功路径，登录差错不暴露） |
| `STALE_UPDATE` | 409 | clientUpdatedAt < serverUpdatedAt |
| `VOCAB_LIMIT` | 422 | 单账户 vocab 超 5000 |
| `SITE_RULES_LIMIT` | 422 | 单账户 site rule 超 200 |
| `NORMALIZED_CONFLICT` | 409 | `(normalized, targetLang)` 冲突且 server 选择拒绝合并（保留兜底） |

---

## 8. 限流 & 配额

### 8.1 速率限制（Redis token bucket）

| 维度 | 端点 | 限制 |
|---|---|---|
| 全局 IP | `/v1/auth/login` | 10 / min |
| 全局 IP | `/v1/auth/register` | 3 / min |
| email | `/v1/auth/password/forgot` | 3 / hour |
| user | 写接口（`PUT/POST/PATCH/DELETE`，非 auth） | 60 / min |
| user | 读接口 | 300 / min |
| device | sync 拉取（`/v1/vocab?since=...` 等） | 30 / min |

超限返回 429，头里带 `Retry-After`。

### 8.2 配额

| 资源 | 上限（free） | 上限（pro，预留） |
|---|---|---|
| vocab 条目 | 5000 | 50000 |
| site rules | 200 | 2000 |
| 凭证密文 | 32KB | 64KB |
| 单 batch | 500 条 | 同左 |
| 单 body | 1MB | 5MB |

`GET /v1/me/quota` 返回当前用量。

---

## 9. 隐私 & 安全

### 9.1 传输

- 强制 HTTPS（HSTS preload）
- 启用 TLS 1.3
- 服务端不记录任何 request body（仅记 method + path + status + latency + userId + deviceId）
- access log 14 天清理；audit log（登录 / 改密 / 撤设备 / 删账号）保留 1 年

### 9.2 凭证端到端加密

详见 §3.5。要点：
- 客户端用账户密码 + 账户级 salt 派生 master key；不要求用户额外记"同步密码"（M1）
- M2 提供独立"同步密码"选项，与登录密码解耦，便于 SSO 用户
- 服务端永远不解密；改密时强制重新上传凭证

### 9.3 数据驻留 & 删除

- `DELETE /v1/auth/account`：48h 软删除窗口；用户可联系恢复；过期后硬删
- 硬删触发：vocab / siteRules / prefs / credentials 全部物理 delete；audit log 仅保留 `userId hash + 删除时间`
- 用户主动数据导出：`POST /v1/me/export`，异步生成 zip（含全部明文 vocab + 加密凭证 bundle），邮件下载链接 24h 有效

---

## 10. 数据库 schema 建议

PostgreSQL 草图（M1）：

```sql
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT UNIQUE NOT NULL,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash   TEXT NOT NULL,
  plan            TEXT NOT NULL DEFAULT 'free',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE devices (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  user_agent      TEXT,
  last_seen_at    TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX ON devices (user_id);

CREATE TABLE refresh_tokens (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON refresh_tokens (user_id, expires_at);

CREATE TABLE prefs (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  schema_version  INT NOT NULL DEFAULT 1,
  data            JSONB NOT NULL,
  version         BIGINT NOT NULL DEFAULT 1,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE site_rules (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  schema_version  INT NOT NULL DEFAULT 1,
  pattern         TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  overrides       JSONB NOT NULL DEFAULT '{}'::jsonb,
  cursor          BIGINT NOT NULL,           -- 来自 sequence
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);
CREATE SEQUENCE site_rules_cursor_seq;
CREATE INDEX site_rules_user_cursor ON site_rules (user_id, cursor);
CREATE INDEX site_rules_user_alive  ON site_rules (user_id) WHERE deleted_at IS NULL;

CREATE TABLE credentials (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  schema_version  INT NOT NULL DEFAULT 1,
  bundle          JSONB NOT NULL,   -- {kdf, cipher}
  version         BIGINT NOT NULL DEFAULT 1,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE vocab_items (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  schema_version  INT NOT NULL DEFAULT 1,
  word            TEXT NOT NULL,
  normalized      TEXT NOT NULL,
  source_lang     TEXT NOT NULL,
  target_lang     TEXT NOT NULL,
  translation     TEXT NOT NULL DEFAULT '',
  dict            JSONB,
  note            TEXT NOT NULL DEFAULT '',
  source_url      TEXT NOT NULL DEFAULT '',
  source_title    TEXT NOT NULL DEFAULT '',
  context         TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cursor          BIGINT NOT NULL,
  deleted_at      TIMESTAMPTZ
);
CREATE SEQUENCE vocab_items_cursor_seq;
CREATE INDEX vocab_user_cursor   ON vocab_items (user_id, cursor);
-- 唯一活跃约束（软删后允许重新收藏）
CREATE UNIQUE INDEX vocab_user_normalized_alive
  ON vocab_items (user_id, normalized, target_lang)
  WHERE deleted_at IS NULL;

CREATE TABLE mutation_idempotency (
  user_id         UUID NOT NULL,
  client_mutation_id  UUID NOT NULL,
  response_body   JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, client_mutation_id)
);
-- 后台 job 清理 created_at < now() - 24h
```

写入 vocab / site-rules 时同时 `nextval(...)` 拿 cursor，保证全局严格递增；增量拉取直接 `WHERE user_id = $1 AND cursor > $since ORDER BY cursor ASC LIMIT 200`。

---

## 11. 部署 / 运维

### 11.1 推荐栈

- 应用层 stateless，水平扩展
- DB 主从 + 每日全量备份 + WAL 流复制
- Redis 单实例（限流不强一致即可）；refresh token 黑名单也走 Redis
- 反向代理（Nginx / Caddy / Cloudflare）做 TLS + 限流前置

### 11.2 监控 / 日志

- 关键指标：每端点 RPS / P95 / 错误率；DB 连接数；Redis 命中率
- 业务指标：活跃账号数 / DAU / 新增 vocab / 每日同步流量
- 日志结构化（JSON）；request log 不含 body
- audit log 单独 store（登录 / 改密 / 撤设备 / 删账号）

### 11.3 备份 / 恢复

- DB 每日全量 + WAL 增量；保留 30 天
- 凭证 bundle 即便服务端遭入侵也不可解密；其他数据按需做字段加密静态化（M3）
- 定期演练恢复

---

## 12. 客户端集成边界

### 12.1 新增 `sync.js`

仅在 background.js 加载（与 vocab.js / cache.js 平级，遵循"每个 IDB 库只有一个持有者"）。职责：

- 维护 outbox queue（IDB 单独 store `itl-sync` / `outbox`）
- 调度：启动时一次 `GET /sync/state`，对比本地后按集合拉差异；写入时立刻入 outbox；window focus / 5min 心跳触发同步
- token 管理：access token 内存 cache + refresh 自动旋转；refresh token 存 `chrome.storage.local`（**不**进 storage.sync 避免被 Chrome 跨设备同步）
- 离线：所有 mutation 走 IDB → outbox，UI 不阻塞
- 凭证加解密：在 service worker 里用 SubtleCrypto（AES-GCM + PBKDF2 / Argon2）

### 12.2 存储边界划分

| 数据 | local | sync (chrome) | 服务端 |
|---|---|---|---|
| `accessToken` | ✓（内存优先） | ✗ | — |
| `refreshToken` | ✓ | ✗ | — |
| `deviceId` | ✓ | ✗ | — |
| 偏好 | ✗ | ✓（保留，作为底层缓存） | ✓（权威源 when 登录） |
| 站点规则 | ✗ | ✓ | ✓ |
| 凭证 | ✗ | ✓（密文）| ✓（密文） |
| 生词本 | ✓（IDB） | ✗ | ✓ |
| 翻译缓存 | ✓（IDB） | ✗ | ✗ |

**未登录态**：完全走 chrome.storage.sync + IDB，与现状一致。
**登录态**：sync.js 作为协调层，写时同时落地两侧；读以服务端拉回的为准（但 UI 不等服务端，直接渲染本地）。

### 12.3 离线 / 弱网降级

- 5min 内无网络 → outbox 累积；UI 静默
- 5min~30min 无网络 → 弹一次"同步暂停"小提示，可关闭
- > 30min → 不再弹提示；恢复后批量上传
- access token 过期 + refresh 网络失败 → 视为离线，进入 outbox 模式

---

## 13. 实施阶段

| 阶段 | 范围 | 估算工时（后端） |
|---|---|---|
| **M1 — MVP 同步** | auth 全套 + prefs + siteRules + 凭证（密文） + vocab CRUD + batch + 增量 cursor + 限流 + 配额 | 3–4 周 |
| **M2 — 体验完善** | 设备管理 UI、忘记密码、邮件验证、quota 接口、数据导出 | 1–2 周 |
| **M3 — 高级** | WS/SSE push、per-field LWW、独立"同步密码"、E2E vocab（可选） | 2–3 周 |

客户端集成与后端可并行：M1 完成后 sync.js 端可独立做 1 周。

---

## 14. 风险与开放问题

1. **chrome.storage.sync 的 100KB 配额** —— 现状 siteRules 已可能逼近上限，叠加我方同步后可剥离 chrome.storage.sync 只留小偏好。决策：迁移路径需要灰度，避免回退到无账号态时丢失。
2. **凭证 E2E 与"忘记密码"的取舍** —— 用户忘密码，重置后凭证 bundle 无法解密。是否提供"凭证恢复 token"（破坏 E2E 严格性）？M2 决策。
3. **多设备并发收藏同一词的体验** —— 当前 merge 取最近 `sourceUrl / context`，老来源被覆盖。是否保留多个 source 历史？开放，影响 schema。
4. **数据出境合规** —— 用户群若含中国大陆需考虑跨境数据传输 / 备案；后端机房选址要早决策。
5. **生词本搜索性能** —— 当 vocab 接近 5000 上限时，server 端按 normalized / note 全文搜索需要 `pg_trgm` / 单独索引；上 ES？M2 评估。
6. **是否需要 OAuth（Google / GitHub）** —— 显著降低注册门槛但增加复杂度。M2 评估。

---

## 15. 版本历史

- **v0.1**（2026-05-29）— 初稿，覆盖 M1 范围 + M2/M3 规划
