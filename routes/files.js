const router = require("express").Router();
const multer = require("multer");
const path = require("path");
const { extractText } = require("../lib/document-reader");

const ALLOWED_EXTS = new Set([".pdf", ".docx", ".txt", ".md", ".csv", ".json"]);
const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  // 某些系统对 .md/.csv 报 application/octet-stream
  "application/octet-stream",
]);

const fileUpload = multer({
  storage: multer.memoryStorage(), // 不落盘，解析后丢弃
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      return cb(new Error("仅支持 PDF、Word、TXT、Markdown、CSV、JSON 文件"));
    }
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error("文件 MIME 类型不支持"));
    }
    cb(null, true);
  },
});

/** magic bytes 校验 */
function checkDocMagicBytes(buf, ext) {
  if (ext === ".pdf") {
    // PDF: %PDF-
    return buf.length >= 5 && buf.toString("ascii", 0, 5) === "%PDF-";
  }
  if (ext === ".docx") {
    // DOCX (ZIP): PK\x03\x04
    return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  }
  // TXT/MD/CSV/JSON — 纯文本无固定签名，跳过 magic bytes 检查
  return true;
}

router.post("/files/read", (req, res, next) => {
  fileUpload.single("file")(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "文件过大，限制 10MB" });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "请选择一个文件" });
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  const buf = req.file.buffer;

  // magic bytes 校验
  if (!checkDocMagicBytes(buf, ext)) {
    return res.status(400).json({ error: "文件内容与声明的格式不匹配" });
  }

  try {
    // 30 秒解析超时，防恶意 PDF bomb
    const PARSE_TIMEOUT = 30_000;
    const result = await Promise.race([
      extractText(buf, ext),
      new Promise((_, reject) => setTimeout(() => reject(new Error("parse_timeout")), PARSE_TIMEOUT)),
    ]);

    if (!result.text || result.text.length === 0) {
      return res.status(422).json({ error: "未提取到可读文本，文件可能是扫描件或内容为空" });
    }

    res.json({
      ok: true,
      fileName: req.file.originalname,
      fileType: ext.slice(1), // "pdf" / "docx" / "txt"
      pages: result.pages,
      truncated: result.truncated,
      originalChars: result.originalChars,
      usedChars: result.text.length,
      text: result.text,
    });
  } catch (err) {
    console.error("[files/read] extraction failed:", err.message);
    const msg = err.message === "parse_timeout"
      ? "文件解析超时，文件可能过于复杂"
      : err.message?.includes("encrypt") || err.message?.includes("password")
        ? "无法读取文件内容，文件可能已加密"
        : "文件解析失败，格式可能不受支持";
    res.status(422).json({ error: msg });
  }
});

module.exports = router;
module.exports.checkDocMagicBytes = checkDocMagicBytes;
