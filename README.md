# FlareBridge — Telegram 双向机器人（Cloudflare D1 + Workers）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Telegram Bot](https://img.shields.io/badge/Telegram-Bot-blue)](https://core.telegram.org/bots)

FlareBridge 是一个基于 Cloudflare D1 和 Workers 的高性能 Telegram 双向机器人。它将用户私聊消息转发到指定群组的独立话题中，管理员在话题中回复即可与用户实时通信。内置了强大的屏蔽词系统、多实例缓存、消息去重等功能，适合客服、社群管理等场景。

![架构示意图](https://via.placeholder.com/800x400?text=FlareBridge+Architecture) <!-- 可替换为实际架构图 -->

## ✨ 功能亮点

- **双向实时转发**：用户 ↔ 机器人 ↔ 群组话题，无缝沟通。
- **用户隔离**：每个用户在群组中拥有独立话题，互不干扰。
- **高性能屏蔽词系统**：
  - 字面量预处理（忽略标点空格，保留字母/数字/Emoji）基于 Aho-Corasick 自动机。
  - 字面量精确匹配（原始包含）。
  - 正则匹配（长度/数量限制，慢查询监控）。
- **多实例缓存一致性**：内存缓存 + KV 快照 + 版本号控制，支持水平扩展。
- **消息去重**：内存 LRU 缓存 + KV 全局去重，防止刷屏。
- **管理员命令**：拉黑/解封、增删屏蔽词、分页列表、清理旧话题。
- **日志分级与采样**：支持 DEBUG/INFO/WARN/ERROR，DEBUG 日志可采样，避免日志爆炸。
- **监控统计**：拦截记录、命令日志、正则性能统计接口 `/stats`。
- **API 重试**：自动重试 429 和 5xx 错误，指数退避，提高稳定性。

## 🚀 快速开始

### 前置要求
- [Cloudflare 账号](https://dash.cloudflare.com/)
- [Node.js](https://nodejs.org/) 16+ 和 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- Telegram Bot Token（通过 [@BotFather](https://t.me/BotFather) 创建）
- Telegram 群组（需开启话题功能），并记录群组 ID（可通过 [@getidsbot](https://t.me/getidsbot) 获取）

### 1. 克隆仓库
```bash
git clone https://github.com/yourname/flarebridge.git
cd flarebridge
## 🚀 快速开始

### 前置要求
- [Cloudflare 账号](https://dash.cloudflare.com/)
- [Node.js](https://nodejs.org/) 16+ 和 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- Telegram Bot Token（通过 [@BotFather](https://t.me/BotFather) 创建）
- Telegram 群组（需开启话题功能），并记录群组 ID（可通过 [@getidsbot](https://t.me/getidsbot) 获取）

### 1. 克隆仓库
```bash
git clone https://github.com/yourname/flarebridge.git
cd flarebridge
```

2. 安装依赖并配置

```bash
npm install -g wrangler  # 如果尚未安装
wrangler login
```

3. 创建 D1 数据库

```bash
wrangler d1 create flarebridge-db
```

记录输出的数据库名称和 ID，然后执行初始化 SQL：

```bash
wrangler d1 execute flarebridge-db --file=schema.sql
```

4. 创建 KV Namespace

```bash
wrangler kv:namespace create "BLOCKED_WORDS_KV"
```

记录输出的 KV ID。

5. 配置 wrangler.toml

```toml
name = "flarebridge"
main = "worker.js"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "flarebridge-db"
database_id = "你的数据库ID"

[[kv_namespaces]]
binding = "BLOCKED_WORDS_KV"
id = "你的KV ID"
```

6. 设置环境变量

```bash
wrangler secret put BOT_TOKEN
wrangler secret put GROUP_ID
wrangler secret put ADMIN_IDS  # 可选，多个用逗号分隔
```

7. 部署

```bash
wrangler deploy
```

部署成功后，会输出一个 Workers 域名，例如 https://flarebridge.workers.dev。

8. 设置 Webhook

在浏览器中访问以下 URL：

```
https://api.telegram.org/bot<你的BOT_TOKEN>/setWebhook?url=https://你的worker域名/webhook
```

返回 {"ok":true} 即成功。

🤖 管理员命令

在群组话题中发送以下命令（需要机器人是管理员，且命令发送者是 ADMIN_IDS 中指定的管理员）：

命令 说明
/block <用户ID> 拉黑用户（用户ID可通过话题创建时的消息获取）
/unblock <用户ID> 解除拉黑
/addblock <关键词> 添加字面量屏蔽词（预处理，忽略标点空格）
/addblock_exact <关键词> 添加字面量屏蔽词（精确匹配，保留原始字符）
/addblock_regex <正则> 添加正则屏蔽词（需符合 JavaScript 正则语法）
/removeblock <关键词> 删除屏蔽词（精确匹配原词）
/listblock [页码] 分页列出所有屏蔽词（每页10条）

示例：

```
/addblock 广告
/addblock_exact C++
/addblock_regex \b\d{5,}\b
/listblock 2
```

📊 监控接口

FlareBridge 提供了两个简单的 HTTP 接口，可用于定时任务或手动查看状态。

清理过期话题

```
GET /cleanup?admin_id=<管理员ID>
```

作用：将 30 天未活跃用户的 topic_id 重置为 0（不会删除话题，只是解除映射）。建议设置 Cron 定时调用（例如每周一次）。

查看正则统计

```
GET /stats?admin_id=<管理员ID>
```

返回 JSON 格式的正则屏蔽词匹配次数统计，可用于识别高频触发的正则。

⚙️ 环境变量详解

变量名 必填 默认值 说明
BOT_TOKEN ✅ - Telegram Bot Token
GROUP_ID ✅ - 目标群组 ID（必须以 -100 开头）
ADMIN_IDS ❌ - 管理员用户 ID，多个用逗号分隔，如 "12345,67890"
CACHE_TTL ❌ 300 屏蔽词缓存有效期（秒），过期后重新从数据库加载
DEDUP_TTL ❌ 5 消息去重缓存有效期（秒）
DEDUP_MEMORY_CACHE_SIZE ❌ 1000 内存去重缓存最大条目数
LOG_LEVEL ❌ INFO 日志级别：DEBUG, INFO, WARN, ERROR
LOG_SAMPLE_RATE ❌ 1.0 DEBUG 日志采样率（0-1），例如 0.1 表示只记录 10% 的 DEBUG 日志
MAX_REGEX_COUNT ❌ 50 最大允许添加的正则屏蔽词数量
MAX_REGEX_LENGTH ❌ 200 正则表达式的最大字符长度
SLOW_REGEX_THRESHOLD_MS ❌ 50 正则匹配超过该毫秒数时记录警告

📁 数据库表结构

项目使用 Cloudflare D1，包含以下表：

· users：存储用户与话题的映射、黑名单状态。
· blocked_words：存储屏蔽词，支持字面量/正则、预处理/精确。
· intercept_stats：拦截记录，用于统计和审计。
· command_log：管理员命令使用记录。
· system_config：缓存版本号等系统配置。

详细 SQL 见仓库中的 schema.sql。

🧪 测试与调试

· 查看实时日志：
  ```bash
  wrangler tail
  ```
· 手动触发 Webhook（测试用）：
  ```bash
  curl -X POST https://你的worker域名/webhook -H "Content-Type: application/json" -d '{"message":{...}}'
  ```

🛠️ 常见问题

Q: 为什么群组话题中看不到用户消息？

A: 检查机器人是否在群组中拥有“管理话题”和“发送消息”权限，并且群组已开启话题功能。

Q: 如何获取用户的 topic_id？

A: 用户第一次发消息时会自动创建话题，并在数据库中记录。管理员可以在话题中看到用户 ID 和用户名。

Q: 正则屏蔽词添加失败？

A: 确保正则语法正确且不超过长度限制（默认 200 字符），且总数不超过 MAX_REGEX_COUNT。

Q: 如何重置所有话题映射？

A: 可以执行 SQL：UPDATE users SET topic_id = 0;（谨慎操作）。

🤝 贡献指南

欢迎提交 Issue 和 Pull Request！请确保代码风格一致，并通过测试。