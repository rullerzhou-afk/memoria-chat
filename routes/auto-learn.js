const router = require("express").Router();
const { getClientForModel, formatProviderError } = require("../lib/clients");
const { readMemoryStore, renderMemoryWithIds } = require("../lib/prompts");
const { isPlainObject } = require("../lib/config");
const {
  AUTO_LEARN_MODEL,
  AUTO_LEARN_PROMPT,
  tryAcquireCooldown,
  parseAutoLearnOutput,
  applyMemoryOperations,
} = require("../lib/auto-learn");

router.post("/memory/auto-learn", async (req, res) => {
  const convId = req.body?.convId; // 按对话 ID 独立冷却
  if (!tryAcquireCooldown(convId)) {
    return res.json({ learned: [], skipped: "cooldown" });
  }

  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages required" });
  }

  const learnAllowedRoles = new Set(["user", "assistant", "system"]);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isPlainObject(msg)) {
      return res.status(400).json({ error: `messages[${i}] must be an object` });
    }
    if (typeof msg.role !== "string" || !learnAllowedRoles.has(msg.role)) {
      return res.status(400).json({ error: `messages[${i}].role must be one of: user, assistant, system` });
    }
    if (!(typeof msg.content === "string" || Array.isArray(msg.content))) {
      return res.status(400).json({ error: `messages[${i}].content must be a string or array` });
    }
    let contentLength = 0;
    if (typeof msg.content === "string") {
      contentLength = msg.content.length;
    } else {
      for (let j = 0; j < msg.content.length; j++) {
        const part = msg.content[j];
        if (!isPlainObject(part)) {
          return res.status(400).json({ error: `messages[${i}].content[${j}] must be an object` });
        }
        if (part.type === "text" && typeof part.text === "string") {
          contentLength += part.text.length;
        }
      }
    }
    if (contentLength > 20_000) {
      return res.status(400).json({ error: `messages[${i}] content too large (max 20000 chars)` });
    }
  }

  const recentMessages = messages.slice(-4);
  const totalLength = recentMessages.reduce((sum, m) => {
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((p) => p.type === "text").map((p) => p.text).join("")
          : "";
    return sum + text.length;
  }, 0);

  if (totalLength < 20) {
    return res.json({ learned: [], skipped: "too_short" });
  }

  try {
    const store = await readMemoryStore();
    const currentMemory = renderMemoryWithIds(store);
    const conversationText = recentMessages
      .map((m) => {
        const role = m.role === "user" ? "用户" : m.role === "assistant" ? "AI" : "系统";
        const text =
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n")
              : "";
        return `${role}: ${text}`;
      })
      .join("\n\n");

    const learnClient = getClientForModel(AUTO_LEARN_MODEL);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 60_000);
    let response;
    try {
      response = await learnClient.chat.completions.create({
        model: AUTO_LEARN_MODEL,
        temperature: 0.3,
        messages: [
          { role: "system", content: AUTO_LEARN_PROMPT },
          { role: "user", content: `已有记忆：\n${currentMemory || "（空）"}\n\n---\n\n最近的对话：\n${conversationText}` },
        ],
      }, { signal: abort.signal });
    } finally {
      clearTimeout(timer);
    }

    const output = (response.choices[0]?.message?.content || "").trim();
    if (output === "NONE" || !output) {
      return res.json({ learned: [] });
    }

    const entries = parseAutoLearnOutput(output);

    if (entries.length === 0) {
      return res.json({ learned: [] });
    }

    const result = await applyMemoryOperations(entries);

    const adds = entries.filter((e) => e.op === "add");
    const updates = entries.filter((e) => e.op === "update");
    const deletes = entries.filter((e) => e.op === "delete");
    console.log(`Auto-learn: +${adds.length} add, ~${updates.length} update, -${deletes.length} delete`);

    const payload = {
      learned: entries.map((e) => {
        if (e.op === "delete") return `- DELETE [${e.targetId}]`;
        if (e.op === "update") return `- UPDATE [${e.targetId}] → [${e.category}] ${e.text}`;
        return `- [${e.category}] ${e.text}`;
      }),
    };
    if (result?.overLimit) payload.capacityWarning = true;
    return res.json(payload);
  } catch (err) {
    console.error("Auto-learn error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
