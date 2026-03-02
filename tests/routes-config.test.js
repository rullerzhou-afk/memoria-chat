// routes/config.js 路由层测试

const { createReq, createRes } = require("./helpers/mock-req-res");
const { extractHandler } = require("./helpers/extract-handler");

// Load dependency modules
const config = require("../lib/config");
const validators = require("../lib/validators");
const promptsLib = require("../lib/prompts");
const autoLearn = require("../lib/auto-learn");

// Spy on exports BEFORE loading route
vi.spyOn(config, "readConfig");
vi.spyOn(config, "saveConfig");
vi.spyOn(config, "backupPrompts");
vi.spyOn(config, "atomicWrite");
vi.spyOn(validators, "validateConfigPatch");
vi.spyOn(promptsLib, "writeMemoryStore");
vi.spyOn(promptsLib, "renderMemoryForPrompt");
vi.spyOn(autoLearn, "withMemoryLock");

// Load route
const router = require("../routes/config");

beforeEach(() => {
  vi.clearAllMocks();
  config.readConfig.mockResolvedValue({ model: "gpt-4o", temperature: 0.85 });
  config.saveConfig.mockImplementation(async (c) => c);
  config.backupPrompts.mockResolvedValue();
  config.atomicWrite.mockResolvedValue();
  validators.validateConfigPatch.mockReturnValue({ ok: true, value: {} });
  promptsLib.writeMemoryStore.mockResolvedValue();
  promptsLib.renderMemoryForPrompt.mockReturnValue("");
  autoLearn.withMemoryLock.mockImplementation((fn) => fn());
});

// ===== GET /config =====

describe("GET /config", () => {
  const getHandler = () => extractHandler(router, "get", "/config");

  it("正常返回", async () => {
    config.readConfig.mockResolvedValue({ model: "gpt-4o", temperature: 1 });
    const res = createRes();
    await getHandler()(createReq(), res);
    expect(res._json.model).toBe("gpt-4o");
    expect(res._json.temperature).toBe(1);
  });
});

// ===== PUT /config =====

describe("PUT /config", () => {
  const getHandler = () => extractHandler(router, "put", "/config");

  it("validate 失败 → 400", async () => {
    validators.validateConfigPatch.mockReturnValue({ ok: false, error: "bad field" });
    const res = createRes();
    await getHandler()(createReq({ body: { bad: true } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toBe("bad field");
  });

  it("平铺字段正常合并", async () => {
    config.readConfig.mockResolvedValue({ model: "gpt-4o", temperature: 0.85 });
    validators.validateConfigPatch.mockReturnValue({ ok: true, value: { temperature: 0.5 } });
    const res = createRes();
    await getHandler()(createReq({ body: { temperature: 0.5 } }), res);
    expect(res._json.ok).toBe(true);
    // saveConfig should receive merged config
    const saved = config.saveConfig.mock.calls[0][0];
    expect(saved.model).toBe("gpt-4o"); // 保留原值
    expect(saved.temperature).toBe(0.5); // 新值覆盖
  });

  it("memory 子字段嵌套合并", async () => {
    config.readConfig.mockResolvedValue({ model: "gpt-4o", memory: { autoDecay: true, cooldown: 180 } });
    validators.validateConfigPatch.mockReturnValue({ ok: true, value: { memory: { autoDecay: false } } });
    const res = createRes();
    await getHandler()(createReq({ body: { memory: { autoDecay: false } } }), res);
    const saved = config.saveConfig.mock.calls[0][0];
    expect(saved.memory.autoDecay).toBe(false); // 新值
    expect(saved.memory.cooldown).toBe(180); // 保留原值
  });

  it("saveConfig 抛错 → 500", async () => {
    validators.validateConfigPatch.mockReturnValue({ ok: true, value: { temperature: 1 } });
    config.saveConfig.mockRejectedValue(new Error("write fail"));
    const res = createRes();
    await getHandler()(createReq({ body: {} }), res);
    expect(res._status).toBe(500);
  });
});

// ===== POST /settings/reset =====

describe("POST /settings/reset", () => {
  const getHandler = () => extractHandler(router, "post", "/settings/reset");

  it("正常重置", async () => {
    config.readConfig.mockResolvedValue({ model: "gpt-4o", temperature: 1, custom: "x" });
    const res = createRes();
    await getHandler()(createReq(), res);
    expect(res._json.ok).toBe(true);
    // 先备份
    expect(config.backupPrompts).toHaveBeenCalled();
    // system 写空
    expect(config.atomicWrite).toHaveBeenCalledWith(expect.stringContaining("system.md"), "");
    // writeMemoryStore 写空 store
    expect(promptsLib.writeMemoryStore).toHaveBeenCalled();
    // saveConfig 保留 model + RECOMMENDED_CONFIG
    const saved = config.saveConfig.mock.calls[0][0];
    expect(saved.model).toBe("gpt-4o"); // 保留原模型
    expect(saved.temperature).toBe(0.85); // RECOMMENDED_CONFIG 值
    expect(saved.frequency_penalty).toBe(0.15);
    expect(saved).not.toHaveProperty("custom"); // 非 RECOMMENDED_CONFIG 字段被清除
  });

  it("返回重置后的 system/memory/memoryStore/config", async () => {
    config.readConfig.mockResolvedValue({ model: "gpt-4o" });
    promptsLib.renderMemoryForPrompt.mockReturnValue("empty");
    const res = createRes();
    await getHandler()(createReq(), res);
    expect(res._json.system).toBe("");
    expect(res._json.memory).toBe("empty");
    expect(res._json.memoryStore).toHaveProperty("version", 1);
    expect(res._json).toHaveProperty("config");
  });

  it("backupPrompts 抛错 → 500", async () => {
    config.backupPrompts.mockRejectedValue(new Error("fail"));
    const res = createRes();
    await getHandler()(createReq(), res);
    expect(res._status).toBe(500);
  });

  it("withMemoryLock 包裹 writeMemoryStore", async () => {
    config.readConfig.mockResolvedValue({ model: "gpt-4o" });
    const res = createRes();
    await getHandler()(createReq(), res);
    expect(autoLearn.withMemoryLock).toHaveBeenCalled();
  });
});
