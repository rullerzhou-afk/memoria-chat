const fsp = require("fs").promises;
const { openaiClient, arkClient, openrouterClient } = require("./clients");
const { readMemoryStore, writeMemoryStore, renderMemoryForPrompt } = require("./prompts");
const configLib = require("./config");

const withMemoryLock = configLib.createMutex();

function normalizeAutoLearnModel(model) {
  const raw = (model || "").trim();
  if (!raw) return "";

  // OpenRouter-only model format can be normalized back to official OpenAI format.
  if (raw.includes("/")) {
    const [provider, shortId] = raw.split("/", 2);
    if (provider.toLowerCase() === "openai" && !openrouterClient && openaiClient && shortId) {
      return shortId;
    }
    return raw;
  }

  // If user sets an OpenAI-family model while only OpenRouter is configured, auto-prefix it.
  const isOpenAIStyle = /^(gpt|o[0-9]|chatgpt)/i.test(raw);
  if (isOpenAIStyle && !openaiClient && openrouterClient) {
    return `openai/${raw}`;
  }
  return raw;
}

function resolveAutoLearnModel() {
  const envModel = normalizeAutoLearnModel(process.env.AUTO_LEARN_MODEL);
  if (envModel) return envModel;
  if (openaiClient) return "gpt-4o-mini";
  if (openrouterClient) return "openai/gpt-4o-mini";
  if (arkClient) return "doubao-1-5-lite-32k-250115";
  return "gpt-4o-mini"; // fallback（不应到达）
}
const AUTO_LEARN_MODEL = resolveAutoLearnModel();
const AUTO_LEARN_COOLDOWN = Number.parseInt(process.env.AUTO_LEARN_COOLDOWN || "300", 10);

// 按对话 ID 独立冷却（Map<convId, lastTime>）
const cooldownMap = new Map();

function getLastAutoLearnTime(convId) {
  return cooldownMap.get(convId) || 0;
}

function setLastAutoLearnTime(convId, t) {
  cooldownMap.set(convId, t);
}

/** 原子检查并获取冷却期：按对话 ID 独立冷却，防止多对话互相阻塞 */
function tryAcquireCooldown(convId) {
  if (!convId) return false; // 无效 convId 拒绝
  const now = Date.now();
  const lastTime = cooldownMap.get(convId) || 0;
  if (now - lastTime < AUTO_LEARN_COOLDOWN * 1000) {
    return false;
  }
  cooldownMap.set(convId, now);
  return true;
}

const AUTO_LEARN_PROMPT = `你是一个用户画像分析助手。你的任务是从对话中提取关于"用户"的新信息，并检查是否与已有记忆冲突。

已有记忆中每条信息前面带有 [ID]，如 [m_1708000000000]。

规则：
1. 只提取关于用户本人的事实性信息（身份、偏好、习惯、性格、正在做的事、长期目标、重要的人际关系等）
2. 不要提取关于 AI 助手自身的信息
3. 不要记录一次性的提问或操作（如"问了今天天气""让搜索某个新闻"）
4. 判断标准：这条信息在下次聊天时还有用吗？如果只跟当前对话有关，不记
5. 如果对话中没有值得记录的新信息，也没有需要更新的旧信息，只输出 NONE
6. 每条内容不超过 80 字，保持客观

操作类型：
- ADD: 全新信息，已有记忆中不存在。格式：- ADD [category] 内容
- UPDATE: 新信息取代某条已有记忆（状态变化或信息修正）。格式：- UPDATE [旧记忆ID] [category] 新内容
- DELETE: 某条已有记忆已明确过时或不再成立。格式：- DELETE [旧记忆ID]

category 取值：identity | preferences | events
  - identity: 身份信息（姓名、年龄、职业、居住地、重要关系等）
  - preferences: 偏好习惯（沟通风格、兴趣爱好、工具偏好等）
  - events: 近期动态（正在做的事、近期计划、当前状态等）

冲突判断：
- 状态变化算冲突（"在找工作"→"入职了Google"）→ UPDATE 或 DELETE + ADD
- 信息修正算冲突（"住在北京"→"搬到上海了"）→ UPDATE
- 补充细节不算冲突（"做前端开发"和"用 React"可以共存）→ ADD
- 不确定时宁可 ADD，不要误删

示例（已有记忆含 [m_1700000000000] 正在找工作）：
当用户说"我上周入职了Google"时：
- UPDATE [m_1700000000000] [events] 上周入职了Google

或者：
- DELETE [m_1700000000000]
- ADD [identity] 在Google工作

或者：
NONE`;

const MAX_MEMORY_FACT_LENGTH = 80;
const MAX_MEMORY_TOTAL_LENGTH = 50_000;
const VALID_CATEGORIES = new Set(["identity", "preferences", "events"]);

const MAX_OPS_PER_CALL = 10;

