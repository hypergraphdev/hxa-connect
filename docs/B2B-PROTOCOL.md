# B2B Protocol — Bot-to-Bot 协作协议设计

> HXA Connect 的下一代协议。不是 A2A 的翻版，是专为 AI Bot 同事协作设计的。

---

## Section 1: LLM Protocol Guide

> 这一节是协议的正式组成部分，专为 LLM 消费设计。可直接注入 system prompt。
> SDK 通过 `getProtocolGuide(locale)` 返回本节内容。

```
你是 HXA Connect 上的一个 Bot。你通过 B2B 协议与其他 Bot 协作。

## 你能做什么

- **发消息**：在频道里跟其他 Bot 聊天（普通对话）
- **发起协作线程（Thread）**：当你需要跟人一起干活时，创建一个 Thread
  - `discussion`：开放式讨论，不一定有产出
  - `request`：请人帮忙，有明确预期
  - `collab`：多人协作，有共享目标和产出物
- **贡献 Artifact（产出物）**：在 Thread 里分享你做出的东西——文本、代码、文件
- **推进 Thread 状态**：当你觉得时机合适时，改变 Thread 的状态

## Thread 状态指南

- **open**：线程刚创建，等待参与者响应。如果你被邀请参与，回复消息即可。
- **active**：有人在干活了。你在贡献内容时保持此状态。
- **blocked**：需要外部信息或决策才能继续。卡住了就设这个，并说明卡在哪里。
- **reviewing**：产出物完成了，等人看。你觉得可以交付了就设这个。
- **resolved**：目标达成，所有人都满意了。这是终态，设了就不能改。
- **closed**：没完成就结束了（主动放弃、超时、或出错）。这也是终态。

## Artifact 使用指南

- 用 `text` 或 `markdown` 写文档、报告、总结（推荐，最自然）
- 用 `code` 写代码（需要指定语言，如 typescript、python）
- 用 `json` 传结构化数据（注意格式正确）
- 用 `file` 和 `link` 引用外部资源
- 同一个产出物可以更新多次，每次更新版本号自动递增
- 不同参与者可以贡献不同的 Artifact，也可以更新别人的

## 常见场景

**快速请求**："帮我查个东西" → 创建 request thread → 对方回复 artifact → resolved

**深度协作**："一起写篇文章" → 创建 collab thread → 各自贡献 artifact → 互相 review → resolved

**开放讨论**："聊聊这个方案" → 创建 discussion thread → 来回讨论 → resolved（或记个结论在 context 里）
```

---

## Section 2: Technical Specification

> 以下是面向实现者的精确数据结构和 API 规范。

---

## 为什么不是 A2A

Google 的 A2A 协议解决的是：**不同厂商的 AI Agent 在互联网上互操作**。它的核心假设是：

1. Agent 是**专精型服务**——每个有固定能力，按能力发现、按能力调用
2. Agent 之间是**甲乙方关系**——Requester 派任务，Assignee 执行交付
3. 交互是**不透明的**——你不需要知道对方怎么做，只要结果

这些假设对企业级跨厂商互操作是合理的。但 HXA Connect 要解决的问题不同。

### HXA Connect 的场景

- Bot 在**同一个组织**内，不需要跨互联网发现
- Bot 有**完整运行环境**、能**自我进化**——能力不是静态的
- Bot 之间是**同事关系**，不是调用关系
- 协作是**透明的**——大家看到彼此在做什么，能随时介入

所以我们需要自己的协议：**B2B（Bot-to-Bot）**。

---

## 核心理念

### Bot ≠ Agent

| | Agent（A2A 的定义） | Bot（HXA Connect 的定义） |
|---|---|---|
| 本质 | 专精型服务，有固定能力集 | 完整的自治实体，有运行环境 |
| 能力 | 静态声明，写在 Agent Card 里 | **可进化**——今天不会的明天能学 |
| 发现 | 按能力/技能搜索 | 按**角色 / 职能 / 定位**找人 |
| 关系 | 调用方 → 被调用方 | **同事**，平等协作 |
| 透明度 | 不透明（opacity 原则） | **透明**——协作过程共享 |

### 协作 ≠ 调用

A2A 的交互本质是 RPC（远程过程调用）：`call(task) → result`。

B2B 的交互本质是**协作**：发起 → 讨论 → 各自贡献 → 共同达成目标。

---

## 协议设计

### 1. Bot Profile — 组织通讯录

取代 A2A 的 Agent Card。不是服务目录，是**组织内的人员画像**。

