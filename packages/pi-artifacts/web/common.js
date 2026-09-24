// Shared helpers: theme, formatting, hljs theme swap.
export function initTheme() {
  const saved = localStorage.getItem("pa-theme");
  const theme = saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
  syncHljsTheme(theme);
  return theme;
}
export function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", cur);
  localStorage.setItem("pa-theme", cur);
  syncHljsTheme(cur);
  return cur;
}
function syncHljsTheme(theme) {
  const light = document.getElementById("hljs-light");
  const dark = document.getElementById("hljs-dark");
  if (light) light.disabled = theme === "dark";
  if (dark) dark.disabled = theme !== "dark";
}
export function currentTheme() {
  return document.documentElement.getAttribute("data-theme") || "light";
}

export function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}
export function fmtDate(ts) { return new Date(ts).toLocaleString(); }
export function fmtSize(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export const KIND_ICON = { markdown: "📝", html: "🌐", pdf: "📄", code: "⟨⟩", image: "🖼", video: "🎬", audio: "🎧", other: "📎" };
export function shortProject(p) {
  if (!p) return "—";
  const parts = p.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(-1)[0] : p;
}

export const TEXT_PREVIEW_THRESHOLD = 1024 * 1024;
export const TEXT_PREVIEW_CHUNK = 64 * 1024;

/** Decide whether a text artifact should show a head/tail preview instead of loading the whole body.
 *  `contentLength` is the byte length from a HEAD response; `rangeSupported` is true when the
 *  server returned Accept-Ranges: bytes (or a 206 we already proved). */
export function shouldPreviewText(contentLength, rangeSupported) {
  return Boolean(rangeSupported) && typeof contentLength === "number" && contentLength > TEXT_PREVIEW_THRESHOLD;
}

export function artifactDisplayPath(artifact = {}) {
  if (typeof artifact.source_path === "string" && artifact.source_path) return artifact.source_path;
  const projectPath = typeof artifact.project_path === "string" ? artifact.project_path : "";
  const filename = typeof artifact.filename === "string" ? artifact.filename : "";
  if (!projectPath) return filename;
  if (!filename) return projectPath;
  const separator = projectPath.includes("\\") && !projectPath.includes("/") ? "\\" : "/";
  const base = projectPath.replace(/[\\/]+$/, "");
  const name = filename.replace(/^[\\/]+/, "");
  return `${base || separator}${base ? separator : ""}${name}`;
}
