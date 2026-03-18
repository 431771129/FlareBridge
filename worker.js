// ==================== 环境变量说明 ====================
// 必填：
// - BOT_TOKEN: Telegram Bot Token
// - GROUP_ID: 目标群组 ID（必须以 -100 开头）
// 可选：
// - ADMIN_IDS: 管理员用户ID（多个用逗号分隔）
// - CACHE_TTL: 屏蔽词缓存有效期（秒），默认 300
// - DEDUP_TTL: 消息去重缓存有效期（秒），默认 5
// - DEDUP_MEMORY_CACHE_SIZE: 内存去重缓存最大条目数，默认 1000
// - LOG_LEVEL: 日志级别（DEBUG, INFO, WARN, ERROR），默认 INFO
// - LOG_SAMPLE_RATE: DEBUG 日志采样率（0-1），默认 1.0
// - MAX_REGEX_COUNT: 最大正则屏蔽词数量，默认 50
// - MAX_REGEX_LENGTH: 正则表达式最大长度，默认 200
// - SLOW_REGEX_THRESHOLD_MS: 正则慢查询阈值（毫秒），默认 50
// - KV_NAMESPACE: 用于共享自动机快照和去重的 KV 绑定名称
// =====================================================

// KV 绑定名称：BLOCKED_WORDS_KV（需在 wrangler.toml 或 Cloudflare 控制台绑定）

// ==================== 日志分级工具（动态级别 + 采样）====================
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

function getLogLevel(env) {
  const level = (env.LOG_LEVEL || 'INFO').toUpperCase();
  return LOG_LEVELS[level] !== undefined ? LOG_LEVELS[level] : LOG_LEVELS.INFO;
}

function shouldSample(env) {
  const rate = parseFloat(env.LOG_SAMPLE_RATE || '1.0');
  return Math.random() < rate;
}

function log(level, message, data = {}, env) {
  const currentLevel = getLogLevel(env);
  if (level < currentLevel) return;
  if (level === LOG_LEVELS.DEBUG && !shouldSample(env)) return;
  const timestamp = new Date().toISOString();
  const levelName = Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === level);
  console.log(JSON.stringify({
    timestamp,
    level: levelName,
    message,
    ...data,
  }));
}

// ==================== 全局缓存 ====================
let blockedWordsCache = {
  automaton: null,           // 预处理模式自动机
  exactPatterns: [],         // 精确匹配模式列表（原始字符串）
  regexPatterns: [],         // 编译后的 RegExp 数组
  version: 0,                // 对应 D1 中的版本号
  timestamp: 0
};

// 内存去重缓存（LRU）- 延迟初始化
class LRUCache {
  constructor(maxSize = 1000, ttl = 5000) {
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.cache = new Map();
  }
  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    // 刷新位置（LRU）- 先删后加
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.value;
  }
  set(key, value) {
    // 如果已存在，先删除以更新顺序
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }
}

let dedupMemoryCache = null;
function getDedupCache(env) {
  if (!dedupMemoryCache) {
    const maxSize = parseInt(env.DEDUP_MEMORY_CACHE_SIZE) || 1000;
    const ttl = (parseInt(env.DEDUP_TTL) || 5) * 1000;
    dedupMemoryCache = new LRUCache(maxSize, ttl);
  }
  return dedupMemoryCache;
}

