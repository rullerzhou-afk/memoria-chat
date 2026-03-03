// routes/voice.js — POST /voice/stt + POST /voice/tts 测试

const { createReq, createRes } = require("./helpers/mock-req-res");
const { extractHandler } = require("./helpers/extract-handler");

const clients = require("../lib/clients");

vi.spyOn(clients, "formatProviderError");

const router = require("../routes/voice");

let savedClient;

beforeEach(() => {
  vi.clearAllMocks();
  clients.formatProviderError.mockImplementation((err) => err.message || "error");
  // 保存原始值
  savedClient = clients.openaiClient;
});

afterEach(() => {
  // 恢复原始值
  clients.openaiClient = savedClient;
});

// ===== POST /voice/stt =====

describe("POST /voice/stt", () => {
  const getHandler = () => extractHandler(router, "post", "/voice/stt");

  it("returns 503 when openaiClient is null", async () => {
    clients.openaiClient = null;
    const handler = getHandler();
    const req = createReq({
      file: { buffer: Buffer.from("fake"), originalname: "test.wav", mimetype: "audio/wav" },
    });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(503);
    expect(res._json.error).toMatch(/OPENAI_API_KEY/);
  });

  it("returns 400 when no audio file uploaded", async () => {
    const handler = getHandler();
    const req = createReq({}); // no file
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/audio/i);
  });

  it("returns transcription text on success", async () => {
    clients.openaiClient = {
      audio: {
        transcriptions: {
          create: vi.fn().mockResolvedValue({ text: "你好世界" }),
        },
      },
    };
    const handler = getHandler();
    const req = createReq({
      file: { buffer: Buffer.from("fake-audio"), originalname: "test.webm", mimetype: "audio/webm" },
      body: { language: "zh" },
    });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json.text).toBe("你好世界");
  });

  it("returns 502 on API error", async () => {
    clients.openaiClient = {
      audio: {
        transcriptions: {
          create: vi.fn().mockRejectedValue(new Error("API down")),
        },
      },
    };
    const handler = getHandler();
    const req = createReq({
      file: { buffer: Buffer.from("fake-audio"), originalname: "test.webm", mimetype: "audio/webm" },
    });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(502);
  });

  it("returns 504 on timeout (AbortError)", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    clients.openaiClient = {
      audio: {
        transcriptions: {
          create: vi.fn().mockRejectedValue(abortErr),
        },
      },
    };
    const handler = getHandler();
    const req = createReq({
      file: { buffer: Buffer.from("fake-audio"), originalname: "test.webm", mimetype: "audio/webm" },
    });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(504);
  });
});

// ===== POST /voice/tts =====

describe("POST /voice/tts", () => {
  const getHandler = () => extractHandler(router, "post", "/voice/tts");

  it("returns 503 when openaiClient is null", async () => {
    clients.openaiClient = null;
    const handler = getHandler();
    const req = createReq({ body: { text: "hello" } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(503);
    expect(res._json.error).toMatch(/OPENAI_API_KEY/);
  });

  it("returns 400 when text is empty", async () => {
    const handler = getHandler();
    const req = createReq({ body: { text: "" } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/text/i);
  });

  it("returns 400 when text exceeds 4096 chars", async () => {
    const handler = getHandler();
    const req = createReq({ body: { text: "A".repeat(4097) } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it("returns 400 when text is not a string", async () => {
    const handler = getHandler();
    const req = createReq({ body: { text: 42 } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it("returns audio stream on success (pipe path)", async () => {
    const mockStream = { pipe: vi.fn(), on: vi.fn() };
    clients.openaiClient = {
      audio: {
        speech: {
          create: vi.fn().mockResolvedValue({ body: mockStream }),
        },
      },
    };
    const handler = getHandler();
    const req = createReq({ body: { text: "你好", voice: "nova", speed: 1.2 } });
    const res = createRes();
    res.set = vi.fn().mockReturnValue(res);
    res.on = vi.fn().mockReturnValue(res);
    await handler(req, res);
    expect(res.set).toHaveBeenCalledWith("Content-Type", "audio/mpeg");
    expect(mockStream.pipe).toHaveBeenCalledWith(res);
    expect(mockStream.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("returns audio buffer on success (arrayBuffer fallback)", async () => {
    const audioBytes = Buffer.from("fake-mp3-data");
    clients.openaiClient = {
      audio: {
        speech: {
          create: vi.fn().mockResolvedValue({
            body: {}, // no pipe method
            arrayBuffer: vi.fn().mockResolvedValue(audioBytes.buffer),
          }),
        },
      },
    };
    const handler = getHandler();
    const req = createReq({ body: { text: "你好" } });
    const res = createRes();
    res.set = vi.fn().mockReturnValue(res);
    res.send = vi.fn().mockReturnValue(res);
    await handler(req, res);
    expect(res.send).toHaveBeenCalled();
  });

  it("returns 502 on API error", async () => {
    clients.openaiClient = {
      audio: {
        speech: {
          create: vi.fn().mockRejectedValue(new Error("TTS failed")),
        },
      },
    };
    const handler = getHandler();
    const req = createReq({ body: { text: "hello" } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(502);
  });

  it("returns 504 on timeout", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    clients.openaiClient = {
      audio: {
        speech: {
          create: vi.fn().mockRejectedValue(abortErr),
        },
      },
    };
    const handler = getHandler();
    const req = createReq({ body: { text: "hello" } });
    const res = createRes();
    await handler(req, res);
    expect(res._status).toBe(504);
  });

  it("clamps speed to valid range", async () => {
    const mockCreate = vi.fn().mockResolvedValue({ body: { pipe: vi.fn(), on: vi.fn() } });
    clients.openaiClient = { audio: { speech: { create: mockCreate } } };
    const handler = getHandler();
    const req = createReq({ body: { text: "test", speed: 100 } });
    const res = createRes();
    res.set = vi.fn().mockReturnValue(res);
    res.on = vi.fn().mockReturnValue(res);
    await handler(req, res);
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.speed).toBe(4.0);
  });
});
