// Serves ./out the way its real hosts do, quirks included, so the hosted
// edition can be checked locally before it is published.
//
//   node scripts/serve-static.mjs [port]                      # as the Hugging Face Space
//   HOST_AS=pages BASE_PATH=/smartcity-ai node scripts/serve-static.mjs [port]
//
// As the Space (default): "/" redirects to /index.html, "/page" serves
// page.html, "/page/" is not resolved, an unknown path is a bare 404, and a
// <script> is injected ahead of the doctype of every HTML document (which
// puts the page in quirks mode). INJECT=0 leaves the documents untouched, to
// tell a host quirk from a real bug.
//
// As GitHub Pages: the site lives under BASE_PATH, "/" serves index.html
// directly, "/page" serves page.html, and an unknown path gets 404.html.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "out");
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 7861);
const PAGES = process.env.HOST_AS === "pages";
const BASE_PATH = (process.env.BASE_PATH ?? "").replace(/\/+$/, "");
const INJECTED = PAGES || process.env.INJECT === "0"
  ? ""
  : '<script>window.huggingface={variables:{"SPACE_CREATOR_USER_ID":"local"}};</script>';
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".bin": "application/octet-stream",
  ".gz": "application/gzip", ".jpg": "image/jpeg", ".webp": "image/webp", ".png": "image/png",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

const isFile = (path) => stat(path).then((s) => s.isFile(), () => false);

async function send(res, status, file) {
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  const body = await readFile(file);
  res.writeHead(status, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
  res.end(type.startsWith("text/html") ? Buffer.concat([Buffer.from(INJECTED), body]) : body);
}

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);

  if (BASE_PATH) {
    if (path !== BASE_PATH && !path.startsWith(`${BASE_PATH}/`)) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found (outside the base path)");
      return;
    }
    path = path.slice(BASE_PATH.length) || "/";
  }

  if (path === "/") {
    if (PAGES) return send(res, 200, join(ROOT, "index.html"));
    res.writeHead(302, { Location: "/index.html" }).end();
    return;
  }

  let file = join(ROOT, normalize(path));
  if (!file.startsWith(ROOT) || path.endsWith("/")) file = "";
  else if (!(await isFile(file))) file = (await isFile(`${file}.html`)) ? `${file}.html` : "";

  if (file) return send(res, 200, file);
  if (PAGES && (await isFile(join(ROOT, "404.html")))) return send(res, 404, join(ROOT, "404.html"));
  res.writeHead(404, { "Content-Type": "text/plain" }).end("Entry not found");
}).listen(PORT, () => console.log(
  `serving out/ as ${PAGES ? "GitHub Pages" : "the Hugging Face Space"}: http://localhost:${PORT}${BASE_PATH}`,
));