// ==================== Aho-Corasick 自动机实现 ====================
class AhoCorasick {
  constructor(patterns) {
    this.root = { children: {}, fail: null, output: [] };
    this.buildTrie(patterns);
    this.buildFail();
  }
  buildTrie(patterns) {
    for (let i = 0; i < patterns.length; i++) {
      let node = this.root;
      for (let ch of patterns[i]) {
        if (!node.children[ch]) {
          node.children[ch] = { children: {}, fail: null, output: [] };
        }
        node = node.children[ch];
      }
      node.output.push(i);
    }
  }
  buildFail() {
    const queue = [];
    for (let ch in this.root.children) {
      this.root.children[ch].fail = this.root;
      queue.push(this.root.children[ch]);
    }
    while (queue.length) {
      const node = queue.shift();
      for (let ch in node.children) {
        let f = node.fail;
        while (f && !f.children[ch]) {
          f = f.fail;
        }
        node.children[ch].fail = f ? f.children[ch] : this.root;
        node.children[ch].output = node.children[ch].output.concat(node.children[ch].fail.output);
        queue.push(node.children[ch]);
      }
    }
  }
  search(text) {
    let node = this.root;
    for (let ch of text) {
      while (node !== this.root && !node.children[ch]) {
        node = node.fail;
      }
      if (node.children[ch]) {
        node = node.children[ch];
      } else {
        node = this.root;
      }
      if (node.output.length > 0) return true;
    }
    return false;
  }
}
// ===============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Webhook 入口
    if (request.method === 'POST' && path === '/webhook') {
      try {
        const update = await request.json();
        await handleUpdate(update, env);
        return new Response('OK');
      } catch (err) {
        log(LOG_LEVELS.ERROR, 'Webhook error', { error: err.message, stack: err.stack }, env);
        return new Response('Error', { status: 500 });
      }
    }

    // 管理员接口：清理过期话题
    if (request.method === 'GET' && path === '/cleanup') {
      const adminId = url.searchParams.get('admin_id');
      if (!adminId || !(await isAdmin(parseInt(adminId), env))) {
        return new Response('Unauthorized', { status: 403 });
      }
      const count = await cleanupOldTopics(env);
      log(LOG_LEVELS.INFO, 'Cleanup executed', { adminId, count }, env);
      return new Response(`Cleaned up ${count} old topics.`);
    }

    // 管理员接口：查看正则性能统计
    if (request.method === 'GET' && path === '/stats') {
      const adminId = url.searchParams.get('admin_id');
      if (!adminId || !(await isAdmin(parseInt(adminId), env))) {
        return new Response('Unauthorized', { status: 403 });
      }
      const stats = await getRegexStats(env);
      return new Response(JSON.stringify(stats, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Telegram Bot is running.', { status: 200 });
  },
};

// ------------------- 工具函数 -------------------
async function isAdmin(userId, env) {
  const adminIds = (env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim()));
  return adminIds.includes(userId);
}

// 文本预处理：保留字母、数字、Emoji
function normalizeText(text) {
  if (!text) return '';
  const keepRegex = /[\p{L}\p{N}\p{Emoji}]/gu;
  const matches = text.match(keepRegex);
  return matches ? matches.join('').toLowerCase() : '';
}

// 生成去重键
function getDedupKey(userId, text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return `dedup:${userId}:${hash}`;
}

// 检查去重（内存缓存 + KV）
async function checkDedup(key, env) {
  const cache = getDedupCache(env);
  // 先查内存缓存
  if (cache.get(key)) {
    return false; // 重复
  }
  // 再查 KV
  if (env.BLOCKED_WORDS_KV) {
    const existing = await env.BLOCKED_WORDS_KV.get(key);
    if (existing) {
      // 同步到内存缓存
      cache.set(key, true);
      return false;
    }
    const ttl = parseInt(env.DEDUP_TTL) || 5;
    await env.BLOCKED_WORDS_KV.put(key, '1', { expirationTtl: ttl });
  }
  cache.set(key, true);
  return true;
}

// ------------------- 主更新处理 -------------------
async function handleUpdate(update, env) {
  if (update.message) {
    await handleMessage(update.message, env);
  }
}

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = msg.text || msg.caption || '';

  if (chatId === userId) {
    await handlePrivateMessage(msg, env);
  } else if (chatId.toString() === env.GROUP_ID.toString()) {
    await handleGroupMessage(msg, env);
  }
}

