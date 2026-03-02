// routes/images.js 纯函数 checkMagicBytes 测试

const { checkMagicBytes } = require("../routes/images");

describe("checkMagicBytes", () => {
  // === PNG ===

  it("PNG 有效签名 → true", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
    expect(checkMagicBytes(buf)).toBe(true);
  });

  it("PNG 签名错误 → false", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0B, 0, 0, 0, 0]);
    expect(checkMagicBytes(buf)).toBe(false);
  });

  // === JPEG ===

  it("JPEG FFD8FFE0 (JFIF) → true", () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(checkMagicBytes(buf)).toBe(true);
  });

  it("JPEG FFD8FFE1 (EXIF) → true", () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(checkMagicBytes(buf)).toBe(true);
  });

  it("JPEG FFD8FFC0 (SOF0) → true", () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xC0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(checkMagicBytes(buf)).toBe(true);
  });

  it("JPEG 第4字节 < 0xC0 → false", () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xBF, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(checkMagicBytes(buf)).toBe(false);
  });

  it("JPEG 第4字节 = 0xFF → false", () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(checkMagicBytes(buf)).toBe(false);
  });

  // === GIF ===

  it("GIF87a → true", () => {
    const buf = Buffer.from("GIF87a" + "\0".repeat(6));
    expect(checkMagicBytes(buf)).toBe(true);
  });

  it("GIF89a → true", () => {
    const buf = Buffer.from("GIF89a" + "\0".repeat(6));
    expect(checkMagicBytes(buf)).toBe(true);
  });

  it("GIF90a → false", () => {
    const buf = Buffer.from("GIF90a" + "\0".repeat(6));
    expect(checkMagicBytes(buf)).toBe(false);
  });

  // === WebP ===

  it("WebP RIFF...WEBP → true", () => {
    const buf = Buffer.alloc(12);
    buf.write("RIFF", 0, "ascii");
    buf.writeUInt32LE(1000, 4); // size
    buf.write("WEBP", 8, "ascii");
    expect(checkMagicBytes(buf)).toBe(true);
  });

  it("RIFF...XXXX → false", () => {
    const buf = Buffer.alloc(12);
    buf.write("RIFF", 0, "ascii");
    buf.writeUInt32LE(1000, 4);
    buf.write("XXXX", 8, "ascii");
    expect(checkMagicBytes(buf)).toBe(false);
  });

  // === 边界情况 ===

  it("buf < 12 字节 → false", () => {
    expect(checkMagicBytes(Buffer.alloc(8))).toBe(false);
  });

  it("空 Buffer → false", () => {
    expect(checkMagicBytes(Buffer.alloc(0))).toBe(false);
  });

  it("全零 12 字节 → false", () => {
    expect(checkMagicBytes(Buffer.alloc(12))).toBe(false);
  });
});