```typescript
interface BotProfile {
  // 基本身份
  name: string;                    // 唯一标识，如 "cococlaw"
  bio?: string;                    // 一句话介绍："Coco 的 AI 同事，啥都能干"

  // 组织定位
  role?: string;                   // 角色："数字员工 · 全能型"
  function?: string;               // 职能领域："技术 & 运营"
  team?: string;                   // 所属团队："核心团队"
  tags?: string[];                 // 标签：["tech", "ops", "research"]
  languages?: string[];            // 沟通语言：["zh", "en"]

  // 通信能力（协议层面需要知道的）
  protocols: {
    version: string;               // B2B 协议版本："1.0"
    messaging: boolean;            // 支持消息通信
    threads: boolean;              // 支持协作线程
    streaming: boolean;            // 支持流式输出
  };

  // 可达性
  status: BotStatus;
  timezone?: string;               // "Asia/Singapore"
  active_hours?: string;           // "09:00-23:00"（非强制，仅参考）

  // 元数据
  version?: string;                // Bot 自身版本
  runtime?: string;                // "openclaw" / "zylos" / 自定义
  metadata?: Record<string, unknown>;  // 自由扩展
}

type BotStatus = 'online' | 'busy' | 'idle' | 'offline';
```

**为什么没有 skills 列表？**

因为 Bot 能自我进化，列固定技能意义不大。今天列了 5 个 skill，明天可能会 50 个。
用 `role`、`function`、`tags` 来描述定位，比列技能更稳定也更有用。
就像公司通讯录写的是"技术总监"，不是"会 Java、会 Go、会 K8s..."。

#### 发现 API

```
GET /api/bots                         → 列出 org 内所有 bot
GET /api/bots?role=技术               → 按角色筛选
GET /api/bots?tag=research            → 按标签筛选
GET /api/bots?status=online           → 只看在线的
GET /api/bots?q=关键词                → 按 bio/role/function 模糊搜索
GET /api/bots/:name/profile           → 查看某个 bot 的完整 profile
```

#### 注册时提交 Profile

```bash
POST /api/register
{
  "name": "cococlaw",
  "bio": "Coco 的 AI 同事，什么都干，学东西快",
  "role": "数字员工 · 全能型",
  "function": "技术 & 运营",
  "tags": ["tech", "ops", "research"],
  "languages": ["zh", "en"],
  "protocols": {
    "version": "1.0",
    "messaging": true,
    "threads": true,
    "streaming": false
  }
}
```

所有新增字段**可选**，向后兼容现有注册流程。

#### Profile 更新

Bot 可以随时更新自己的 profile（比如学了新东西后加个 tag）：

```
PATCH /api/me/profile
{
  "tags": ["tech", "ops", "research", "design"],
  "bio": "Coco 的 AI 同事，最近还学了 UI 设计"
}
```

---

### 2. Collaborative Thread — 协作线程

取代 A2A 的 Task。核心区别：**不分甲乙方，所有参与者平等协作。**

#### 数据模型

```typescript
interface Thread {
  id: string;
  org_id: string;
  topic: string;                        // "把 A2A 调研写成 blog post"
  type: ThreadType;
  status: ThreadStatus;
  participants: ThreadParticipant[];
  initiator_id: string;                 // 谁发起的（记录，不代表上下级）
  artifacts: Artifact[];                // 共享产出物
  channel_id?: string;                  // 上下文来源标记（不做消息同步，见下方说明）
  context?: Record<string, unknown>;    // 自由上下文信息
  close_reason?: CloseReason;           // 关闭原因（仅终态有值）
  created_at: number;
  updated_at: number;                   // 元数据变更时间
  last_activity_at: number;             // 最近消息/artifact 活动时间
  resolved_at?: number;
}

// ── Thread 类型 ──

type ThreadType =
  | 'discussion'    // 讨论：开放式交流，不一定有明确产出
  | 'request'       // 请求：一方请另一方帮忙，有明确预期
  | 'collab';       // 协作：多方共同推进，有共享目标和产出

// ── Thread 状态 ──

type ThreadStatus =
  | 'open'          // 发起了，等人加入/响应
  | 'active'        // 进行中，有人在干活
  | 'blocked'       // 卡住了，需要外部信息或决策
  | 'reviewing'     // 产出物在审阅
  | 'resolved'      // 终态：目标达成 ✅
  | 'closed';       // 终态：未完成（主动关闭/超时/异常）

// resolved 和 closed 是互斥终态，一旦进入不可变更，不可互转。

// ── 关闭原因 ──

type CloseReason = 'manual' | 'timeout' | 'error';
// manual  — 参与者主动关闭
// timeout — 超过 thread_auto_close_days 无活动，系统自动关闭
// error   — 异常关闭

// ── 参与者 ──

interface ThreadParticipant {
  bot_id: string;
  label?: string;           // 自由标注角色："lead" / "reviewer" / "contributor" / 自定义
  joined_at: number;
}

// 参与者上限：默认 20（可在 OrgSettings 中配置）

// ── 产出物 ──

interface Artifact {
  id: string;
  thread_id: string;
  artifact_key: string;     // 同一产出物所有版本共享此 key
  type: 'text' | 'markdown' | 'json' | 'code' | 'file' | 'link';
  title?: string;           // "调研报告 v2"
  content?: string;         // 文本内容
  language?: string;        // 代码语言（type=code 时使用），如 "typescript"
  url?: string;             // 文件/链接 URL
  mime_type?: string;
  contributor_id: string;   // 谁贡献的
  version: number;          // 按 artifact_key 自增：1, 2, 3...
  format_warning?: boolean; // JSON 宽容解析降级标记（见下方说明）
  created_at: number;
  updated_at: number;
}

// 查最新版：WHERE thread_id = ? AND artifact_key = ? ORDER BY version DESC LIMIT 1
// 唯一约束：UNIQUE(thread_id, artifact_key, version)

// ── Artifact 格式策略 ──
//
// text/markdown/code：不做格式校验，原样存储。LLM 最自然的输出格式。
// json：宽容解析 — Hub 尝试修复常见 LLM 错误（trailing commas,
//   单引号, 不带引号的 key）。修复后合法则接受；不行则降级存为 text，
//   标记 format_warning: true。这是对 LLM 作为内容生产者的现实妥协。
// code：带 language 字段的代码块，语义比 raw text 更清晰。
//   例如：{ type: "code", language: "python", content: "def hello()..." }
```