// ------------------- 私聊处理 -------------------
async function handlePrivateMessage(msg, env) {
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name || 'User';
  const text = msg.text || msg.caption || '';

  log(LOG_LEVELS.INFO, 'Private message received', {
    userId,
    username,
    textPreview: text.substring(0, 50)
  }, env);

  // 插入用户，若已存在则忽略；确保 created_at 字段有默认值（表需有该字段）
  await env.DB.prepare(
    'INSERT OR IGNORE INTO users (user_id, username, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
  ).bind(userId, username).run();

  const blocked = await isUserBlocked(userId, env);
  if (blocked) {
    log(LOG_LEVELS.INFO, 'Blocked user message ignored', { userId }, env);
    await sendMessage(userId, '您已被禁止使用此机器人。', env);
    return;
  }

  // 屏蔽词检查（增强版）
  const matchResult = await containsBlockedWordCached(text, env);
  if (matchResult.matched) {
    log(LOG_LEVELS.INFO, 'Message intercepted', { userId, word: matchResult.word, matchType: matchResult.type }, env);
    await logIntercept(userId, matchResult.word, env);
    await sendMessage(userId, '您的消息包含被屏蔽的关键词。', env);
    return;
  }

  // 消息去重
  const dedupKey = getDedupKey(userId, text);
  const isUnique = await checkDedup(dedupKey, env);
  if (!isUnique) {
    log(LOG_LEVELS.DEBUG, 'Duplicate message ignored', { userId }, env);
    return;
  }

  // 获取或创建话题（带验证）
  let topicId = await getTopicIdByUser(userId, env);
  if (topicId === 0) {
    log(LOG_LEVELS.INFO, 'Creating new topic', { userId }, env);
    const newTopicId = await createTopicInGroup(userId, username, env);
    if (!newTopicId) {
      log(LOG_LEVELS.ERROR, 'Failed to create topic', { userId }, env);
      await sendMessage(userId, '系统错误，无法创建对话。', env);
      return;
    }
    // newTopicId 直接就是 message_thread_id
    const updateResult = await env.DB.prepare(
      'UPDATE users SET topic_id = ? WHERE user_id = ? AND topic_id = 0'
    ).bind(newTopicId, userId).run();
    if (updateResult.meta.changes === 0) {
      topicId = await getTopicIdByUser(userId, env);
      log(LOG_LEVELS.INFO, 'Topic already created by another request', { userId, topicId }, env);
    } else {
      topicId = newTopicId;
      log(LOG_LEVELS.INFO, 'Topic created', { userId, topicId }, env);
    }
  } else {
    log(LOG_LEVELS.DEBUG, 'Found existing topic', { userId, topicId }, env);
  }

  // 复制消息到群组话题
  log(LOG_LEVELS.DEBUG, 'Copying message to group', { userId, messageId: msg.message_id, topicId }, env);
  const copyResult = await copyMessageToGroup(msg.chat.id, msg.message_id, topicId, env);
  if (copyResult && copyResult.ok) {
    log(LOG_LEVELS.DEBUG, 'Message copied successfully', {}, env);
  } else {
    log(LOG_LEVELS.ERROR, 'Message copy failed', { userId, error: copyResult?.description }, env);
    // 可选：通知用户发送失败
    await sendMessage(userId, '消息转发失败，请稍后重试。', env);
  }
}

// ------------------- 群组话题处理 -------------------
async function handleGroupMessage(msg, env) {
  if (!msg.message_thread_id) {
    log(LOG_LEVELS.DEBUG, 'Non-thread group message ignored', {}, env);
    return;
  }

  const topicId = msg.message_thread_id;
  const text = msg.text || msg.caption || '';
  log(LOG_LEVELS.INFO, 'Group message in topic', { topicId, textPreview: text.substring(0, 50) }, env);

  if (text.startsWith('/')) {
    log(LOG_LEVELS.INFO, 'Admin command received', { command: text }, env);
    await handleAdminCommand(msg, env);
    return;
  }

  const user = await getUserByTopic(topicId, env);
  if (!user) {
    log(LOG_LEVELS.WARN, 'No user mapping for topic', { topicId }, env);
    return;
  }
  log(LOG_LEVELS.DEBUG, 'Found user for topic', { topicId, userId: user.user_id }, env);

  if (user.blocked) {
    log(LOG_LEVELS.INFO, 'User blocked, ignoring group reply', { userId: user.user_id }, env);
    return;
  }

  log(LOG_LEVELS.DEBUG, 'Copying message to user', { userId: user.user_id, messageId: msg.message_id }, env);
  const copyResult = await copyMessageToUser(msg.chat.id, msg.message_id, user.user_id, env);
  if (copyResult && copyResult.ok) {
    log(LOG_LEVELS.DEBUG, 'Message copied to user', {}, env);
  } else {
    log(LOG_LEVELS.ERROR, 'Copy to user failed', { userId: user.user_id, error: copyResult?.description }, env);
  }
}

