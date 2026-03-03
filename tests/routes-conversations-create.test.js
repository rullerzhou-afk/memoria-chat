// routes/conversations.js — POST /conversations + PATCH /conversations/:id/messages 测试

const { createReq, createRes } = require("./helpers/mock-req-res");
const { extractHandler } = require("./helpers/extract-handler");

const config = require("../lib/config");
const validators = require("../lib/validators");

vi.spyOn(config, "atomicWrite");
vi.spyOn(config, "updateIndexEntry");
vi.spyOn(config, "getConversationPath");
vi.spyOn(config, "withConvLock");

const fsp = require("fs").promises;
vi.spyOn(fsp, "readFile");

const router = require("../routes/conversations");

beforeEach(() => {
  vi.clearAllMocks();

  config.atomicWrite.mockResolvedValue();
  config.updateIndexEntry.mockResolvedValue();
  config.getConversationPath.mockImplementation((id) =>
    /^\d{10,16}$/.test(id) ? `/fake/conversations/${id}.json` : null
  );
  config.withConvLock.mockImplementation((_id, fn) => fn());
});

// ===== POST /conversations =====

describe("POST /conversations", () => {
  const getHandler = () => extractHandler(router, "post", "/conversations");

  it("creates conversation with default title", async () => {
    const handler = getHandler();
    const req = createReq({ body: {} });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(201);
    expect(res._json.id).toMatch(/^\d{13,16}$/);
    expect(res._json.title).toBe("新对话");
    expect(config.atomicWrite).toHaveBeenCalledOnce();
    expect(config.updateIndexEntry).toHaveBeenCalledOnce();
  });

  it("creates conversation with custom title", async () => {
    const handler = getHandler();
    const req = createReq({ body: { title: "我的语音对话" } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(201);
    expect(res._json.title).toBe("我的语音对话");
  });

  it("truncates title to 100 chars", async () => {
    const handler = getHandler();
    const longTitle = "A".repeat(200);
    const req = createReq({ body: { title: longTitle } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(201);
    expect(res._json.title.length).toBe(100);
  });

  it("falls back to default title for empty string", async () => {
    const handler = getHandler();
    const req = createReq({ body: { title: "   " } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(201);
    expect(res._json.title).toBe("新对话");
  });

  it("falls back to default title for non-string", async () => {
    const handler = getHandler();
    const req = createReq({ body: { title: 42 } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(201);
    expect(res._json.title).toBe("新对话");
  });

  it("returns 500 on atomicWrite failure", async () => {
    config.atomicWrite.mockRejectedValueOnce(new Error("disk full"));
    const handler = getHandler();
    const req = createReq({ body: {} });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(500);
  });
});

// ===== PATCH /conversations/:id/messages =====

describe("PATCH /conversations/:id/messages", () => {
  const getHandler = () => extractHandler(router, "patch", "/conversations/:id/messages");

  const existingConv = {
    id: "1234567890123",
    title: "Test",
    messages: [{ role: "user", content: "hello" }],
  };

  beforeEach(() => {
    fsp.readFile.mockResolvedValue(JSON.stringify(existingConv));
  });

  it("appends messages and returns total", async () => {
    const handler = getHandler();
    const req = createReq({
      params: { id: "1234567890123" },
      body: {
        messages: [
          { role: "assistant", content: "hi there" },
        ],
      },
    });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json.ok).toBe(true);
    expect(res._json.total).toBe(2);
    expect(config.atomicWrite).toHaveBeenCalledOnce();
    expect(config.withConvLock).toHaveBeenCalledWith("1234567890123", expect.any(Function));
  });

  it("rejects invalid conversation id", async () => {
    const handler = getHandler();
    const req = createReq({
      params: { id: "bad-id!" },
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/invalid/i);
  });

  it("rejects missing messages", async () => {
    const handler = getHandler();
    const req = createReq({
      params: { id: "1234567890123" },
      body: {},
    });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it("rejects non-array messages", async () => {
    const handler = getHandler();
    const req = createReq({
      params: { id: "1234567890123" },
      body: { messages: "not an array" },
    });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it("returns 404 when conversation file not found", async () => {
    fsp.readFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const handler = getHandler();
    const req = createReq({
      params: { id: "1234567890123" },
      body: { messages: [{ role: "user", content: "hello" }] },
    });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(404);
  });

  it("returns 400 when appending exceeds 500 message limit", async () => {
    const bigConv = {
      id: "1234567890123",
      title: "Test",
      messages: Array.from({ length: 499 }, (_, i) => ({ role: "user", content: `msg ${i}` })),
    };
    fsp.readFile.mockResolvedValueOnce(JSON.stringify(bigConv));
    const handler = getHandler();
    const req = createReq({
      params: { id: "1234567890123" },
      body: {
        messages: [
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
        ],
      },
    });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/500/);
  });

  it("returns 500 on unexpected read error", async () => {
    fsp.readFile.mockRejectedValueOnce(new Error("disk error"));
    const handler = getHandler();
    const req = createReq({
      params: { id: "1234567890123" },
      body: { messages: [{ role: "user", content: "hello" }] },
    });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(500);
  });
});
