const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const router = require("express").Router();
const multer = require("multer");
const path = require("path");
const { IMAGES_DIR } = require("../lib/config");

const ALLOWED_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const ALLOWED_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: IMAGES_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".bin";
      // 使用 UUID v4 (128 位熵) 防止暴力枚举攻击
      const unique = crypto.randomUUID();
      cb(null, unique + ext);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_MIME.includes(file.mimetype) || !ALLOWED_EXTS.includes(ext)) {
      return cb(new Error("不支持的文件格式，仅限 PNG/JPG/GIF/WebP"));
    }
    cb(null, true);
  },
});

// Magic bytes 签名校验（更严格版本）
function checkMagicBytes(buf) {
  if (buf.length < 12) return false;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) {
    return true;
  }

  // JPEG: FF D8 FF XX (SOI + 常见标记：E0-EF APP, C0-CF SOF, DB DQT, DD DRI, DA SOS 等)
  // 合法的 JPEG 第 4 字节必须是有效标记(0xC0-0xFE)，拒绝 0x00-0xBF 和 0xFF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF && buf[3] >= 0xC0 && buf[3] !== 0xFF) {
    return true;
  }

  // GIF: "GIF87a" 或 "GIF89a"
  const gif = buf.toString("ascii", 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") {
    return true;
  }

  // WebP: "RIFF" + 4字节size + "WEBP"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf.toString("ascii", 8, 12) === "WEBP") {
    return true;
  }

  return false;
}

router.post("/images", (req, res, next) => {
  imageUpload.single("image")(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "文件大小超过 10MB 限制" });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "请选择一个图片文件" });
  }

  // 读取文件头校验 magic bytes
  try {
    const fd = await fsp.open(req.file.path, "r");
    const buf = Buffer.alloc(12);
    try {
      await fd.read(buf, 0, 12, 0);
    } finally {
      await fd.close();
    }
    if (!checkMagicBytes(buf)) {
      await fsp.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: "文件内容与声明的图片格式不匹配" });
    }
  } catch {
    await fsp.unlink(req.file.path).catch(() => {});
    return res.status(500).json({ error: "Internal server error" });
  }

  res.json({ ok: true, url: "/images/" + req.file.filename });
});

module.exports = router;
module.exports.checkMagicBytes = checkMagicBytes;