// ------------------- 管理员命令处理（增强版） -------------------
async function handleAdminCommand(msg, env) {
  const text = msg.text;
  const userId = msg.from.id;
  const topicId = msg.message_thread_id;

  if (!(await isAdmin(userId, env))) {
    log(LOG_LEVELS.WARN, 'Unauthorized command attempt', { userId, command: text }, env);
    await sendMessageToTopic(topicId, '⛔ 您不是管理员。', env);
    return;
  }

  const parts = text.split(' ');
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  await logCommand(userId, cmd, args, env);

  const missingArg = (cmdName, example) => 
    `❌ 参数错误。用法：${cmdName} ${example}`;

  if (cmd === '/block') {
    if (!parts[1]) {
      await sendMessageToTopic(topicId, missingArg('/block', '<用户ID>'), env);
      return;
    }
    const targetId = parseInt(parts[1]);
    if (isNaN(targetId)) {
      await sendMessageToTopic(topicId, '❌ 用户ID必须是数字。', env);
      return;
    }
    await blockUser(targetId, env);
    await sendMessageToTopic(topicId, `✅ 用户 ${targetId} 已被拉黑。`, env);
  }
  else if (cmd === '/unblock') {
    if (!parts[1]) {
      await sendMessageToTopic(topicId, missingArg('/unblock', '<用户ID>'), env);
      return;
    }
    const targetId = parseInt(parts[1]);
    if (isNaN(targetId)) {
      await sendMessageToTopic(topicId, '❌ 用户ID必须是数字。', env);
      return;
    }
    await unblockUser(targetId, env);
    await sendMessageToTopic(topicId, `✅ 用户 ${targetId} 已解除拉黑。`, env);
  }
  else if (cmd === '/addblock') {
    if (!args) {
      await sendMessageToTopic(topicId, missingArg('/addblock', '<关键词>'), env);
      return;
    }
    await addBlockedWord(args, 0, 0, env); // 预处理模式
    await invalidateCacheAndStore(env);
    await sendMessageToTopic(topicId, `✅ 字面量屏蔽词（预处理） "${args}" 已添加。`, env);
  }
  else if (cmd === '/addblock_exact') {
    if (!args) {
      await sendMessageToTopic(topicId, missingArg('/addblock_exact', '<关键词>'), env);
      return;
    }
    await addBlockedWord(args, 0, 1, env); // 精确匹配模式
    await invalidateCacheAndStore(env);
    await sendMessageToTopic(topicId, `✅ 字面量屏蔽词（精确匹配） "${args}" 已添加。`, env);
  }
  else if (cmd === '/addblock_regex') {
    if (!args) {
      await sendMessageToTopic(topicId, missingArg('/addblock_regex', '<正则>'), env);
      return;
    }
    const maxLen = parseInt(env.MAX_REGEX_LENGTH) || 200;
    if (args.length > maxLen) {
      await sendMessageToTopic(topicId, `❌ 正则表达式过长（超过${maxLen}字符）。`, env);
      return;
    }
    const maxCount = parseInt(env.MAX_REGEX_COUNT) || 50;
    const regexCount = await getRegexCount(env);
    if (regexCount >= maxCount) {
      await sendMessageToTopic(topicId, `❌ 正则屏蔽词数量已达上限 ${maxCount} 条。`, env);
      return;
    }
    try {
      new RegExp(args, 'i');
    } catch (e) {
      await sendMessageToTopic(topicId, `❌ 无效的正则表达式：${e.message}`, env);
      return;
    }
    await addBlockedWord(args, 1, 0, env); // 正则模式，is_exact 忽略
    await invalidateCacheAndStore(env);
    await sendMessageToTopic(topicId, `✅ 正则屏蔽词 "${args}" 已添加。`, env);
  }
  else if (cmd === '/removeblock') {
    if (!args) {
      await sendMessageToTopic(topicId, missingArg('/removeblock', '<关键词>'), env);
      return;
    }
    await removeBlockedWord(args, env);
    await invalidateCacheAndStore(env);
    await sendMessageToTopic(topicId, `✅ 屏蔽词 "${args}" 已删除。`, env);
  }
  else if (cmd === '/listblock') {
    let page = 1;
    if (parts[1] && !isNaN(parseInt(parts[1]))) {
      page = parseInt(parts[1]);
    }
    const pageSize = 10;
    const offset = (page - 1) * pageSize;
    const { results } = await env.DB.prepare(
      'SELECT word, is_regex, is_exact FROM blocked_words ORDER BY word LIMIT ? OFFSET ?'
    ).bind(pageSize, offset).all();
    const total = (await env.DB.prepare('SELECT COUNT(*) as cnt FROM blocked_words').first()).cnt;
    const totalPages = Math.ceil(total / pageSize);

    if (page < 1 || page > totalPages) {
      await sendMessageToTopic(topicId, `📭 页码超出范围（共 ${totalPages} 页）。`, env);
    } else if (results.length === 0) {
      await sendMessageToTopic(topicId, `📭 第 ${page} 页没有屏蔽词。`, env);
    } else {
      let msg = `📋 屏蔽词列表（第 ${page}/${totalPages} 页）：\n`;
      for (let w of results) {
        let type = '字面量(预处理)';
        if (w.is_regex) type = '正则';
        else if (w.is_exact) type = '字面量(精确)';
        msg += `- ${w.word} (${type})\n`;
      }
      await sendMessageToTopic(topicId, msg, env);
    }
  }
  else {
    await sendMessageToTopic(topicId, `📌 可用命令：
/block <用户ID> - 拉黑用户
/unblock <用户ID> - 解除拉黑
/addblock <关键词> - 添加字面量屏蔽词（预处理）
/addblock_exact <关键词> - 添加字面量屏蔽词（精确匹配）
/addblock_regex <正则> - 添加正则屏蔽词
/removeblock <关键词> - 删除屏蔽词
/listblock [页码] - 分页列出屏蔽词`, env);
  }
}