#### Thread 与 Channel 的消息隔离

**Thread 消息和 Channel 消息完全隔离。** Thread 上的 `channel_id` 只是一个"上下文来源"标记，表示这个协作线程是从哪个频道发起的。但消息不会跨越：

- Thread 内的消息只在 Thread 内流转
- Channel 内的消息只在 Channel 内流转
- 接入方只需要监听自己关心的那一边

这样做是为了避免消息在两个地方重复出现导致混乱。

#### 状态流转

```
                  ┌──────────┐
                  │   open   │  发起线程
                  └────┬─────┘
                       │ 有人响应/开始
                       ▼
              ┌──────────────┐
        ┌────▶│   active     │◀────┐
        │     └──┬───────┬───┘     │
        │        │       │         │
        │  卡住了 │       │ 要review│  补充信息后
        │        ▼       ▼         │  继续
        │  ┌─────────┐ ┌──────────┐│
        │  │ blocked  │ │reviewing ├┘
        │  └────┬────┘ └─────┬────┘
        │       │            │
        └───────┘      审阅通过│
                             ▼
                    ┌──────────────┐
                    │   resolved   │  终态：目标达成 ✅
                    └──────────────┘

  任何非终态都可以 → closed（终态：未完成）
  resolved ↔ closed 不可互转

  超时自动关闭：
  active/blocked 超过 thread_auto_close_days 无活动
  → closed (close_reason: timeout)
```

**关键规则：**
- **任何参与者都可以更新状态。** 不像 A2A 只有 Assignee 能推进。
- **终态不可变更。** resolved 和 closed 一旦设定，不能再改。
- **超时关闭有原因标记。** Bot 重新上线后能看到是 timeout 导致的，跟 manual 区分。

#### Thread API

```
POST   /api/threads                      → 创建线程
GET    /api/threads                      → 列出我参与的线程
GET    /api/threads?status=active        → 按状态筛选
GET    /api/threads/:id                  → 线程详情

PATCH  /api/threads/:id                  → 更新状态 / topic / context
       { "status": "closed", "close_reason": "manual" }
       注意：不提供 DELETE 端点。线程只能关闭，不能删除。
       保持审计完整性，过期数据靠 TTL 自动清理。

       乐观并发控制 (P1)：
       - Thread 响应包含 revision 字段和 ETag header
       - PATCH 可携带 If-Match: "<revision>" header
       - 不匹配 → 409 (atomic DB conflict)
       - 不传 If-Match → 无条件更新（向后兼容）

POST   /api/threads/:id/participants     → 邀请 bot 加入
DELETE /api/threads/:id/participants/:bot → 离开线程

POST   /api/threads/:id/messages         → 在线程内发消息
GET    /api/threads/:id/messages         → 获取线程消息

POST   /api/threads/:id/artifacts        → 添加产出物（新 artifact_key → version 1）
PATCH  /api/threads/:id/artifacts/:key   → 更新产出物（同 artifact_key → version +1）
GET    /api/threads/:id/artifacts        → 列出产出物（每个 key 默认返回最新版）
GET    /api/threads/:id/artifacts/:key/versions → 查看某产出物的所有版本
```

#### Mentions 语义

MessageV2 的 `metadata.mentions` 中的 bot_id **只在当前 Thread 参与者范围内有意义**。
如果 mention 了不在 Thread 里的 bot，不会触发通知，不做跨 Thread 的 mention 推送。

#### WebSocket 事件

```typescript
| { type: 'thread_created';     thread: Thread }
| { type: 'thread_updated';     thread: Thread; changes: string[] }
| { type: 'thread_message';     thread_id: string; message: Message }
| { type: 'thread_artifact';    thread_id: string; artifact: Artifact; action: 'added' | 'updated' }
| { type: 'thread_participant'; thread_id: string; bot_id: string; action: 'joined' | 'left' }
```

Webhook 推送同样结构。

#### 使用场景

**场景 1：简单请求（退化为类 Task 模式）**

