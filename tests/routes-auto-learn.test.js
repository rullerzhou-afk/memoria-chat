// routes/auto-learn.js 路由层测试
// 策略: vi.spyOn 替代 vi.mock（vitest 4 不拦截 CJS require）

const { createReq, createRes } = require("./helpers/mock-req-res");
const { extractHandler } = require("./helpers/extract-handler");

// 1. Load real dependency modules
const clients = require("../lib/clients");
const autoLearn = require("../lib/auto-learn");
const prompts = require("../lib/prompts");
const config = require("../lib/config");

// 2. Spy on exports BEFORE loading route (route 加载时 destructure 拿到的是 spy)
vi.spyOn(clients, "getClientForModel");
vi.spyOn(clients, "formatProviderError");
vi.spyOn(autoLearn, "tryAcquireCooldown");
vi.spyOn(autoLearn, "parseAutoLearnOutput");
vi.spyOn(autoLearn, "applyMemoryOperations");
vi.spyOn(autoLearn, "performDecayCheck");
vi.spyOn(autoLearn, "performPromotionCheck");
vi.spyOn(autoLearn, "performReflection");
vi.spyOn(autoLearn, "withMemoryLock");
vi.spyOn(prompts, "readMemoryStore");
vi.spyOn(prompts, "renderMemoryWithIds");
vi.spyOn(prompts, "writeMemoryStore");
vi.spyOn(config, "readConfig");

// 3. NOW load route — destructuring captures spied functions
const router = require("../routes/auto-learn");

// 4. Default mock implementations
beforeEach(() => {
  vi.clearAllMocks();

  clients.getClientForModel.mockReturnValue({
    chat: { completions: { create: vi.fn().mockResolvedValue({
      choices: [{ message: { content: "NONE" } }],
    }) } },
  });
  clients.formatProviderError.mockImplementation((err) => err.message || "error");

  autoLearn.tryAcquireCooldown.mockReturnValue(true);
  autoLearn.parseAutoLearnOutput.mockReturnValue([]);
  autoLearn.applyMemoryOperations.mockResolvedValue({ appliedOps: [], overLimit: false });
  autoLearn.performDecayCheck.mockResolvedValue({ decayed: [], staled: [] });
  autoLearn.performPromotionCheck.mockResolvedValue({ promoted: [], demoted: [] });
  autoLearn.performReflection.mockResolvedValue({ insights: [], skipped: null });
  autoLearn.withMemoryLock.mockImplementation((fn) => fn());

  prompts.readMemoryStore.mockResolvedValue({ version: 1, identity: [], preferences: [], events: [] });
  prompts.renderMemoryWithIds.mockReturnValue("");
  prompts.writeMemoryStore.mockResolvedValue();

  config.readConfig.mockResolvedValue({ memory: { autoDecay: false, autoPromotion: false } });
});

// ===== POST /memory/auto-learn =====