// ------------------- 屏蔽词缓存机制（增强版） -------------------
async function loadBlockedWordsCache(env) {
  const ttl = parseInt(env.CACHE_TTL) || 300;
  const now = Date.now() / 1000;

  if (blockedWordsCache.timestamp > 0 && (now - blockedWordsCache.timestamp) < ttl) {
    return;
  }

  // 从 D1 获取当前版本号
  const versionRow = await env.DB.prepare('SELECT value FROM system_config WHERE key = ?').bind('blocked_words_version').first();
  const currentVersion = versionRow ? parseInt(versionRow.value) : 0;

  // 如果内存缓存版本与数据库版本一致且未过期，则使用
  if (blockedWordsCache.version === currentVersion && blockedWordsCache.timestamp > 0 && (now - blockedWordsCache.timestamp) < ttl) {
    return;
  }

  // 尝试从 KV 获取快照（带版本）
  let patterns = null;
  let kvVersion = 0;
  if (env.BLOCKED_WORDS_KV) {
    try {
      const snapshot = await env.BLOCKED_WORDS_KV.get('blocked_words_snapshot', 'json');
      if (snapshot && snapshot.version === currentVersion && snapshot.timestamp > (now - ttl)) {
        // 从快照重建 patterns，注意正则需重新编译
        patterns = {
          literalPreprocess: snapshot.patterns.literalPreprocess,
          literalExact: snapshot.patterns.literalExact,
          regex: snapshot.patterns.regex.map(src => new RegExp(src, 'i'))
        };
        kvVersion = snapshot.version;
      }
    } catch (e) {
      log(LOG_LEVELS.ERROR, 'KV read error', { error: e.message }, env);
    }
  }

  if (!patterns) {
    log(LOG_LEVELS.INFO, 'Loading blocked words from database', {}, env);
    const { results } = await env.DB.prepare(
      'SELECT word, is_regex, is_exact FROM blocked_words'
    ).all();
    const literalPreprocess = [];
    const literalExact = [];
    const regexPatterns = [];
    for (let row of results) {
      if (row.is_regex === 1) {
        try {
          regexPatterns.push(new RegExp(row.word, 'i'));
        } catch (e) {
          log(LOG_LEVELS.ERROR, 'Invalid regex ignored', { word: row.word, error: e.message }, env);
        }
      } else {
        if (row.is_exact === 1) {
          literalExact.push(row.word.toLowerCase()); // 精确匹配转小写
        } else {
          const normalized = normalizeText(row.word);
          if (normalized) literalPreprocess.push(normalized);
        }
      }
    }
    patterns = {
      literalPreprocess,
      literalExact,
      regex: regexPatterns
    };

    // 存储到 KV（如果可用），正则存储为源字符串数组
    if (env.BLOCKED_WORDS_KV) {
      try {
        const patternsToStore = {
          literalPreprocess,
          literalExact,
          regex: regexPatterns.map(r => r.source)
        };
        await env.BLOCKED_WORDS_KV.put('blocked_words_snapshot', JSON.stringify({
          patterns: patternsToStore,
          version: currentVersion,
          timestamp: now
        }), { expirationTtl: ttl * 2 });
      } catch (e) {
        log(LOG_LEVELS.ERROR, 'KV write error', { error: e.message }, env);
      }
    }
  } else {
    log(LOG_LEVELS.INFO, 'Loaded blocked words from KV snapshot', { version: kvVersion }, env);
  }

  const automaton = patterns.literalPreprocess.length > 0 ? new AhoCorasick(patterns.literalPreprocess) : null;
  blockedWordsCache = {
    automaton,
    exactPatterns: patterns.literalExact,
    regexPatterns: patterns.regex,
    version: currentVersion,
    timestamp: now
  };
  log(LOG_LEVELS.INFO, 'Cache loaded', {
    literalPreprocessCount: patterns.literalPreprocess.length,
    literalExactCount: patterns.literalExact.length,
    regexCount: patterns.regex.length,
    version: currentVersion
  }, env);
}