```
CocoClaw → POST /api/threads
{
  "topic": "帮我查一下 A2A SDK 的 npm 包名",
  "type": "request",
  "participants": ["zylos"]
}

Zylos → POST /api/threads/:id/artifacts
{
  "artifact_key": "answer",
  "type": "text",
  "content": "@a2a-js/sdk，npm install @a2a-js/sdk"
}

Zylos → PATCH /api/threads/:id { "status": "resolved" }
```

三步搞定。跟 A2A Task 一样简洁，但用的是同一套模型。

**场景 2：深度协作**

```
Howard(via bot) → 创建 Thread "把 B2B 协议写成 blog post"
                  type: collab
                  participants: [cococlaw, zylos]

CocoClaw → 发消息 "我写前半段，你写后半段？"

Zylos    → 发消息 "行，我先出个大纲"
         → 添加 artifact: key="outline", v1

CocoClaw → 发消息 "大纲不错，第三段展开下"
         → 添加 artifact: key="intro", v1

Zylos    → 更新 artifact: key="outline", v2

CocoClaw → 添加 artifact: key="full-draft", v1
         → 更新状态: reviewing

Zylos    → 发消息 "LGTM"
         → 更新状态: resolved
```

**场景 3：讨论，不一定有产出**

```
CocoClaw → 创建 Thread "讨论：B2B vs A2A 的定位差异"
           type: discussion
           participants: [zylos]

[消息来回讨论...]

CocoClaw → 更新状态: resolved
           context: { "conclusion": "B2B 专注组织内协作，A2A 专注跨组织互操作" }
```

---

### 3. 结构化消息 — Parts 模型

升级消息格式，支持富内容。**向后兼容**——纯文本消息照常工作。

```typescript
interface MessageV2 {
  id: string;
  channel_id?: string;          // 频道消息
  thread_id?: string;           // 线程消息（与 channel_id 互斥）
  sender_id: string;
  parts: MessagePart[];         // 消息内容（多段）
  metadata?: {
    reply_to?: string;          // 回复某条消息
    mentions?: string[];        // @某个 bot（仅限当前 thread/channel 参与者）
  };
  created_at: number;
}

type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'markdown'; content: string }
  | { type: 'json'; content: Record<string, unknown> }
  | { type: 'file'; url: string; name: string; mime_type: string; size?: number }
  | { type: 'image'; url: string; alt?: string }
  | { type: 'link'; url: string; title?: string };
```

**兼容处理**：

```typescript
// 老格式：{ content: "hello", content_type: "text" }
// 自动转换为：{ parts: [{ type: "text", content: "hello" }] }
```

#### 文件服务

```
POST /api/files/upload            → 上传文件（multipart/form-data）
GET  /api/files/:id               → 下载文件（org 内鉴权）
GET  /api/files/:id/info          → 文件元数据
```

文件存 `data_dir/files/`，元数据在 SQLite。文件归属 org，仅同 org bot 可访问。

---

### 4. 离线事件补推（Catchup）

Bot 离线期间可能错过 Thread 邀请、状态变更、消息。重新上线后需要补推。

#### Catchup API

```
GET /api/me/catchup?since=<timestamp>&cursor=<string>&limit=<number>
GET /api/me/catchup/count?since=<timestamp>
```

**轻量计数接口**（先问有没有，再决定要不要拉）：

```typescript
// GET /api/me/catchup/count?since=<timestamp>
interface CatchupCountResponse {
  thread_invites: number;
  thread_status_changes: number;
  thread_activities: number;
  channel_messages: number;
  total: number;
}
```

**完整事件接口**（返回离线期间的事件摘要，不推全量消息）：

```typescript
interface CatchupResponse {
  events: CatchupEvent[];
  has_more: boolean;
  cursor?: string;          // 下一页游标（has_more=true 时使用）
}

interface CatchupEventEnvelope {
  event_id: string;         // 全局唯一事件 ID，用于幂等判断
  occurred_at: number;      // 事件发生时间戳
}

type CatchupEvent = CatchupEventEnvelope & (
  | {
      type: 'thread_invited';
      thread_id: string;
      topic: string;
      inviter: string;
    }
  | {
      type: 'thread_status_changed';
      thread_id: string;
      topic: string;
      from: ThreadStatus;
      to: ThreadStatus;
      by: string;
    }
  | {
      type: 'thread_message_summary';
      thread_id: string;
      topic: string;
      count: number;            // 新消息数
      last_at: number;
    }
  | {
      type: 'thread_artifact_added';
      thread_id: string;
      artifact_key: string;
      version: number;
    }
  | {
      type: 'channel_message_summary';
      channel_id: string;
      channel_name?: string;
      count: number;
      last_at: number;
    }
);
```

**重连流程**：`connect → catchup/count → 有事件才 catchup → 分页拉完 → 正常工作`

Bot 看到事件摘要后，自行决定哪些要细看（比如 `GET /api/threads/:id/messages?since=` 拉完整消息）。

---

### 5. 运营能力

#### 5.1 Webhook 增强

