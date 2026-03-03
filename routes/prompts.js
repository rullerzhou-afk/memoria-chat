const fsp = require("fs").promises;
const path = require("path");
const router = require("express").Router();
const { readPromptFile, SYSTEM_PATH, readMemoryStore, writeMemoryStore, mergeTextIntoMemoryStore, renderMemoryForPrompt, DEFAULT_SYSTEM, SYSTEM_TEMPLATE, SYSTEM_TEMPLATE_EN } = require("../lib/prompts");
const { validatePromptPatch } = require("../lib/validators");
const { atomicWrite, backupPrompts } = require("../lib/config");
const { withMemoryLock } = require("../lib/auto-learn");

const BACKUPS_DIR = path.join(__dirname, "..", "prompts", "backups");

router.get("/prompts", async (req, res) => {
  const [system, store] = await Promise.all([
    readPromptFile(SYSTEM_PATH),
    readMemoryStore().catch((err) => {
      console.warn("[prompts] readMemoryStore error:", err.message);
      return { version: 1, identity: [], preferences: [], events: [] };
    }),
  ]);
  const memory = renderMemoryForPrompt(store);
  res.json({ system, memory, memoryStore: store });
});

router.put("/prompts", async (req, res) => {
  const body = { ...req.body };
  delete body.backup; // backup 标志不参与 validate

  const validated = validatePromptPatch(body);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  const { system, memory, memoryStore } = validated.value;
  try {
    const writes = [];
    if (system !== undefined) writes.push(atomicWrite(SYSTEM_PATH, system));

    // memoryStore 优先于 memory（新客户端发 memoryStore，旧客户端发 memory 纯文本）
    if (memoryStore !== undefined) {
      writes.push(withMemoryLock(() => writeMemoryStore(memoryStore)));
    } else if (memory !== undefined) {
      // 纯文本写入：与当前 memoryStore 做 bigram 智能匹配，继承已有条目的元数据
      writes.push(withMemoryLock(async () => {
        const currentStore = await readMemoryStore().catch(() => ({
          version: 1, identity: [], preferences: [], events: [],
        }));
        const merged = mergeTextIntoMemoryStore(memory, currentStore);
        await writeMemoryStore(merged);
      }));
    }

    await Promise.all(writes);
    res.json({ ok: true });
  } catch (err) {
    console.error("[prompts] error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===== 手动保存版本 =====

router.post("/prompts/backup", async (req, res) => {
  try {
    await backupPrompts();
    res.json({ ok: true });
  } catch (err) {
    console.error("[prompts] backup error:", err);
    res.status(500).json({ error: "备份失败" });
  }
});

// ===== 出厂模板 =====

router.get("/prompts/template", (req, res) => {
  const lang = req.query.lang;
  res.json({ system: lang === "en" ? SYSTEM_TEMPLATE_EN : SYSTEM_TEMPLATE });
});

// ===== 人格版本管理 =====

/** 列出所有版本快照 */
router.get("/prompts/versions", async (req, res) => {
  try {
    await fsp.mkdir(BACKUPS_DIR, { recursive: true });
    const files = (await fsp.readdir(BACKUPS_DIR))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse(); // 最新的在前

    // 去重：连续相同内容（system + memory）的版本只保留最新的
    const versions = [];
    let prevKey = null;
    for (const file of files) {
      try {
        const raw = await fsp.readFile(path.join(BACKUPS_DIR, file), "utf-8");
        const data = JSON.parse(raw);
        const sys = data.system || "";
        const mem = data.memoryStore ? JSON.stringify(data.memoryStore) : (data.memory || "");
        const key = sys + "\0" + mem;
        if (key === prevKey) continue; // 跳过与上一条相同的
        prevKey = key;
        versions.push({
          ts: file.replace(".json", ""),
          timestamp: data.timestamp,
          systemPreview: sys.slice(0, 100),
          memoryPreview: (data.memory || "").slice(0, 100),
        });
      } catch (e) { console.warn("[prompts] skipping corrupted backup:", file, e.message); }
    }
    res.json(versions);
  } catch (err) {
    console.error("[prompts] versions list error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** 获取某个版本的完整内容 */
router.get("/prompts/versions/:ts", async (req, res) => {
  const ts = req.params.ts;
  if (!/^\d+$/.test(ts)) return res.status(400).json({ error: "Invalid version id." });

  const filePath = path.join(BACKUPS_DIR, `${ts}.json`);
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    res.json(JSON.parse(raw));
  } catch (err) {
    if (err.code === "ENOENT") return res.status(404).json({ error: "Version not found." });
    console.error("[prompts] version get error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** 恢复到某个版本 */
router.post("/prompts/versions/:ts/restore", async (req, res) => {
  const ts = req.params.ts;
  if (!/^\d+$/.test(ts)) return res.status(400).json({ error: "Invalid version id." });

  const filePath = path.join(BACKUPS_DIR, `${ts}.json`);
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    const version = JSON.parse(raw);

    // 先备份当前状态，再恢复旧版本
    await backupPrompts();

    const writes = [];
    if (version.system !== undefined) writes.push(atomicWrite(SYSTEM_PATH, version.system));

    // 优先恢复 memoryStore（新版备份），否则回退到纯文本 memory
    if (version.memoryStore) {
      writes.push(withMemoryLock(() => writeMemoryStore(version.memoryStore)));
    } else if (version.memory !== undefined) {
      const { MEMORY_PATH, migrateMemoryMd, writeMemoryStore: writeMStore } = require("../lib/prompts");
      writes.push(withMemoryLock(async () => {
        await atomicWrite(MEMORY_PATH, version.memory);
        const store = await migrateMemoryMd();
        await writeMStore(store);
      }));
    }
    await Promise.all(writes);

    res.json({ ok: true, restored: version.timestamp });
  } catch (err) {
    if (err.code === "ENOENT") return res.status(404).json({ error: "Version not found." });
    console.error("[prompts] version restore error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** 删除某个版本 */
router.delete("/prompts/versions/:ts", async (req, res) => {
  const ts = req.params.ts;
  if (!/^\d+$/.test(ts)) return res.status(400).json({ error: "Invalid version id." });

  const filePath = path.join(BACKUPS_DIR, `${ts}.json`);
  try {
    await fsp.unlink(filePath);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "ENOENT") return res.status(404).json({ error: "Version not found." });
    console.error("[prompts] version delete error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