async function invalidateCacheAndStore(env) {
  // 更新数据库版本号
  const newVersion = Date.now();
  await env.DB.prepare(
    'INSERT INTO system_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP'
  ).bind('blocked_words_version', newVersion.toString(), newVersion.toString()).run();

  blockedWordsCache.timestamp = 0; // 内存缓存失效
  if (env.BLOCKED_WORDS_KV) {
    await env.BLOCKED_WORDS_KV.delete('blocked_words_snapshot').catch(() => {});
  }
  log(LOG_LEVELS.INFO, 'Cache invalidated', { newVersion }, env);
}

// 修改点：预处理匹配返回固定占位符，便于统计
async function containsBlockedWordCached(text, env) {
  if (!text) return { matched: false };
  await loadBlockedWordsCache(env);

  const lowerText = text.toLowerCase();

  // 1. 预处理匹配（自动机）
  if (blockedWordsCache.automaton) {
    const normalized = normalizeText(text);
    if (blockedWordsCache.automaton.search(normalized)) {
      return { matched: true, word: '(预处理匹配)', type: 'preprocess' };
    }
  }

  // 2. 精确匹配（原始包含）
  for (let exact of blockedWordsCache.exactPatterns) {
    if (lowerText.includes(exact)) {
      return { matched: true, word: exact, type: 'exact' };
    }
  }

  // 3. 正则匹配（带性能监控）
  const slowThreshold = parseInt(env.SLOW_REGEX_THRESHOLD_MS) || 50;
  for (let regex of blockedWordsCache.regexPatterns) {
    const start = Date.now();
    const match = regex.test(text);
    const duration = Date.now() - start;
    if (duration > slowThreshold) {
      log(LOG_LEVELS.WARN, 'Slow regex detected', { regex: regex.source, duration }, env);
    }
    if (match) {
      return { matched: true, word: regex.source, type: 'regex' };
    }
  }

  return { matched: false };
}

// ------------------- 统计与监控 -------------------
async function logIntercept(userId, word, env) {
  try {
    await env.DB.prepare(
      'INSERT INTO intercept_stats (user_id, word_matched) VALUES (?, ?)'
    ).bind(userId, word || '').run();
  } catch (e) {
    log(LOG_LEVELS.ERROR, 'Failed to log intercept', { error: e.message }, env);
  }
}

async function logCommand(adminId, command, args, env) {
  try {
    await env.DB.prepare(
      'INSERT INTO command_log (admin_id, command, args) VALUES (?, ?, ?)'
    ).bind(adminId, command, args).run();
  } catch (e) {
    log(LOG_LEVELS.ERROR, 'Failed to log command', { error: e.message }, env);
  }
}

async function getRegexStats(env) {
  // 统计每个正则的匹配次数
  const { results } = await env.DB.prepare(`
    SELECT word, COUNT(*) as count 
    FROM intercept_stats 
    WHERE word_matched IN (SELECT word FROM blocked_words WHERE is_regex=1)
    GROUP BY word_matched
  `).all();
  return results;
}

// ------------------- 清理过期话题 -------------------
async function cleanupOldTopics(env) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { results } = await env.DB.prepare(
    'SELECT user_id FROM users WHERE topic_id != 0 AND created_at < ?'
  ).bind(cutoff).all();
  let count = 0;
  for (let user of results) {
    await env.DB.prepare(
      'UPDATE users SET topic_id = 0 WHERE user_id = ?'
    ).bind(user.user_id).run();
    count++;
  }
  return count;
}