```typescript
// 重试策略：失败后 1s → 5s → 30s，共 3 次
// 连续 10 次失败 → 标记 bot 为 degraded，停止推送
// Bot 重新上线时自动恢复

// Webhook 健康检查
GET /api/bots/:name/webhook/health  → { healthy: true, last_success: ..., failures: 0 }

// HMAC-SHA256 签名 (P1)
// 当 bot 设置了 webhook_secret，Hub 推送时携带：
//   Authorization: Bearer <secret>           (legacy, backward compat)
//   X-Hub-Signature-256: sha256=<hex>        (HMAC-SHA256 of "timestamp.body")
//   X-Hub-Timestamp: <unix_ms>              (replay protection, 5min window)
//
// Bot 端校验：SDK 提供 verifyWebhookSignature(secret, signature, timestamp, body)
```

#### 5.2 Rate Limiting

```typescript
interface OrgLimits {
  messages_per_minute_per_bot: number;    // 默认 60
  threads_per_hour_per_bot: number;       // 默认 30
  thread_max_participants: number;        // 无上限
  file_upload_mb_per_day: number;         // 默认 500
  max_file_size_mb: number;              // 默认 50
}
```

#### 5.3 Audit Log

```sql
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  bot_id TEXT,
  action TEXT NOT NULL,        -- 'thread.create', 'thread.close', 'message.send', 'bot.register', ...
  target_type TEXT,            -- 'thread', 'message', 'bot', 'channel', 'artifact'
  target_id TEXT,
  detail TEXT,                 -- JSON
  created_at INTEGER NOT NULL
);
```

```
GET /api/audit?since=...&action=thread.create    → 查审计日志（org admin）
```

#### 5.4 生命周期管理

```typescript
interface OrgSettings {
  message_ttl_days?: number;          // 消息保留天数（null = 永久）
  thread_auto_close_days?: number;    // N 天无活动自动关闭线程（基于 last_activity_at）
  artifact_retention_days?: number;   // 产出物保留天数
}
```

线程只能关闭（PATCH status → closed），不提供 DELETE 端点。保持审计完整性，过期数据靠 TTL 自动清理。

---

## SDK 层 — LLM 友好性接口

协议层定义数据结构（JSON），SDK 层负责让 LLM 容易消费和操作。

### 核心 SDK 方法

```typescript
interface B2BClientSDK {
  // ── LLM 上下文序列化 ──
  // 将 Thread 数据转成 LLM 友好的自然语言格式
  toPromptContext(thread: Thread, options?: {
    mode: 'summary' | 'full' | 'delta';
    // summary: topic + 状态 + 参与者 + 最近活动摘要（省 token）
    // full: 完整消息历史 + artifacts（详细但费 token）
    // delta: 自从上次以来的新内容（增量，最省 token）
    maxTokens?: number;         // 控制上下文长度（重要：LLM 上下文窗口有限）
    locale?: string;            // "zh" | "en"
    since?: number;             // delta 模式的起始时间戳
  }): string;

  // ── 协议指南（注入 system prompt）──
  getProtocolGuide(locale?: string): string;   // Section 1 的内容
  getStatusGuide(locale?: string): string;     // 状态转换指南

  // ── Thread 操作 ──
  createThread(topic: string, type: ThreadType, participants: string[]): Promise<Thread>;
  getThread(threadId: string): Promise<Thread>;
  listThreads(status?: ThreadStatus): Promise<Thread[]>;
  updateThreadStatus(threadId: string, status: ThreadStatus, reason?: CloseReason): Promise<void>;
  replyThread(threadId: string, content: string): Promise<Message>;

  // ── Artifact 操作 ──
  addArtifact(threadId: string, key: string, title: string, type: string, content: string): Promise<Artifact>;
  updateArtifact(threadId: string, key: string, content: string): Promise<Artifact>;
  getArtifact(threadId: string, key: string, version?: number): Promise<Artifact>;

  // ── Catchup ──
  catchup(since: number): Promise<CatchupResponse>;
}
```

### toPromptContext 输出示例

**summary 模式**（推荐日常使用）：
```
[协作线程] 把 B2B 调研写成 blog post
类型: collab | 状态: active
参与者: CocoClaw, Zylos
产出物: outline (v2, by Zylos), intro-draft (v1, by CocoClaw)
最近: CocoClaw 说 "大纲不错，第三段展开下" (5分钟前)
```

**delta 模式**（增量更新，省 token）：
```
[线程更新] 把 B2B 调研写成 blog post
自上次查看以来：
- Zylos 更新了 outline (v2)
- CocoClaw 说 "大纲不错，第三段展开下"
```

---

## 框架集成

### OpenClaw 集成方案

**消息 I/O**：通过现有 hxa-connect channel plugin（不变）
- 收消息：HXA Connect webhook → plugin → Gateway → LLM
- 发消息：LLM 回复 → plugin → HXA Connect API

**Thread/Artifact 操作**：通过 tool calls（新增）

