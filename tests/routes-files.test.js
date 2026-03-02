// routes/files.js 纯函数 checkDocMagicBytes 测试

const { checkDocMagicBytes } = require("../routes/files");

describe("checkDocMagicBytes", () => {
  // === PDF ===

  it("PDF %PDF- → true", () => {
    const buf = Buffer.from("%PDF-1.7 ...");
    expect(checkDocMagicBytes(buf, ".pdf")).toBe(true);
  });

  it("PDF 签名不匹配 → false", () => {
    const buf = Buffer.from("NOT A PDF");
    expect(checkDocMagicBytes(buf, ".pdf")).toBe(false);
  });

  it("PDF buf 太短 → false", () => {
    const buf = Buffer.from("%PD");
    expect(checkDocMagicBytes(buf, ".pdf")).toBe(false);
  });

  // === DOCX ===

  it("DOCX PK\\x03\\x04 → true", () => {
    const buf = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0, 0, 0, 0]);
    expect(checkDocMagicBytes(buf, ".docx")).toBe(true);
  });

  it("DOCX 签名不匹配 → false", () => {
    const buf = Buffer.from([0x50, 0x4B, 0x05, 0x06, 0, 0, 0, 0]);
    expect(checkDocMagicBytes(buf, ".docx")).toBe(false);
  });

  it("DOCX buf 太短 → false", () => {
    const buf = Buffer.from([0x50, 0x4B]);
    expect(checkDocMagicBytes(buf, ".docx")).toBe(false);
  });

  // === 纯文本类型（无 magic bytes 检查）===

  it(".txt → 直接 true", () => {
    expect(checkDocMagicBytes(Buffer.from("hello"), ".txt")).toBe(true);
  });

  it(".md → 直接 true", () => {
    expect(checkDocMagicBytes(Buffer.from("# heading"), ".md")).toBe(true);
  });

  it(".csv → 直接 true", () => {
    expect(checkDocMagicBytes(Buffer.from("a,b,c"), ".csv")).toBe(true);
  });

  it(".json → 直接 true", () => {
    expect(checkDocMagicBytes(Buffer.from('{"key":"val"}'), ".json")).toBe(true);
  });

  it(".txt 空 buffer → true（纯文本无签名检查）", () => {
    expect(checkDocMagicBytes(Buffer.alloc(0), ".txt")).toBe(true);
  });
});
