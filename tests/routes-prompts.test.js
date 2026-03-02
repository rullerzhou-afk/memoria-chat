// routes/prompts.js 路由层测试

const fs = require("fs");
const fsp = fs.promises;
const { createReq, createRes } = require("./helpers/mock-req-res");
const { extractHandler } = require("./helpers/extract-handler");

// Load dependency modules
const promptsLib = require("../lib/prompts");
const validators = require("../lib/validators");
const config = require("../lib/config");
const autoLearn = require("../lib/auto-learn");

// Spy on exports BEFORE loading route
vi.spyOn(promptsLib, "readPromptFile");
vi.spyOn(promptsLib, "readMemoryStore");
vi.spyOn(promptsLib, "writeMemoryStore");
vi.spyOn(promptsLib, "mergeTextIntoMemoryStore");
vi.spyOn(promptsLib, "renderMemoryForPrompt");
vi.spyOn(validators, "validatePromptPatch");
vi.spyOn(config, "atomicWrite");
vi.spyOn(config, "backupPrompts");
vi.spyOn(autoLearn, "withMemoryLock");

// Load route
const router = require("../routes/prompts");

const emptyStore = { version: 1, identity: [], preferences: [], events: [] };

beforeEach(() => {
  vi.clearAllMocks();
  promptsLib.readPromptFile.mockResolvedValue("");
  promptsLib.readMemoryStore.mockResolvedValue({ ...emptyStore });
  promptsLib.writeMemoryStore.mockResolvedValue({ ...emptyStore });
  promptsLib.renderMemoryForPrompt.mockReturnValue("");
  promptsLib.mergeTextIntoMemoryStore.mockReturnValue({ ...emptyStore });
  validators.validatePromptPatch.mockReturnValue({ ok: true, value: {} });
  config.atomicWrite.mockResolvedValue();
  config.backupPrompts.mockResolvedValue();
  autoLearn.withMemoryLock.mockImplementation((fn) => fn());
});

// ===== GET /prompts =====

describe("GET /prompts", () => {
  const getHandler = () => extractHandler(router, "get", "/prompts");

  it("正常返回 system + memory + memoryStore", async () => {
    promptsLib.readPromptFile.mockResolvedValue("你是一个助手");
    const store = { version: 1, identity: [{ id: "m_1", text: "test" }], preferences: [], events: [] };
    promptsLib.readMemoryStore.mockResolvedValue(store);
    promptsLib.renderMemoryForPrompt.mockReturnValue("## 核心身份\n- test");

    const res = createRes();
    await getHandler()(createReq(), res);
    expect(res._json.system).toBe("你是一个助手");
    expect(res._json.memory).toBe("## 核心身份\n- test");
    expect(res._json.memoryStore).toEqual(store);
  });

  it("readMemoryStore 抛错 → 返回空 store", async () => {
    promptsLib.readPromptFile.mockResolvedValue("sys");
    promptsLib.readMemoryStore.mockRejectedValue(new Error("read fail"));

    const res = createRes();
    await getHandler()(createReq(), res);
    expect(res._json.system).toBe("sys");
    expect(res._json.memoryStore.identity).toEqual([]);
  });
});

// ===== PUT /prompts =====