describe("POST /memory/auto-learn", () => {
  const getHandler = () => extractHandler(router, "post", "/memory/auto-learn");

  const validBody = (overrides = {}) => ({
    convId: "1234567890123",
    messages: [
      { role: "user", content: "这是一段足够长的对话内容用来通过长度检查" },
      { role: "assistant", content: "好的我来回复你这段够长的对话内容" },
    ],
    ...overrides,
  });

  // === 验证 ===

  it("convId 缺失 → 400", async () => {
    const handler = getHandler();
    const req = createReq({ body: { messages: [{ role: "user", content: "hi" }] } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/convId/i);
  });

  it("convId 非法（字母）→ 400", async () => {
    const handler = getHandler();
    const req = createReq({ body: { convId: "abc", messages: [{ role: "user", content: "hi" }] } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it("messages 缺失 → 400", async () => {
    const handler = getHandler();
    const req = createReq({ body: { convId: "1234567890123" } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/messages/i);
  });

  it("messages 空数组 → 400", async () => {
    const handler = getHandler();
    const req = createReq({ body: { convId: "1234567890123", messages: [] } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it("messages 非数组 → 400", async () => {
    const handler = getHandler();
    const req = createReq({ body: { convId: "1234567890123", messages: "not array" } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it("messages 元素非对象 → 400", async () => {
    const handler = getHandler();
    const req = createReq({ body: { convId: "1234567890123", messages: ["string"] } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/messages\[0\]/);
  });

  it("role 非法 → 400", async () => {
    const handler = getHandler();
    const req = createReq({ body: { convId: "1234567890123", messages: [{ role: "tool", content: "hi" }] } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/role/);
  });

  it("content 非 string 且非 array → 400", async () => {
    const handler = getHandler();
    const req = createReq({ body: { convId: "1234567890123", messages: [{ role: "user", content: 123 }] } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/content/);
  });

  it("content 字符串超 20000 → 400", async () => {
    const handler = getHandler();
    const req = createReq({ body: { convId: "1234567890123", messages: [{ role: "user", content: "x".repeat(20001) }] } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/20000/);
  });

  it("content 数组中 text 部分超 20000 → 400", async () => {
    const handler = getHandler();
    const req = createReq({
      body: {
        convId: "1234567890123",
        messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(20001) }] }],
      },
    });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it("content 数组中元素非对象 → 400", async () => {
    const handler = getHandler();
    const req = createReq({
      body: {
        convId: "1234567890123",
        messages: [{ role: "user", content: ["bad string"] }],
      },
    });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/content\[0\]/);
  });

  // === 过滤 ===

  it("文本总长 <20 → skipped: too_short", async () => {
    const handler = getHandler();
    const req = createReq({ body: { convId: "1234567890123", messages: [{ role: "user", content: "hi" }] } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json.skipped).toBe("too_short");
    expect(res._json.learned).toEqual([]);
  });

  it("冷却期 → skipped: cooldown", async () => {
    autoLearn.tryAcquireCooldown.mockReturnValue(false);
    const handler = getHandler();
    const req = createReq({ body: validBody() });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json.skipped).toBe("cooldown");
  });

  // === LLM 分支 ===

  it("LLM 返回 NONE → learned:[]", async () => {
    const handler = getHandler();
    const req = createReq({ body: validBody() });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json.learned).toEqual([]);
  });

  it("LLM 返回空 → learned:[]", async () => {
    clients.getClientForModel.mockReturnValue({
      chat: { completions: { create: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "" } }],
      }) } },
    });
    const handler = getHandler();
    const req = createReq({ body: validBody() });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json.learned).toEqual([]);
  });

  it("LLM 返回有效内容 → applyMemoryOperations 被调用", async () => {
    clients.getClientForModel.mockReturnValue({
      chat: { completions: { create: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "- ADD [identity] 喜欢吃辣" } }],
      }) } },
    });
    autoLearn.parseAutoLearnOutput.mockReturnValue([{ op: "add", category: "identity", text: "喜欢吃辣" }]);
    autoLearn.applyMemoryOperations.mockResolvedValue({
      appliedOps: [{ op: "add", id: "m_1000000000000_001", text: "喜欢吃辣" }],
      overLimit: false,
    });

    const handler = getHandler();
    const req = createReq({ body: validBody() });
    const res = createRes();
    await handler(req, res);
    expect(autoLearn.applyMemoryOperations).toHaveBeenCalled();
    expect(res._json.learned).toHaveLength(1);
  });

  it("overLimit → capacityWarning: true", async () => {
    clients.getClientForModel.mockReturnValue({
      chat: { completions: { create: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "- ADD [identity] test" } }],
      }) } },
    });
    autoLearn.parseAutoLearnOutput.mockReturnValue([{ op: "add", category: "identity", text: "test" }]);
    autoLearn.applyMemoryOperations.mockResolvedValue({
      appliedOps: [{ op: "add", id: "m_1", text: "test" }],
      overLimit: true,
    });

    const handler = getHandler();
    const req = createReq({ body: validBody() });
    const res = createRes();
    await handler(req, res);
    expect(res._json.capacityWarning).toBe(true);
  });

  it("decay 有结果 → 透传到 response", async () => {
    autoLearn.performDecayCheck.mockResolvedValue({ decayed: [{ id: "m_1" }], staled: [{ id: "m_2" }] });
    const handler = getHandler();
    const req = createReq({ body: validBody() });
    const res = createRes();
    await handler(req, res);
    expect(res._json.decay).toBeDefined();
    expect(res._json.decay.decayed).toHaveLength(1);
    expect(res._json.decay.staled).toHaveLength(1);
  });

  it("promotion 有结果 → 透传到 response", async () => {
    autoLearn.performPromotionCheck.mockResolvedValue({ promoted: [{ id: "m_1" }], demoted: [] });
    const handler = getHandler();
    const req = createReq({ body: validBody() });
    const res = createRes();
    await handler(req, res);
    expect(res._json.promotion).toBeDefined();
    expect(res._json.promotion.promoted).toHaveLength(1);
  });

  it("decay 和 promotion 都无结果 → 不在 response 中出现", async () => {
    const handler = getHandler();
    const req = createReq({ body: validBody() });
    const res = createRes();
    await handler(req, res);
    expect(res._json.decay).toBeUndefined();
    expect(res._json.promotion).toBeUndefined();
  });

  it("LLM 返回 NONE 但有 decay 结果 → 同时返回 learned:[] 和 decay", async () => {
    autoLearn.performDecayCheck.mockResolvedValue({ decayed: [{ id: "m_1" }], staled: [] });
    const handler = getHandler();
    const req = createReq({ body: validBody() });
    const res = createRes();
    await handler(req, res);
    expect(res._json.learned).toEqual([]);
    expect(res._json.decay).toBeDefined();
  });

  it("parseAutoLearnOutput 返回空 → 不调 applyMemoryOperations", async () => {
    clients.getClientForModel.mockReturnValue({
      chat: { completions: { create: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "some invalid" } }],
      }) } },
    });
    autoLearn.parseAutoLearnOutput.mockReturnValue([]);
    const handler = getHandler();
    const req = createReq({ body: validBody() });
    const res = createRes();
    await handler(req, res);
    expect(res._json.learned).toEqual([]);
    expect(autoLearn.applyMemoryOperations).not.toHaveBeenCalled();
  });

  it("LLM 抛错 → 500", async () => {
    clients.getClientForModel.mockReturnValue({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("API error")) } },
    });
    const handler = getHandler();
    const req = createReq({ body: validBody() });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(500);
    expect(res._json.error).toMatch(/Internal/i);
  });

  it("合法 role 包含 user/assistant/system", async () => {
    const handler = getHandler();
    const req = createReq({
      body: {
        convId: "1234567890123",
        messages: [
          { role: "user", content: "这是一段足够长的对话内容用来通过检查" },
          { role: "assistant", content: "好的我明白了这段足够长" },
          { role: "system", content: "系统消息也是合法的" },
        ],
      },
    });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(200);
  });

  it("content 为数组且包含 image_url 部分 → 不计入长度", async () => {
    const handler = getHandler();
    const req = createReq({
      body: {
        convId: "1234567890123",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "这段话足够长了对吧一二三四五六七八九十" },
            { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
          ],
        }, {
          role: "assistant",
          content: "这是一段足够长的回复内容应该够了",
        }],
      },
    });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(200);
  });
});

