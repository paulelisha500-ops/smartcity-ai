// Serves ./out the way the Hugging Face static host does, quirks included, so
// the hosted edition can be checked locally before it is published:
//   - "/" redirects to /index.html
//   - "/page" serves page.html; "/page/" is not resolved
//   - a <script> is injected ahead of the doctype of every HTML document
// Usage: npm run build:static && node scripts/serve-static.mjs [port]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "out");
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 7861);
// INJECT=0 serves the documents untouched, to tell a host quirk from a real bug.
const INJECTED = process.env.INJECT === "0"
  ? ""
  : '<script>window.huggingface={variables:{"SPACE_CREATOR_USER_ID":"local"}};</script>';
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".bin": "application/octet-stream",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2",
};

const isFile = (path) => stat(path).then((s) => s.isFile(), () => false);

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (path === "/") {
    res.writeHead(302, { Location: "/index.html" }).end();
    return;
  }
  let file = join(ROOT, normalize(path));
  if (!file.startsWith(ROOT) || path.endsWith("/")) file = "";
  else if (!(await isFile(file))) file = (await isFile(`${file}.html`)) ? `${file}.html` : "";

  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Entry not found");
    return;
  }
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  const body = await readFile(file);
  res.writeHead(200, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
  res.end(type.startsWith("text/html") ? Buffer.concat([Buffer.from(INJECTED), body]) : body);
}).listen(PORT, () => console.log(`hosted edition preview: http://localhost:${PORT}`));