function parseAutoLearnOutput(output) {
  if (!output || output.trim() === "NONE") return [];

  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const results = [];

  for (const line of lines) {
    // ADD: "- ADD [category] text"
    const addMatch = line.match(/^-\s*ADD\s+\[(\w+)\]\s*(.+)$/i);
    if (addMatch) {
      const category = addMatch[1].toLowerCase();
      const text = addMatch[2].trim();
      if (VALID_CATEGORIES.has(category) && text && Array.from(text).length <= MAX_MEMORY_FACT_LENGTH) {
        results.push({ op: "add", category, text });
      }
      continue;
    }

    // UPDATE: "- UPDATE [m_xxx] [category] text"
    const updateMatch = line.match(/^-\s*UPDATE\s+\[(m_\d{10,})\]\s+\[(\w+)\]\s*(.+)$/i);
    if (updateMatch) {
      const targetId = updateMatch[1].toLowerCase();
      const category = updateMatch[2].toLowerCase();
      const text = updateMatch[3].trim();
      if (VALID_CATEGORIES.has(category) && text && Array.from(text).length <= MAX_MEMORY_FACT_LENGTH) {
        results.push({ op: "update", targetId, category, text });
      }
      continue;
    }

    // DELETE: "- DELETE [m_xxx]"
    const deleteMatch = line.match(/^-\s*DELETE\s+\[(m_\d{10,})\]\s*$/i);
    if (deleteMatch) {
      results.push({ op: "delete", targetId: deleteMatch[1].toLowerCase() });
      continue;
    }

    // 向后兼容旧格式: "- [category] text" → ADD
    const legacyMatch = line.match(/^-\s*\[(\w+)\]\s*(.+)$/);
    if (legacyMatch) {
      const category = legacyMatch[1].toLowerCase();
      const text = legacyMatch[2].trim();
      if (VALID_CATEGORIES.has(category) && text && Array.from(text).length <= MAX_MEMORY_FACT_LENGTH) {
        results.push({ op: "add", category, text });
      }
    }
  }

  // 防止 LLM 被诱导批量操作
  if (results.length > MAX_OPS_PER_CALL) {
    console.warn(`Auto-learn: truncating ${results.length} operations to ${MAX_OPS_PER_CALL}`);
    return results.slice(0, MAX_OPS_PER_CALL);
  }

  return results;
}

async function applyMemoryOperations(operations) {
  if (!Array.isArray(operations) || operations.length === 0) return { overLimit: false };

  return withMemoryLock(async () => {
    const store = await readMemoryStore();
    const overLimit = JSON.stringify(store).length > MAX_MEMORY_TOTAL_LENGTH;

    // 超限时仅允许 DELETE/UPDATE（可减少体积），跳过纯 ADD
    if (overLimit) {
      const hasRemoval = operations.some((op) => op.op === "delete" || op.op === "update");
      if (!hasRemoval) {
        console.warn("Auto-learn: memory.json exceeds size limit, skipping pure adds");
        return { overLimit: true };
      }
    }

    // 收集所有需要删除的 ID（来自 DELETE 和 UPDATE 操作）
    const idsToRemove = new Set();
    for (const op of operations) {
      if ((op.op === "delete" || op.op === "update") && op.targetId) {
        idsToRemove.add(op.targetId);
      }
    }

    // 执行删除：从所有分类中移除目标 ID
    if (idsToRemove.size > 0) {
      let removedCount = 0;
      for (const category of ["identity", "preferences", "events"]) {
        const before = store[category].length;
        store[category] = store[category].filter((item) => !idsToRemove.has(item.id));
        removedCount += before - store[category].length;
      }
      if (removedCount === 0) {
        console.warn("Auto-learn: LLM referenced non-existent memory IDs:", [...idsToRemove]);
      }
    }

    // 执行添加（ADD 和 UPDATE 的新内容；超限时需检查新增内容大小）
    const today = new Date().toISOString().slice(0, 10);
    const base = Date.now();
    let seq = 0;

    for (const op of operations) {
      if (overLimit && op.op === "add") continue;
      if ((op.op === "add" || op.op === "update") && VALID_CATEGORIES.has(op.category) && op.text) {
        const newItem = {
          id: `m_${base}${String(seq++).padStart(3, "0")}`,
          text: op.text,
          date: today,
          source: "ai_inferred",
        };

        // 超限时，允许 UPDATE 让容量变小，拒绝让容量变大的操作
        if (overLimit && op.op === "update") {
          // UPDATE 允许执行(已在删除阶段移除旧条目)，直接添加新条目
          store[op.category].push(newItem);
        } else if (overLimit) {
          // ADD 操作需检查是否会进一步膨胀
          const currentSize = JSON.stringify(store).length;
          store[op.category].push(newItem);
          const newSize = JSON.stringify(store).length;
          if (newSize > currentSize) {
            // 超限且变大了，回滚这条 ADD
            store[op.category].pop();
            console.warn(`Auto-learn: ADD rejected (would exceed limit): ${op.text.slice(0, 40)}...`);
            continue;
          }
        } else {
          // 未超限，直接添加
          store[op.category].push(newItem);
        }
      }
    }

    await writeMemoryStore(store);
    return { overLimit };
  });
}

/** @deprecated Use applyMemoryOperations instead */
async function appendToLongTermMemory(newEntries) {
  if (!Array.isArray(newEntries) || newEntries.length === 0) return;
  // 兼容旧调用：将 {category, text} 转换为 {op:"add", category, text}
  const ops = newEntries.map((e) => ({ op: "add", category: e.category, text: e.text }));
  return applyMemoryOperations(ops);
}

module.exports = {
  normalizeAutoLearnModel,
  resolveAutoLearnModel,
  AUTO_LEARN_MODEL,
  AUTO_LEARN_COOLDOWN,
  getLastAutoLearnTime,
  setLastAutoLearnTime,
  AUTO_LEARN_PROMPT,
  MAX_MEMORY_FACT_LENGTH,
  MAX_MEMORY_TOTAL_LENGTH,
  MAX_OPS_PER_CALL,
  parseAutoLearnOutput,
  applyMemoryOperations,
  appendToLongTermMemory,
  tryAcquireCooldown,
  withMemoryLock,
};