// ===== POST /memory/auto-learn/undo =====

describe("POST /memory/auto-learn/undo", () => {
  const getHandler = () => extractHandler(router, "post", "/memory/auto-learn/undo");

  it("ids 缺失 → 400", async () => {
    const handler = getHandler();
    const req = createReq({ body: {} });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it("ids 空数组 → 400", async () => {
    const handler = getHandler();
    const req = createReq({ body: { ids: [] } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it("ids 非数组 → 400", async () => {
    const handler = getHandler();
    const req = createReq({ body: { ids: "m_1234567890" } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it("ids 超 20 个 → 400", async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `m_100000000${String(i).padStart(4, "0")}`);
    const handler = getHandler();
    const req = createReq({ body: { ids } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it("ids 含非法格式 → 400", async () => {
    const handler = getHandler();
    const req = createReq({ body: { ids: ["invalid-id"] } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/invalid memory id/);
  });

  it("ids 含非字符串 → 400", async () => {
    const handler = getHandler();
    const req = createReq({ body: { ids: [123] } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it("正常删除 → 返回 removed 计数", async () => {
    prompts.readMemoryStore.mockResolvedValue({
      version: 1,
      identity: [{ id: "m_1234567890", text: "t" }],
      preferences: [],
      events: [{ id: "m_1234567891", text: "t2" }],
    });
    const handler = getHandler();
    const req = createReq({ body: { ids: ["m_1234567890", "m_1234567891"] } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json.removed).toBe(2);
    expect(autoLearn.withMemoryLock).toHaveBeenCalled();
  });

  it("跨三层 category 删除", async () => {
    prompts.readMemoryStore.mockResolvedValue({
      version: 1,
      identity: [{ id: "m_1000000000001", text: "a" }],
      preferences: [{ id: "m_1000000000002", text: "b" }],
      events: [{ id: "m_1000000000003", text: "c" }],
    });
    const handler = getHandler();
    const req = createReq({ body: { ids: ["m_1000000000001", "m_1000000000002", "m_1000000000003"] } });
    const res = createRes();
    await handler(req, res);
    expect(res._json.removed).toBe(3);
    expect(prompts.writeMemoryStore).toHaveBeenCalled();
  });

  it("removed=0 时不调 writeMemoryStore", async () => {
    prompts.readMemoryStore.mockResolvedValue({ version: 1, identity: [], preferences: [], events: [] });
    const handler = getHandler();
    const req = createReq({ body: { ids: ["m_9999999999"] } });
    const res = createRes();
    await handler(req, res);
    expect(res._json.removed).toBe(0);
    expect(prompts.writeMemoryStore).not.toHaveBeenCalled();
  });

  it("withMemoryLock 抛错 → 500", async () => {
    autoLearn.withMemoryLock.mockRejectedValue(new Error("lock error"));
    const handler = getHandler();
    const req = createReq({ body: { ids: ["m_1234567890"] } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(500);
  });

  it("ids 刚好 20 个 → 正常处理", async () => {
    prompts.readMemoryStore.mockResolvedValue({ version: 1, identity: [], preferences: [], events: [] });
    const ids = Array.from({ length: 20 }, (_, i) => `m_100000000${String(i).padStart(4, "0")}`);
    const handler = getHandler();
    const req = createReq({ body: { ids } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(200);
  });
});

// ===== POST /memory/reflect =====

describe("POST /memory/reflect", () => {
  const getHandler = () => extractHandler(router, "post", "/memory/reflect");

  it("透传 insights 结果", async () => {
    autoLearn.performReflection.mockResolvedValue({ insights: ["a", "b"], skipped: null });
    const handler = getHandler();
    const res = createRes();
    await handler(createReq(), res);
    expect(res._status).toBe(200);
    expect(res._json.insights).toEqual(["a", "b"]);
  });

  it("透传 skipped 结果", async () => {
    autoLearn.performReflection.mockResolvedValue({ insights: [], skipped: "no_events" });
    const handler = getHandler();
    const res = createRes();
    await handler(createReq(), res);
    expect(res._json.skipped).toBe("no_events");
  });

  it("空 insights 正常返回", async () => {
    autoLearn.performReflection.mockResolvedValue({ insights: [], skipped: null });
    const handler = getHandler();
    const res = createRes();
    await handler(createReq(), res);
    expect(res._json.insights).toEqual([]);
  });

  it("performReflection 抛错 → 500", async () => {
    autoLearn.performReflection.mockRejectedValue(new Error("fail"));
    const handler = getHandler();
    const res = createRes();
    await handler(createReq(), res);
    expect(res._status).toBe(500);
    expect(res._json.error).toMatch(/反思失败/);
  });

  it("返回结构原样透传", async () => {
    const result = { insights: [{ text: "foo", applied: true }], skipped: null, merged: 1 };
    autoLearn.performReflection.mockResolvedValue(result);
    const handler = getHandler();
    const res = createRes();
    await handler(createReq(), res);
    expect(res._json).toEqual(result);
  });
});