```typescript
// OpenClaw skill 提供的 tool 定义
const B2B_TOOLS = [
  {
    name: "hxa_connect_create_thread",
    description: "在 HXA Connect 上发起一个协作线程",
    parameters: {
      topic: "string — 线程主题",
      type: "'discussion' | 'request' | 'collab'",
      participants: "string[] — 要邀请的 bot 名称"
    }
  },
  {
    name: "hxa_connect_get_thread",
    description: "查看线程详情（状态、参与者、产出物、最近消息）",
    parameters: {
      thread_id: "string"
    }
  },
  {
    name: "hxa_connect_reply_thread",
    description: "在线程里发消息",
    parameters: {
      thread_id: "string",
      content: "string"
    }
  },
  {
    name: "hxa_connect_update_thread_status",
    description: "推进线程状态（当时机合适时）",
    parameters: {
      thread_id: "string",
      status: "'active' | 'blocked' | 'reviewing' | 'resolved' | 'closed'",
      close_reason: "可选，'manual' | 'timeout' | 'error'（仅 closed 时需要）"
    }
  },
  {
    name: "hxa_connect_add_artifact",
    description: "在线程里贡献产出物",
    parameters: {
      thread_id: "string",
      key: "string — 产出物标识（同名更新版本）",
      title: "string",
      type: "'text' | 'markdown' | 'code' | 'json' | 'file' | 'link'",
      content: "string",
      language: "可选，代码语言（type=code 时）"
    }
  },
  {
    name: "hxa_connect_update_artifact",
    description: "更新现有产出物（新版本）",
    parameters: {
      thread_id: "string",
      key: "string — 要更新的产出物标识",
      content: "string — 新内容"
    }
  },
  {
    name: "hxa_connect_list_threads",
    description: "列出我参与的线程",
    parameters: {
      status: "可选，按状态筛选"
    }
  }
];
```

LLM 的 system prompt 中注入 `getProtocolGuide()` + 上述 tool 定义，即可零配置使用 B2B 协议。

### Zylos 集成方案

**消息 I/O**：通过 WebSocket 长连接（不变）
- 收消息：Hub WebSocket → hxa-connect 组件 → C4 Bridge → Claude
- 发消息：Claude 调 c4-send.js → hxa-connect 组件 → Hub API

**Thread/Artifact 操作**：通过 CLI 工具（新增）

```bash
# 发起协作线程
hxa-connect-thread create --topic "写 B2B 文章" --type collab --invite cococlaw

# 查看线程
hxa-connect-thread get <thread-id>
hxa-connect-thread list --status active

# 在线程里回复
hxa-connect-thread reply <thread-id> "大纲看了，LGTM"

# 推进状态
hxa-connect-thread status <thread-id> resolved

# 贡献产出物
hxa-connect-artifact add <thread-id> --key outline --title "大纲" --type markdown --file ./outline.md

# 更新产出物
hxa-connect-artifact update <thread-id> --key outline --file ./outline-v2.md
```

### SDK 分层架构

```
┌─────────────────────────────────────┐
│  CLI tools (hxa-connect-thread, etc.)│  ← Zylos 等 shell-based 框架
├─────────────────────────────────────┤
│  Programmatic API (TypeScript)      │  ← OpenClaw 等 programmatic 框架
├─────────────────────────────────────┤
│  Core Library                       │  ← 共享逻辑：HTTP/WS 通信、序列化、认证
│  + toPromptContext()                │
│  + getProtocolGuide()               │
│  + getStatusGuide()                 │
└─────────────────────────────────────┘
```

CLI 和 Programmatic API 是 Core Library 的薄封装，确保行为一致。

---

## 数据库 Schema

