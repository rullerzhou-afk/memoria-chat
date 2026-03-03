import { state, documentPreview } from "./state.js";
import { apiFetch, showToast, escapeHtml } from "./api.js";
import { t } from "./i18n.js";

const DOC_EXTS = new Set([".pdf", ".docx", ".txt", ".md", ".csv", ".json"]);

let _docUploadAbort = null; // 取消先前的上传请求，防 race

/** 判断文件是否为文档类型 */
export function isDocumentFile(file) {
  const name = file.name || "";
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return DOC_EXTS.has(ext);
}

/**
 * 上传文件到服务端解析，成功后存入 state.pendingDocument。
 * 一次只支持一个文档，重复上传会替换。
 */
export async function addDocument(file) {
  if (state.isStreaming) return;

  const fileName = file.name || "";
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if (!DOC_EXTS.has(ext)) {
    showToast(t("err_unsupported_format"), "warning");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast(t("err_file_too_large"), "warning");
    return;
  }

  // 取消先前的上传请求
  if (_docUploadAbort) _docUploadAbort.abort();
  const abort = (_docUploadAbort = new AbortController());

  // 上传状态提示
  renderDocumentPreview({ name: file.name, loading: true });

  try {
    const formData = new FormData();
    formData.append("file", file);

    const res = await apiFetch("/api/files/read", {
      method: "POST",
      body: formData,
      signal: abort.signal,
      // 不设 Content-Type，让浏览器自动加 multipart boundary
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    state.pendingDocument = {
      name: data.fileName,
      text: data.text,
      pages: data.pages,
      truncated: data.truncated,
      originalChars: data.originalChars,
      usedChars: data.usedChars,
    };
    renderDocumentPreview(state.pendingDocument);
  } catch (err) {
    if (err.name === "AbortError") return; // 被新上传取消，静默忽略
    state.pendingDocument = null;
    renderDocumentPreview(null);
    showToast(err.message || t("err_file_read"), "warning");
  }
}

/** 渲染文档预览条 */
export function renderDocumentPreview(doc) {
  if (!documentPreview) return;

  if (!doc) {
    documentPreview.classList.add("hidden");
    documentPreview.innerHTML = "";
    return;
  }

  documentPreview.classList.remove("hidden");

  if (doc.loading) {
    documentPreview.innerHTML = `
      <div class="doc-preview-item">
        <span class="doc-icon">📄</span>
        <span class="doc-name">${escapeHtml(doc.name)}</span>
        <span class="doc-status">${t("status_reading")}</span>
      </div>`;
    return;
  }

  const pageInfo = doc.pages ? t("label_pages", { count: doc.pages }) : "";
  const charInfo = t("label_chars", { count: (doc.usedChars || 0).toLocaleString() });
  const truncLabel = doc.truncated ? `<span class="doc-truncated">${t("label_truncated")}</span>` : "";
  const sep = t("misc_separator");
  const meta = [pageInfo, charInfo].filter(Boolean).join(sep);

  documentPreview.innerHTML = `
    <div class="doc-preview-item">
      <span class="doc-icon">📄</span>
      <span class="doc-name">${escapeHtml(doc.name)}</span>
      <span class="doc-meta">（${meta}）${truncLabel}</span>
      <button class="doc-remove" title="${t("title_remove_doc")}">&times;</button>
    </div>`;

  documentPreview.querySelector(".doc-remove")?.addEventListener("click", clearPendingDocument);
}

/** 清空待发文档 */
export function clearPendingDocument() {
  state.pendingDocument = null;
  renderDocumentPreview(null);
}