// ------------------- 数据库操作（用户相关） -------------------
async function getTopicIdByUser(userId, env) {
  const { results } = await env.DB.prepare(
    'SELECT topic_id FROM users WHERE user_id = ?'
  ).bind(userId).all();
  return results.length ? results[0].topic_id : 0;
}

async function getUserByTopic(topicId, env) {
  const { results } = await env.DB.prepare(
    'SELECT user_id, blocked FROM users WHERE topic_id = ?'
  ).bind(topicId).all();
  return results.length ? results[0] : null;
}

async function isUserBlocked(userId, env) {
  const { results } = await env.DB.prepare(
    'SELECT blocked FROM users WHERE user_id = ?'
  ).bind(userId).all();
  return results.length ? results[0].blocked === 1 : false;
}

async function blockUser(userId, env) {
  await env.DB.prepare('UPDATE users SET blocked = 1 WHERE user_id = ?').bind(userId).run();
}

async function unblockUser(userId, env) {
  await env.DB.prepare('UPDATE users SET blocked = 0 WHERE user_id = ?').bind(userId).run();
}

async function addBlockedWord(word, isRegex, isExact, env) {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO blocked_words (word, is_regex, is_exact) VALUES (?, ?, ?)'
  ).bind(word, isRegex, isExact).run();
}

async function removeBlockedWord(word, env) {
  await env.DB.prepare('DELETE FROM blocked_words WHERE word = ?').bind(word).run();
}

async function getRegexCount(env) {
  const result = await env.DB.prepare('SELECT COUNT(*) as cnt FROM blocked_words WHERE is_regex = 1').first();
  return result.cnt;
}

// ------------------- Telegram API 调用（带重试，支持 5xx） -------------------
async function callTelegram(method, payload, env, retries = 3) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await resp.json();
      if (!result.ok) {
        const errorCode = result.error_code;
        log(LOG_LEVELS.WARN, 'Telegram API error', { method, description: result.description, errorCode }, env);
        // 重试条件：429 或 5xx 错误
        const shouldRetry = errorCode === 429 || (errorCode >= 500 && errorCode < 600);
        if (shouldRetry && i < retries - 1) {
          let wait = 5;
          if (errorCode === 429 && result.parameters?.retry_after) {
            wait = result.parameters.retry_after;
          } else {
            wait = Math.pow(2, i); // 指数退避
          }
          log(LOG_LEVELS.INFO, 'Retrying after error', { wait, attempt: i+1 }, env);
          await new Promise(resolve => setTimeout(resolve, wait * 1000));
          continue;
        }
      }
      return result;
    } catch (err) {
      log(LOG_LEVELS.ERROR, 'Fetch error', { method, error: err.message }, env);
      if (i === retries - 1) throw err;
      const wait = Math.pow(2, i);
      await new Promise(resolve => setTimeout(resolve, wait * 1000));
    }
  }
}

async function sendMessage(chatId, text, env) {
  return callTelegram('sendMessage', { chat_id: chatId, text }, env);
}

async function sendMessageToTopic(topicId, text, env) {
  return callTelegram('sendMessage', {
    chat_id: env.GROUP_ID,
    message_thread_id: topicId,
    text,
  }, env);
}

async function copyMessageToGroup(fromChatId, messageId, topicId, env) {
  return callTelegram('copyMessage', {
    chat_id: env.GROUP_ID,
    from_chat_id: fromChatId,
    message_id: messageId,
    message_thread_id: topicId,
  }, env);
}

async function copyMessageToUser(fromChatId, messageId, userId, env) {
  return callTelegram('copyMessage', {
    chat_id: userId,
    from_chat_id: fromChatId,
    message_id: messageId,
  }, env);
}

// 修正点：使用 createForumTopic 正确创建话题
async function createTopicInGroup(userId, username, env) {
  const payload = {
    chat_id: env.GROUP_ID,
    name: `用户 ${username} (${userId})`, // 话题名称
  };
  const resp = await callTelegram('createForumTopic', payload, env);
  if (resp.ok && resp.result) {
    return resp.result.message_thread_id;
  }
  // 记录详细错误（若 resp 包含描述）
  if (resp && !resp.ok) {
    log(LOG_LEVELS.ERROR, 'Create forum topic failed', { 
      userId, 
      description: resp.description,
      errorCode: resp.error_code 
    }, env);
  }
  return null;
}