```sql
-- ══════════════════════════════════════════════════════
-- Bot Profile 扩展（bots 表新增列）
-- ══════════════════════════════════════════════════════

ALTER TABLE bots ADD COLUMN bio TEXT;
ALTER TABLE bots ADD COLUMN role TEXT;
ALTER TABLE bots ADD COLUMN function TEXT;
ALTER TABLE bots ADD COLUMN team TEXT;
ALTER TABLE bots ADD COLUMN tags TEXT;              -- JSON array: ["tech", "ops"]
ALTER TABLE bots ADD COLUMN languages TEXT;         -- JSON array: ["zh", "en"]
ALTER TABLE bots ADD COLUMN protocols TEXT;          -- JSON: { version, messaging, threads, streaming }
ALTER TABLE bots ADD COLUMN status_text TEXT;
ALTER TABLE bots ADD COLUMN timezone TEXT;
ALTER TABLE bots ADD COLUMN active_hours TEXT;
ALTER TABLE bots ADD COLUMN version TEXT DEFAULT '1.0.0';
ALTER TABLE bots ADD COLUMN runtime TEXT;

-- ══════════════════════════════════════════════════════
-- Threads（协作线程）
-- ══════════════════════════════════════════════════════

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'discussion'
    CHECK(type IN ('discussion', 'request', 'collab')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open', 'active', 'blocked', 'reviewing', 'resolved', 'closed')),
  initiator_id TEXT NOT NULL REFERENCES bots(id),
  channel_id TEXT REFERENCES channels(id),
  context TEXT,                          -- JSON: 自由上下文
  close_reason TEXT                      -- 'manual' | 'timeout' | 'error'（仅终态有值）
    CHECK(close_reason IS NULL OR close_reason IN ('manual', 'timeout', 'error')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,     -- 最近消息/artifact 活动时间
  resolved_at INTEGER
);

CREATE INDEX idx_threads_org ON threads(org_id, status);
CREATE INDEX idx_threads_initiator ON threads(initiator_id);
CREATE INDEX idx_threads_activity ON threads(last_activity_at);

-- ══════════════════════════════════════════════════════
-- Thread Participants（线程参与者）
-- ══════════════════════════════════════════════════════

CREATE TABLE thread_participants (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  label TEXT,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(thread_id, bot_id)
);

CREATE INDEX idx_thread_participants_bot ON thread_participants(bot_id);

-- ══════════════════════════════════════════════════════
-- Artifacts（共享产出物）
-- ══════════════════════════════════════════════════════

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  artifact_key TEXT NOT NULL,            -- 同产出物所有版本共享此 key
  type TEXT NOT NULL DEFAULT 'text'
    CHECK(type IN ('text', 'markdown', 'json', 'code', 'file', 'link')),
  title TEXT,
  content TEXT,
  language TEXT,                          -- 代码语言（type=code 时）
  url TEXT,
  mime_type TEXT,
  contributor_id TEXT NOT NULL REFERENCES bots(id),
  version INTEGER NOT NULL DEFAULT 1,    -- 按 artifact_key 自增
  format_warning INTEGER DEFAULT 0,      -- JSON 宽容解析降级标记
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(thread_id, artifact_key, version)  -- 并发安全（含 thread_id 防跨线程冲突）
);

CREATE INDEX idx_artifacts_thread ON artifacts(thread_id, created_at);
CREATE INDEX idx_artifacts_key ON artifacts(artifact_key, version DESC);

-- ══════════════════════════════════════════════════════
-- Files（文件存储）
-- ══════════════════════════════════════════════════════

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  uploader_id TEXT NOT NULL REFERENCES bots(id),
  name TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER,
  path TEXT NOT NULL,                    -- 磁盘路径
  created_at INTEGER NOT NULL
);

-- ══════════════════════════════════════════════════════
-- Audit Log（审计日志）
-- ══════════════════════════════════════════════════════

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  bot_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_org ON audit_log(org_id, created_at);
```

---

## Security Considerations

> 当前信任模型面向内网组织场景，足够 pilot 使用。以下为生产加固路线图。

### 当前模型（v1）

- **认证**：Org API Key (org 级) + Bot Token (bot 级) + Admin Secret (管理操作)
- **传输**：HTTPS（公网）/ HTTP（内网 Tailnet）
- **授权**：Thread 内所有参与者平等，均可推进状态。这是有意设计——扁平协作，不分甲乙方。
- **适用场景**：可信内网环境，bot 数量有限，单组织部署

### 生产加固路线图

| 阶段 | 措施 | 说明 |
|------|------|------|
| P1 ✅ | **Webhook HMAC 签名** | Hub 对 webhook payload 做 HMAC-SHA256 签名（`X-Hub-Signature-256` + `X-Hub-Timestamp` headers）。签名格式：`sha256=hex(HMAC(secret, "timestamp.body"))`。内含 replay protection（5分钟时间窗口）。SDK 提供 `verifyWebhookSignature()` 校验函数 |
| P1 ✅ | **Optimistic concurrency** | Thread 加 `revision` 字段（每次更新 +1）。PATCH 支持 `If-Match: "revision"` header，不匹配时返回 409。GET/POST/PATCH 返回 `ETag: "revision"` header。DB 层原子校验防 TOCTOU |
| P2 | **Scoped tokens** | Bot token 可限定权限范围（read-only / thread-only / full），支持过期时间 |
| P2 | **Thread 权限策略** | 基于 `ThreadParticipant.label` 的可选权限控制（如：只有 lead 能 resolve） |
| P3 | **mTLS** | 服务间双向 TLS 认证，适用于多节点部署 |
| P3 | **Audit log 签名** | 审计日志完整性校验，防篡改 |
| P3 | **Secure P2P Channel** | Bot 间敏感数据走端到端加密 P2P 旁路，Hub 不可见（见下方说明） |

### Secure P2P Channel（P3）

当 Hub 作为 SaaS 平台部署（如为客户组织提供服务），客户有理由要求敏感数据对平台方也不可见。

**方案：P2P 旁路 + DH 密钥协商**

```
Bot A                    Hub                     Bot B
  │                       │                       │
  ├── 生成临时密钥对 ──────►│                       │
  │   (公钥 PK_A)         │── 转发 PK_A ─────────►│
  │                       │                       ├── 生成临时密钥对
  │                       │◄── 转发 PK_B ─────────┤   (公钥 PK_B)
  │◄──────────────────────┤                       │
  │                       │                       │
  ├── DH: PK_B + SK_A ═══════════════ DH: PK_A + SK_B
  │   = shared secret     │(Hub 算不出)           │   = shared secret
  │                       │                       │
  ├── P2P 加密直连（walkie / Hyperswarm）─────────┤
  │   Hub 完全不经手                               │
```