describe("PUT /prompts", () => {
  const getHandler = () => extractHandler(router, "put", "/prompts");

  it("validate 失败 → 400", async () => {
    validators.validatePromptPatch.mockReturnValue({ ok: false, error: "invalid" });
    const res = createRes();
    await getHandler()(createReq({ body: { system: 123 } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toBe("invalid");
  });

  it("只写 system → atomicWrite(SYSTEM_PATH, ...)", async () => {
    validators.validatePromptPatch.mockReturnValue({ ok: true, value: { system: "new prompt" } });
    const res = createRes();
    await getHandler()(createReq({ body: { system: "new prompt" } }), res);
    expect(res._json.ok).toBe(true);
    expect(config.atomicWrite).toHaveBeenCalledWith(
      expect.stringContaining("system.md"),
      "new prompt"
    );
  });

  it("写 memoryStore → 直接 writeMemoryStore", async () => {
    const store = { version: 1, identity: [{ id: "m_1", text: "a" }], preferences: [], events: [] };
    validators.validatePromptPatch.mockReturnValue({ ok: true, value: { memoryStore: store } });
    const res = createRes();
    await getHandler()(createReq({ body: { memoryStore: store } }), res);
    expect(res._json.ok).toBe(true);
    expect(promptsLib.writeMemoryStore).toHaveBeenCalledWith(store);
    expect(autoLearn.withMemoryLock).toHaveBeenCalled();
  });

  it("写 memory 纯文本 → mergeTextIntoMemoryStore", async () => {
    validators.validatePromptPatch.mockReturnValue({ ok: true, value: { memory: "## 核心身份\n- test" } });
    const res = createRes();
    await getHandler()(createReq({ body: { memory: "text" } }), res);
    expect(res._json.ok).toBe(true);
    expect(promptsLib.mergeTextIntoMemoryStore).toHaveBeenCalled();
    expect(promptsLib.writeMemoryStore).toHaveBeenCalled();
  });

  it("memoryStore 优先于 memory", async () => {
    const store = { version: 1, identity: [], preferences: [], events: [] };
    validators.validatePromptPatch.mockReturnValue({ ok: true, value: { memoryStore: store, memory: "text" } });
    const res = createRes();
    await getHandler()(createReq({ body: {} }), res);
    expect(promptsLib.writeMemoryStore).toHaveBeenCalledWith(store);
    expect(promptsLib.mergeTextIntoMemoryStore).not.toHaveBeenCalled();
  });

  it("都不写 → 只返回 ok", async () => {
    validators.validatePromptPatch.mockReturnValue({ ok: true, value: {} });
    const res = createRes();
    await getHandler()(createReq({ body: {} }), res);
    expect(res._json.ok).toBe(true);
    expect(config.atomicWrite).not.toHaveBeenCalled();
    expect(promptsLib.writeMemoryStore).not.toHaveBeenCalled();
  });

  it("writeMemoryStore 抛错 → 500", async () => {
    const store = { version: 1, identity: [], preferences: [], events: [] };
    validators.validatePromptPatch.mockReturnValue({ ok: true, value: { memoryStore: store } });
    promptsLib.writeMemoryStore.mockRejectedValue(new Error("write fail"));
    const res = createRes();
    await getHandler()(createReq({ body: {} }), res);
    expect(res._status).toBe(500);
  });

  it("backup 字段被剥离不参与 validate", async () => {
    validators.validatePromptPatch.mockReturnValue({ ok: true, value: {} });
    const res = createRes();
    await getHandler()(createReq({ body: { backup: true, system: "x" } }), res);
    // validatePromptPatch should NOT receive backup field
    const callArg = validators.validatePromptPatch.mock.calls[0][0];
    expect(callArg).not.toHaveProperty("backup");
  });
});

// ===== POST /prompts/backup =====

describe("POST /prompts/backup", () => {
  const getHandler = () => extractHandler(router, "post", "/prompts/backup");

  it("正常 → ok", async () => {
    const res = createRes();
    await getHandler()(createReq(), res);
    expect(res._json.ok).toBe(true);
    expect(config.backupPrompts).toHaveBeenCalled();
  });

  it("异常 → 500", async () => {
    config.backupPrompts.mockRejectedValue(new Error("fail"));
    const res = createRes();
    await getHandler()(createReq(), res);
    expect(res._status).toBe(500);
  });
});

// ===== GET /prompts/template =====

describe("GET /prompts/template", () => {
  const getHandler = () => extractHandler(router, "get", "/prompts/template");

  it("返回 SYSTEM_TEMPLATE", async () => {
    const res = createRes();
    await getHandler()(createReq(), res);
    expect(res._json).toHaveProperty("system");
    expect(res._json.system).toBe(promptsLib.SYSTEM_TEMPLATE);
  });
});

// ===== GET /prompts/versions =====

describe("GET /prompts/versions", () => {
  const getHandler = () => extractHandler(router, "get", "/prompts/versions");
  let mkdirSpy, readdirSpy, readFileSpy;

  beforeEach(() => {
    mkdirSpy = vi.spyOn(fsp, "mkdir").mockResolvedValue();
    readdirSpy = vi.spyOn(fsp, "readdir");
    readFileSpy = vi.spyOn(fsp, "readFile");
  });
  afterEach(() => { mkdirSpy.mockRestore(); readdirSpy.mockRestore(); readFileSpy.mockRestore(); });

  it("空目录 → 空列表", async () => {
    readdirSpy.mockResolvedValue([]);
    const res = createRes();
    await getHandler()(createReq(), res);
    expect(res._json).toEqual([]);
  });

  it("有版本 → 返回列表", async () => {
    readdirSpy.mockResolvedValue(["1709000000000.json"]);
    readFileSpy.mockResolvedValue(JSON.stringify({
      timestamp: "2024-02-27T00:00:00Z",
      system: "sys content",
      memory: "mem content",
    }));
    const res = createRes();
    await getHandler()(createReq(), res);
    expect(res._json).toHaveLength(1);
    expect(res._json[0].ts).toBe("1709000000000");
    expect(res._json[0].systemPreview).toBe("sys content");
  });

  it("去重：连续相同内容只保留最新", async () => {
    readdirSpy.mockResolvedValue(["1709000002.json", "1709000001.json"]);
    const same = JSON.stringify({ system: "same", memory: "same" });
    readFileSpy.mockResolvedValue(same);
    const res = createRes();
    await getHandler()(createReq(), res);
    expect(res._json).toHaveLength(1);
  });

  it("损坏文件被跳过", async () => {
    readdirSpy.mockResolvedValue(["bad.json", "good.json"]);
    readFileSpy.mockImplementation((p) => {
      if (p.includes("bad")) return Promise.reject(new Error("corrupt"));
      return Promise.resolve(JSON.stringify({ system: "ok", memory: "" }));
    });
    const res = createRes();
    await getHandler()(createReq(), res);
    expect(res._json).toHaveLength(1);
  });

  it("非 .json 文件被过滤", async () => {
    readdirSpy.mockResolvedValue(["readme.txt", "1709000000000.json"]);
    readFileSpy.mockResolvedValue(JSON.stringify({ system: "a", memory: "" }));
    const res = createRes();
    await getHandler()(createReq(), res);
    expect(res._json).toHaveLength(1);
  });
});

// ===== GET /prompts/versions/:ts =====

describe("GET /prompts/versions/:ts", () => {
  const getHandler = () => extractHandler(router, "get", "/prompts/versions/:ts");
  let readFileSpy;
  beforeEach(() => { readFileSpy = vi.spyOn(fsp, "readFile"); });
  afterEach(() => { readFileSpy.mockRestore(); });

  it("ts 非数字 → 400", async () => {
    const res = createRes();
    await getHandler()(createReq({ params: { ts: "abc" } }), res);
    expect(res._status).toBe(400);
  });

  it("不存在 → 404", async () => {
    readFileSpy.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const res = createRes();
    await getHandler()(createReq({ params: { ts: "1709000000000" } }), res);
    expect(res._status).toBe(404);
  });

  it("正常返回", async () => {
    const data = { system: "prompt", memory: "mem", timestamp: "2024-02-27T00:00:00Z" };
    readFileSpy.mockResolvedValue(JSON.stringify(data));
    const res = createRes();
    await getHandler()(createReq({ params: { ts: "1709000000000" } }), res);
    expect(res._json.system).toBe("prompt");
  });
});

// ===== DELETE /prompts/versions/:ts =====

describe("DELETE /prompts/versions/:ts", () => {
  const getHandler = () => extractHandler(router, "delete", "/prompts/versions/:ts");
  let unlinkSpy;
  beforeEach(() => { unlinkSpy = vi.spyOn(fsp, "unlink"); });
  afterEach(() => { unlinkSpy.mockRestore(); });

  it("ts 非数字 → 400", async () => {
    const res = createRes();
    await getHandler()(createReq({ params: { ts: "abc" } }), res);
    expect(res._status).toBe(400);
  });

  it("不存在 → 404", async () => {
    unlinkSpy.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const res = createRes();
    await getHandler()(createReq({ params: { ts: "1709000000000" } }), res);
    expect(res._status).toBe(404);
  });

  it("正常删除 → ok", async () => {
    unlinkSpy.mockResolvedValue();
    const res = createRes();
    await getHandler()(createReq({ params: { ts: "1709000000000" } }), res);
    expect(res._json.ok).toBe(true);
  });
});

// ===== POST /prompts/versions/:ts/restore =====

describe("POST /prompts/versions/:ts/restore", () => {
  const getHandler = () => extractHandler(router, "post", "/prompts/versions/:ts/restore");
  let readFileSpy;
  beforeEach(() => { readFileSpy = vi.spyOn(fsp, "readFile"); });
  afterEach(() => { readFileSpy.mockRestore(); });

  it("ts 非数字 → 400", async () => {
    const res = createRes();
    await getHandler()(createReq({ params: { ts: "abc" } }), res);
    expect(res._status).toBe(400);
  });

  it("不存在 → 404", async () => {
    readFileSpy.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const res = createRes();
    await getHandler()(createReq({ params: { ts: "1709000000000" } }), res);
    expect(res._status).toBe(404);
  });

  it("恢复 memoryStore 版本", async () => {
    const version = {
      system: "old sys",
      memoryStore: { version: 1, identity: [{ id: "m_1", text: "old" }], preferences: [], events: [] },
      timestamp: "2024-02-27T00:00:00Z",
    };
    readFileSpy.mockResolvedValue(JSON.stringify(version));
    const res = createRes();
    await getHandler()(createReq({ params: { ts: "1709000000000" } }), res);
    expect(res._json.ok).toBe(true);
    expect(res._json.restored).toBe("2024-02-27T00:00:00Z");
    expect(config.backupPrompts).toHaveBeenCalled(); // 恢复前先备份
    expect(config.atomicWrite).toHaveBeenCalledWith(expect.stringContaining("system.md"), "old sys");
    expect(promptsLib.writeMemoryStore).toHaveBeenCalledWith(version.memoryStore);
  });

  it("恢复纯文本 memory 版本 → migrate 路径", async () => {
    const version = { system: "sys", memory: "## old memory", timestamp: "2024-01-01T00:00:00Z" };
    readFileSpy.mockResolvedValue(JSON.stringify(version));
    const res = createRes();
    await getHandler()(createReq({ params: { ts: "1709000000000" } }), res);
    expect(res._json.ok).toBe(true);
    // memory path: atomicWrite(MEMORY_PATH, memory), then migrateMemoryMd + writeMemoryStore
    expect(config.atomicWrite).toHaveBeenCalled();
  });

  it("恢复失败 → 500", async () => {
    readFileSpy.mockResolvedValue(JSON.stringify({ system: "x", timestamp: "t" }));
    config.backupPrompts.mockRejectedValue(new Error("backup fail"));
    const res = createRes();
    await getHandler()(createReq({ params: { ts: "1709000000000" } }), res);
    expect(res._status).toBe(500);
  });
});
