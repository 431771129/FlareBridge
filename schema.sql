
---

## 📄 schema.sql

```sql
-- 用户映射表
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  username TEXT,
  topic_id INTEGER DEFAULT 0,
  blocked INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_topic_id ON users(topic_id);
CREATE INDEX IF NOT EXISTS idx_created_at ON users(created_at);

-- 屏蔽词表
CREATE TABLE IF NOT EXISTS blocked_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT UNIQUE,
  is_regex INTEGER DEFAULT 0,
  is_exact INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_is_regex ON blocked_words(is_regex);

-- 拦截统计表
CREATE TABLE IF NOT EXISTS intercept_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  word_matched TEXT,
  matched_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_matched_at ON intercept_stats(matched_at);
CREATE INDEX IF NOT EXISTS idx_word_matched ON intercept_stats(word_matched);

-- 命令使用统计表
CREATE TABLE IF NOT EXISTS command_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  command TEXT,
  args TEXT,
  executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 系统配置表（用于缓存版本号）
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);