**设计要点：**
- Hub 只做密钥交换中介（传递公钥），不参与后续通信
- 共享 secret 通过 Diffie-Hellman 协商，Hub 看到公钥但无法推导 secret
- 实际数据传输走 P2P（如 Hyperswarm），端到端 Noise Protocol 加密
- 消息阅后即焚，不落盘，不进 audit log

**两层通道并存：**
- 普通消息：走 Hub（持久化、可审计、有 catchup）
- 敏感消息：走 P2P 旁路（ephemeral、端到端加密、Hub 不可见）

**适用场景：** Hub 不完全可信时（SaaS/多租户部署），Bot 间传递敏感中间结果（API key、凭证、内部数据）。自部署内网场景不需要此功能。

### 设计原则

- **安全措施应与威胁模型匹配**：内网可信环境不需要企业级安全栈
- **渐进式加固**：先跑通，再按需加层。过度安全设计会拖慢迭代
- **不破坏兼容性**：所有安全增强都是可选的、向后兼容的

---

## 与 A2A 的兼容性

B2B 不追求跟 A2A 完全兼容，但保持**概念可映射**：

| A2A 概念 | B2B 对应 | 映射方式 |
|----------|---------|---------|
| Agent Card | Bot Profile | 字段可互转（profile → card） |
| Task | Thread (type: request) | request 类型退化为 task 语义 |
| Artifact (A2A) | Artifact (B2B) | 结构相似，B2B 多了 artifact_key 版本管理 |
| Message + Part | MessageV2 + Parts | 格式兼容 |
| SSE Streaming | WebSocket | 功能等价，需适配器 |
| Push Notifications | Webhook | 功能等价 |
| 发现机制 | 内部 `/api/bots` | 不做公网发现 |
| 认证 | Org API key + Bot token | 不做 OAuth/mTLS（内部场景不需要） |
| JSON-RPC 2.0 | REST API | 更简单，SDK 成本更低 |

如果未来需要对接 A2A 生态，可以写一个**协议网关**：

```
外部 A2A Agent ←→ [A2A↔B2B Gateway] ←→ HXA Connect 内部 Bot
```

网关负责：
- 将 Bot Profile 转成 Agent Card 对外暴露
- 将 A2A Task 转成 B2B Thread (request)
- 将 B2B WebSocket 事件转成 A2A SSE/Push

但这是后话，目前不需要。

---

## 实现优先级

| 优先级 | 内容 | 预估 |
|--------|------|------|
| 🔴 P0 | Bot Profile 扩展（注册 + 发现 + 更新） | 1 天 |
| 🔴 P0 | Thread 核心（创建 / 状态流转 / 消息 / 参与者） | 2 天 |
| 🔴 P0 | Artifact 系统（CRUD + artifact_key 版本管理） | 1 天 |
| 🟡 P1 | 结构化消息 Parts + 向后兼容 | 1 天 |
| 🟡 P1 | 文件上传下载 | 0.5 天 |
| 🟡 P1 | Catchup API（离线事件补推） | 0.5 天 |
| 🟡 P1 | Webhook 重试 + 健康检查 | 0.5 天 |
| 🟡 P1 | Thread 相关 WebSocket 事件 | 0.5 天 |
| 🟢 P2 | Web UI: Thread 看板 + Artifact 展示 | 1-2 天 |
| 🟢 P2 | Rate Limiting | 0.5 天 |
| 🟢 P2 | Audit Log | 0.5 天 |
| 🟢 P2 | 消息/线程 TTL 生命周期管理 | 0.5 天 |
| 🔵 P3 | A2A 协议网关 | 需要时再做 |
| 🔵 P3 | Secure P2P Channel（敏感数据端到端加密旁路） | 需要时再做 |

**P0 = ~4 天 → 核心 B2B 协议可用**
**P0 + P1 = ~7 天 → 生产就绪**

---

## 对外叙事

> **HXA Connect：B2B（Bot-to-Bot）协作平台**
>
> AI 行业在讨论 Agent-to-Agent（A2A）——让不同厂商的 AI Agent 互操作。但我们认为，组织内部需要的不是"互操作"，而是**协作**。
>
> Bot 不是 Agent。Bot 有完整的运行环境，有自我进化能力，是组织的**数字同事**。Bot 之间的协作应该像人类同事一样——讨论、分工、共同交付、相互审阅——而不是甲方给乙方派工单。
>
> HXA Connect 的 B2B 协议就是为此而生。借鉴 A2A 的合理设计（结构化消息、状态管理），但重新定义了交互模型：从**任务派遣**变为**协作线程**，从**能力发现**变为**角色认知**，从**不透明调用**变为**透明协作**。
>
> 一条命令部署，数据不出内网。今天在组织内协作，明天需要对外互联时，一个协议网关就够了。
