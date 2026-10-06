// End-to-end suite for the hosted edition.
//
// Drives a real browser through every control on the public website and in
// the operations console, against whichever host it is pointed at:
//
//   node e2e/suite.mjs                                   # local preview (:7861)
//   node e2e/suite.mjs https://elisha622-smartcity-ai.static.hf.space
//   node e2e/suite.mjs https://paulelisha500-ops.github.io/smartcity-ai
//
// A check fails if its own assertions fail, or if the page logged an error,
// threw, showed an unexpected error banner, or had one of its own requests
// fail while the check ran. Third-party requests (map tiles, web fonts) are
// reported separately: they depend on someone else's uptime.
//
// Uses the Chrome already installed on the machine (set E2E_CHANNEL=chromium
// to use a Playwright-managed browser instead, e.g. in CI).
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const BASE = (process.argv[2] ?? "http://localhost:7861").replace(/\/+$/, "");
const ORIGIN = new URL(BASE).origin;
const PREFIX = new URL(BASE).pathname.replace(/\/+$/, "");
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY, "i") : null;
const PASSWORD = process.env.E2E_PASSWORD ?? "smartcity";

const ACCOUNTS = {
  admin: "admin@city.gov",
  traffic_officer: "officer@city.gov",
  city_planner: "planner@city.gov",
  maintenance_department: "maintenance@city.gov",
  public_user: "citizen@example.com",
};

// What each role's sidebar should offer — the contract in components/Sidebar.tsx.
const NAV = {
  admin: ["/", "/traffic", "/cameras", "/dispatch", "/complaints", "/maintenance", "/network",
    "/infrastructure", "/route-design", "/planner", "/analytics"],
  traffic_officer: ["/", "/traffic", "/cameras", "/dispatch", "/complaints", "/analytics"],
  city_planner: ["/", "/traffic", "/complaints", "/maintenance", "/network", "/infrastructure",
    "/route-design", "/planner", "/analytics"],
  maintenance_department: ["/", "/complaints", "/maintenance", "/analytics"],
};

const CONSOLE_PAGES = {
  "/": "Digital Twin",
  "/traffic": "Smart Traffic Analysis",
  "/cameras": "CCTV Camera Network",
  "/dispatch": "Emergency Dispatch",
  "/complaints": "Citizen Complaint Analysis",
  "/maintenance": "Road Maintenance Priority Queue",
  "/network": "UAE Road Network",
  "/infrastructure": "Bridges & Infrastructure Projects",
  "/route-design": "New Route Design",
  "/planner": "AI City Planner",
  "/analytics": "Government Analytics",
};
const PUBLIC_PAGES = {
  "/welcome": "Intelligent urban planning",
  "/about": "About the platform",
  "/faq": "Frequently asked questions",
  "/report": "Report a problem",
  "/login": "Sign in",
};

/* ------------------------------------------------------------- harness */

const results = [];
const external = new Map();
let problems = [];
// Page-data prefetches a navigation cancelled during the current check. Next
// logs each as "Failed to fetch RSC payload"; a click never cancels them, but
// a test's page.goto does.
let cancelled = new Set();

const url = (path) => `${BASE}${path === "/" ? "/" : path}`;
/** The href Next renders for an app path on this host. */
const hrefOf = (path) => (PREFIX ? (path === "/" ? PREFIX : `${PREFIX}${path}`) : path);
/** The app's own path for the current URL, without the host's base path. */
const pathOf = (page) => {
  const p = new URL(page.url()).pathname;
  const own = PREFIX && p.startsWith(PREFIX) ? p.slice(PREFIX.length) : p;
  return own.replace(/\/index\.html$/, "/") || "/";
};

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function watch(page) {
  const isOwn = (u) => u.startsWith(ORIGIN) || u.startsWith("blob:") || u.startsWith("data:");
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // A failed third-party fetch is logged by the browser as a console error;
    // it is counted under external requests instead.
    if (/Failed to load resource/.test(text) && !isOwn(msg.location().url ?? "")) return;
    problems.push(`console error: ${text.slice(0, 300)}`);
  });
  page.on("pageerror", (err) => problems.push(`uncaught: ${String(err.message).slice(0, 300)}`));
  page.on("requestfailed", (req) => {
    const u = req.url();
    const why = req.failure()?.errorText ?? "";
    if (/ERR_ABORTED/.test(why)) { // navigation cancelled an in-flight request
      const target = new URL(u);
      if (isOwn(u) && target.searchParams.has("_rsc")) {
        // /about.txt?_rsc=… is the payload for /about; /index.txt, for /.
        cancelled.add(`${target.origin}${target.pathname.replace(/\.txt$/, "").replace(/\/index$/, "/")}`);
      }
      return;
    }
    if (isOwn(u)) problems.push(`request failed: ${u} (${why})`);
    else external.set(new URL(u).host, (external.get(new URL(u).host) ?? 0) + 1);
  });
  page.on("response", (res) => {
    if (res.status() < 400) return;
    const u = res.url();
    if (isOwn(u)) problems.push(`HTTP ${res.status()}: ${u}`);
    else external.set(new URL(u).host, (external.get(new URL(u).host) ?? 0) + 1);
  });
}

async function check(area, name, fn, { allow = [] } = {}) {
  const label = `${area} › ${name}`;
  if (ONLY && !ONLY.test(label)) return;
  problems = [];
  cancelled = new Set();
  const started = Date.now();
  let error = null;
  try {
    await fn();
  } catch (e) {
    error = String(e.message ?? e).split("\n")[0].slice(0, 400);
  }
  const unexpected = problems
    .filter((p) => !cancelled.has(/^console error: Failed to fetch RSC payload for (\S+?)\. /.exec(p)?.[1]))
    .filter((p) => !allow.some((re) => re.test(p)));
  const failures = [...(error ? [error] : []), ...unexpected];
  results.push({ label, ok: failures.length === 0, failures, ms: Date.now() - started });
  process.stdout.write(`${failures.length ? "FAIL" : " ok "}  ${label}${failures.length ? `\n        ${failures.join("\n        ")}` : ""}\n`);
}

const settle = (page, ms = 400) => page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {}).then(() => page.waitForTimeout(ms));

async function open(page, path) {
  await page.goto(url(path), { waitUntil: "domcontentloaded" });
  await settle(page);
}

// Next's own route announcer also carries role="alert" (it reads the page
// title to screen readers); it is not an error banner.
const BANNER = '[role="alert"]:not(#__next-route-announcer__)';
const banners = async (page) =>
  (await page.locator(`${BANNER}:visible`).allInnerTexts()).filter((text) => text.trim());
const notes = (page) => page.locator('[role="status"]:visible').allInnerTexts();
const mainText = (page) => page.locator("main").innerText();

async function noBanner(page) {
  const shown = await banners(page);
  expect(shown.length === 0, `error banner shown: ${shown.join(" | ").slice(0, 200)}`);
}

async function heading(page, text) {
  await page.waitForFunction(
    (t) => [...document.querySelectorAll("h1")].some((h) => h.textContent.includes(t)),
    text, { timeout: 15000 },
  ).catch(() => { throw new Error(`heading "${text}" never appeared at ${page.url()}`); });
}

/** Every image that should have loaded did, and none is broken. */
async function imagesLoaded(page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 80));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(600);
  const broken = await page.evaluate(() =>
    [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src));
  expect(broken.length === 0, `broken images: ${broken.join(", ")}`);
}

async function noSidewaysScroll(page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over <= 1, `page is ${over}px wider than the screen`);
}

async function signIn(page, role) {
  await open(page, "/login");
  await page.getByRole("button", { name: new RegExp(ACCOUNTS[role].replace(".", "\\.")) }).click();
  expect(await page.locator("#login-email").inputValue() === ACCOUNTS[role], "account row did not fill the email");
  expect((await page.locator("#login-password").inputValue()).length > 0, "account row did not fill the password");
  await page.getByRole("button", { name: /^SIGN IN$/ }).click();
  const home = role === "public_user" ? "/report" : "/";
  await page.waitForFunction(
    ({ prefix, home }) => {
      const p = location.pathname.startsWith(prefix) ? location.pathname.slice(prefix.length) : location.pathname;
      return (p || "/") === home;
    },
    { prefix: PREFIX, home }, { timeout: 15000 },
  ).catch(() => { throw new Error(`sign-in as ${role} did not reach ${home} (at ${page.url()})`); });
  await settle(page);
}

/** Session without the form — for checks that are not about signing in. */
async function asRole(page, role) {
  await page.goto(url("/login"), { waitUntil: "domcontentloaded" });
  await page.evaluate(([email, r]) => {
    localStorage.setItem("smartcity.user", JSON.stringify({ email, role: r, exp: Math.floor(Date.now() / 1000) + 28800 }));
  }, [ACCOUNTS[role], role]);
}

async function mapReady(page) {
  await page.locator(".leaflet-container").first().waitFor({ timeout: 20000 });
  // Ready means Leaflet has laid out its tiles. Whether the basemap images have
  // arrived is the tile server's business, not this site's.
  await page.waitForFunction(() => document.querySelectorAll(".leaflet-tile").length > 0, null, { timeout: 20000 })
    .catch(() => { throw new Error("the map never laid out its tiles"); });
}

/** Where the map is looking, worked out from the tiles it has laid out. */
const mapCentre = (page) => page.evaluate(() => {
  const tiles = [...document.querySelectorAll(".leaflet-tile")]
    .map((t) => t.src.match(/tile\/(\d+)\/(\d+)\/(\d+)/)).filter(Boolean).map((m) => m.slice(1).map(Number));
  const z = Math.max(...tiles.map((t) => t[0]));
  const at = tiles.filter((t) => t[0] === z);
  const n = 2 ** z;
  const y = at.reduce((sum, t) => sum + t[1], 0) / at.length + 0.5;
  const x = at.reduce((sum, t) => sum + t[2], 0) / at.length + 0.5;
  return { lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI, lon: (x / n) * 360 - 180 };
});

async function mapLooksAt(page, lat, lon, tolerance, what) {
  await page.waitForTimeout(900);
  const c = await mapCentre(page);
  expect(Math.abs(c.lat - lat) < tolerance && Math.abs(c.lon - lon) < tolerance,
    `${what}: the map is looking at ${c.lat.toFixed(2)}, ${c.lon.toFixed(2)} — expected near ${lat}, ${lon}`);
}

/** Type into a place search and wait until its list answers this query. */
async function searchFor(page, term, expected) {
  await page.getByRole("combobox").fill(term);
  await page.waitForFunction(
    (source) => [...document.querySelectorAll('[role="option"]')].some((o) => new RegExp(source, "i").test(o.innerText)),
    expected.source, { timeout: 30000 },
  ).catch(async () => {
    const shown = await page.locator('[role="option"]').allInnerTexts();
    throw new Error(`search for "${term}" did not find ${expected}: ${shown.slice(0, 3).map((o) => o.replace(/\n/g, " ")).join(" / ")}`);
  });
}

const zoomLevel = (page) => page.evaluate(() =>
  Math.max(...[...document.querySelectorAll(".leaflet-tile")].map((t) => Number(t.src.match(/tile\/(\d+)\//)?.[1] ?? 0))));

async function mapControls(page) {
  await mapReady(page);
  const before = await zoomLevel(page);
  await page.locator(".leaflet-control-zoom-in").first().click();
  await page.waitForTimeout(900);
  expect(await zoomLevel(page) === before + 1, `zoom in did not change the zoom (${before} -> ${await zoomLevel(page)})`);
  await page.locator(".leaflet-control-zoom-out").first().click();
  await page.waitForTimeout(900);
  expect(await zoomLevel(page) === before, "zoom out did not restore the zoom");
}

/* --------------------------------------------------------------- suite */

const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL ?? "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
watch(page);

console.log(`\nSmartCity AI end-to-end suite\ntarget: ${BASE}\n`);

/* ============================================================== WEBSITE */

for (const [path, title] of Object.entries(PUBLIC_PAGES)) {
  await check("website", `${path} opens directly`, async () => {
    await context.clearCookies();
    await open(page, path);
    await page.evaluate(() => localStorage.clear());
    await open(page, path);
    await heading(page, title);
    expect(pathOf(page) === path, `landed on ${pathOf(page)}`);
    await noBanner(page);
    await imagesLoaded(page);
    await noSidewaysScroll(page);
  });
}

await check("website", "root sends a signed-out visitor to the welcome page", async () => {
  await open(page, "/");
  await page.waitForFunction((p) => location.pathname.endsWith("/welcome"), null, { timeout: 15000 });
  await heading(page, "Intelligent urban planning");
});

await check("website", "console pages are closed to signed-out visitors", async () => {
  for (const path of ["/traffic", "/cameras", "/network", "/analytics"]) {
    await page.goto(url(path), { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => location.pathname.endsWith("/welcome"), null, { timeout: 15000 })
      .catch(() => { throw new Error(`${path} did not redirect a signed-out visitor`); });
  }
});

await check("website", "a console page addressed by its file name is still closed", async () => {
  // A static host serves /cameras and /cameras.html alike; the second must not
  // slip past the access checks.
  for (const path of ["/cameras.html", "/network.html", "/index.html"]) {
    await page.goto(url(path), { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => location.pathname.endsWith("/welcome"), null, { timeout: 15000 })
      .catch(() => { throw new Error(`${path} is open to a signed-out visitor (at ${page.url()})`); });
  }
  await asRole(page, "maintenance_department");
  await page.goto(url("/cameras.html"), { waitUntil: "domcontentloaded" });
  await heading(page, "Digital Twin").catch(() => { throw new Error("/cameras.html is open to a role that may not see cameras"); });
  expect(pathOf(page) === "/", `the maintenance role was left on ${pathOf(page)}`);
  await page.evaluate(() => localStorage.clear());
});

await check("website", "unknown address shows the not-found page", async () => {
  const res = await page.goto(url("/no-such-page"), { waitUntil: "domcontentloaded" });
  expect(res.status() === 404, `status ${res.status()} for an unknown address`);
  const text = await page.locator("body").innerText();
  expect(/404|not found|could not be found/i.test(text), "no not-found message");
}, { allow: [/HTTP 404: .*no-such-page/, /console error: Failed to load resource.*404/] });

await check("website", "top navigation reaches every page from every page", async () => {
  for (const from of ["/welcome", "/about", "/faq", "/report"]) {
    for (const [label, to] of [["Report an Issue", "/report"], ["About", "/about"], ["FAQ", "/faq"], ["Home", "/welcome"]]) {
      await open(page, from);
      await page.locator("header nav").getByRole("link", { name: label, exact: true }).click();
      await page.waitForFunction((t) => location.pathname.endsWith(t), to, { timeout: 15000 })
        .catch(() => { throw new Error(`"${label}" from ${from} did not reach ${to}`); });
      await heading(page, PUBLIC_PAGES[to]);
    }
    await open(page, from);
    await page.locator("header").getByRole("link", { name: "SIGN IN" }).click();
    await heading(page, "Sign in");
    await open(page, from);
    await page.locator("header a").first().click();
    await heading(page, PUBLIC_PAGES["/welcome"]);
  }
});

await check("website", "welcome: live figures and every call-to-action", async () => {
  await open(page, "/welcome");
  const text = await mainText(page);
  expect(/50,0\d\d/.test(text), "network length is missing from the hero figures");
  expect(/170,8\d\d/.test(text), "link count is missing from the hero figures");
  for (const [label, to, title] of [
    [/SIGN IN TO THE CONSOLE/, "/login", "Sign in"],
    [/WHAT IT DOES/, "/about", "About the platform"],
    [/Report a problem/, "/report", "Report a problem"],
  ]) {
    await open(page, "/welcome");
    await page.locator("main section").first().getByRole("link", { name: label }).click();
    await heading(page, title);
    expect(pathOf(page) === to, `${label} went to ${pathOf(page)}`);
  }
  await open(page, "/welcome");
  const lower = page.locator("main").getByRole("link", { name: /^SIGN IN/ }).last();
  await lower.scrollIntoViewIfNeeded();
  await lower.click();
  await heading(page, "Sign in");
});

await check("website", "footer links", async () => {
  for (const [label, title] of [["About", "About the platform"], ["FAQ", "Frequently asked questions"], ["Sign in", "Sign in"]]) {
    await open(page, "/welcome");
    const link = page.locator("footer").getByRole("link", { name: label, exact: true });
    await link.scrollIntoViewIfNeeded();
    await link.click();
    await heading(page, title);
  }
});

await check("website", "about: call-to-action", async () => {
  await open(page, "/about");
  const cta = page.locator("main").getByRole("link").filter({ hasText: /console|sign in/i }).last();
  await cta.scrollIntoViewIfNeeded();
  await cta.click();
  await heading(page, "Sign in");
});

await check("website", "faq: every question opens and closes", async () => {
  await open(page, "/faq");
  const questions = page.locator('main button[aria-controls^="faq-"]');
  const count = await questions.count();
  expect(count >= 10, `only ${count} questions found`);
  for (let i = 0; i < count; i++) {
    const q = questions.nth(i);
    await q.scrollIntoViewIfNeeded();
    if (await q.getAttribute("aria-expanded") === "true") await q.click();
    await q.click();
    expect(await q.getAttribute("aria-expanded") === "true", `question ${i + 1} did not open`);
    const panelId = await q.getAttribute("aria-controls");
    const panel = page.locator(`[id="${panelId}"]`);
    expect(await panel.count() === 1, `question ${i + 1} points at a panel that does not exist (${panelId})`);
    await page.waitForTimeout(550);
    expect((await panel.innerText()).trim().length > 40, `question ${i + 1} opened with no answer`);
    expect(await panel.getAttribute("inert") === null, `question ${i + 1} is open but inert`);
    await q.click();
    expect(await q.getAttribute("aria-expanded") === "false", `question ${i + 1} did not close`);
    expect(await panel.getAttribute("inert") !== null, `question ${i + 1} is closed but its links can still be tabbed to`);
  }
  await questions.first().click();
  await page.locator("main").getByRole("link", { name: "sign-in page" }).click();
  await heading(page, "Sign in");
  await open(page, "/faq");
  const cta = page.getByRole("link", { name: "EXPLORE THE CONSOLE" });
  await cta.scrollIntoViewIfNeeded();
  await cta.click();
  await heading(page, "Sign in");
});

await check("website", "report: the whole form", async () => {
  await open(page, "/report");
  const submit = page.getByRole("button", { name: /Submit report/i });
  expect(await submit.isDisabled(), "submit is enabled with nothing typed");
  // No server stands behind this edition, and the page has to say so: someone
  // reporting a real hazard must not think it reached the city.
  const notice = await page.locator('main [role="note"]').innerText().catch(() => "");
  expect(/not sent to any authority/i.test(notice), "the page does not say that reports here are not delivered");
  expect(!/City staff can see submitted reports/.test(await mainText(page)), "the page still claims staff can see reports");
  await page.getByLabel("Describe the problem").fill("abc");
  expect(await submit.isDisabled(), "submit is enabled for a three-letter report");

  await page.getByLabel("Describe the problem").fill("Huge pothole near the hospital, been there for two weeks.");
  expect(await submit.isEnabled(), "submit stayed disabled for a valid report");

  const search = page.getByRole("combobox");
  // Enter in the location box, before any result has arrived, must not file the report.
  await search.pressSequentially("rash", { delay: 20 });
  await search.press("Enter");
  await page.waitForTimeout(600);
  expect(await page.locator('[role="status"]').filter({ hasText: "AI analysis result" }).count() === 0,
    "Enter in the location box submitted the report");
  expect((await page.getByLabel("Describe the problem").inputValue()).length > 0, "Enter in the location box cleared the report");

  await searchFor(page, "rashid hospital", /Rashid Hospital/);
  const panel = await page.locator('[role="listbox"]').evaluate((el) => getComputedStyle(el).backgroundColor);
  const alpha = Number(panel.match(/rgba?\(([^)]+)\)/)[1].split(",")[3] ?? 1);
  expect(alpha >= 0.9, `the results panel is see-through (background ${panel})`);
  await page.locator('[role="option"] button').filter({ hasText: /Rashid Hospital/i }).first().click();
  await page.waitForTimeout(700);
  expect(await page.locator('[role="option"]').count() === 0, "results reopened after choosing one");
  expect(await page.getByText(/📍/).count() === 1, "chosen location is not shown");

  await page.getByRole("button", { name: "clear" }).click();
  expect(await page.getByText(/📍/).count() === 0, "clear did not remove the location");
  expect(await page.getByRole("combobox").inputValue() === "", "clear left the place name in the search box");

  await searchFor(page, "dubai mall", /Dubai Mall/);
  await search.press("ArrowDown");
  await search.press("Enter");
  expect(await page.getByText(/📍/).count() === 1, "keyboard selection did not set the location");
  expect(await page.locator('[role="status"]').filter({ hasText: "AI analysis result" }).count() === 0,
    "choosing a place with Enter submitted the report");

  await submit.click();
  const result = page.locator('[role="status"]').filter({ hasText: "AI analysis result" });
  await result.waitFor({ timeout: 15000 });
  const triage = await result.innerText();
  expect(/Category:\s*pothole/.test(triage), `wrong category: ${triage}`);
  expect(/Priority:\s*(critical|high)/.test(triage), `wrong priority: ${triage}`);
  expect(/Routed to:\s*roads_maintenance/.test(triage), `wrong department: ${triage}`);
  expect(await page.getByLabel("Describe the problem").inputValue() === "", "the text was not cleared after submitting");
  expect(await search.inputValue() === "", "the location box was not cleared after submitting");
  expect(await page.getByText(/📍/).count() === 0, "the location was not cleared after submitting");
  await noBanner(page);

  await search.fill("zzzzqqqq");
  await page.waitForTimeout(1500);
  const empty = await notes(page);
  expect(empty.some((n) => /Nothing found/.test(n)), "no 'nothing found' message for a nonsense search");
  await search.press("Escape");

  await page.getByRole("link", { name: "Sign in", exact: true }).last().click();
  await heading(page, "Sign in");
});

await check("website", "sign-in: wrong password and bad input are refused", async () => {
  await open(page, "/login");
  await page.locator("#login-email").fill("admin@city.gov");
  await page.locator("#login-password").fill("not-the-password");
  await page.getByRole("button", { name: /^SIGN IN$/ }).click();
  await page.locator(BANNER).first().waitFor({ timeout: 10000 });
  expect((await banners(page)).some((b) => /Invalid credentials/.test(b)), "no 'invalid credentials' message");
  expect(pathOf(page) === "/login", "left the sign-in page with a wrong password");

  await page.locator("#login-email").fill("nobody@city.gov");
  await page.locator("#login-password").fill(PASSWORD);
  await page.getByRole("button", { name: /^SIGN IN$/ }).click();
  await page.waitForTimeout(800);
  expect((await banners(page)).some((b) => /Invalid credentials/.test(b)), "an unknown account was not refused");

  await page.locator("#login-email").fill("not-an-email");
  await page.getByRole("button", { name: /^SIGN IN$/ }).click();
  await page.waitForTimeout(500);
  expect(pathOf(page) === "/login", "a malformed email was accepted");
  expect(await page.evaluate(() => localStorage.getItem("smartcity.user")) === null, "a session was stored for a failed sign-in");

  await page.locator("main a, a").first().click();
  await heading(page, PUBLIC_PAGES["/welcome"]);
});

for (const role of Object.keys(ACCOUNTS)) {
  await check("website", `sign-in as ${role}`, async () => {
    await page.evaluate(() => localStorage.clear()).catch(() => {});
    await signIn(page, role);
    if (role === "public_user") {
      await heading(page, "Report a problem");
      return;
    }
    await heading(page, "Digital Twin");
    const links = await page.locator("#app-sidebar nav a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    const own = links.map((h) => (PREFIX && h.startsWith(PREFIX) ? h.slice(PREFIX.length) || "/" : h));
    expect(JSON.stringify(own) === JSON.stringify(NAV[role]), `menu is ${own.join(" ")} — expected ${NAV[role].join(" ")}`);
    expect((await page.locator("#app-sidebar").innerText()).includes(ACCOUNTS[role]), "signed-in email is not shown");

    await page.getByRole("button", { name: "SIGN OUT" }).click();
    await heading(page, PUBLIC_PAGES["/welcome"]);
    expect(await page.evaluate(() => localStorage.getItem("smartcity.user")) === null, "sign-out left the session behind");
  });
}

/* ================================================================== APP */

for (const role of Object.keys(NAV)) {
  await check("app", `${role}: every menu item opens its page`, async () => {
    await asRole(page, role);
    await open(page, "/");
    await heading(page, "Digital Twin");
    for (const path of NAV[role]) {
      const href = hrefOf(path);
      await page.locator(`#app-sidebar nav a[href="${href}"]`).click();
      await heading(page, CONSOLE_PAGES[path]);
      expect(pathOf(page) === path, `menu item ${path} landed on ${pathOf(page)}`);
      const current = await page.locator('#app-sidebar nav a[aria-current="page"]').getAttribute("href");
      expect(current === href, `menu highlights ${current} while on ${path}`);
      await settle(page);
      await noBanner(page);
    }
  });

  await check("app", `${role}: pages outside the role are closed`, async () => {
    await asRole(page, role);
    for (const path of Object.keys(CONSOLE_PAGES).filter((p) => !NAV[role].includes(p))) {
      await page.goto(url(path), { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        ({ prefix, path }) => {
          const p = location.pathname.startsWith(prefix) ? location.pathname.slice(prefix.length) : location.pathname;
          return (p || "/") !== path;
        },
        { prefix: PREFIX, path }, { timeout: 8000 },
      ).catch(() => { throw new Error(`${role} can open ${path}, which is not in its menu`); });
    }
  });
}

await check("app", "citizen account cannot open the console", async () => {
  await asRole(page, "public_user");
  for (const path of ["/", "/complaints", "/analytics", "/cameras"]) {
    await page.goto(url(path), { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => location.pathname.endsWith("/report"), null, { timeout: 8000 })
      .catch(() => { throw new Error(`a citizen account can open ${path}`); });
  }
});

for (const [path, title] of Object.entries(CONSOLE_PAGES)) {
  await check("app", `${path} opens directly and on reload`, async () => {
    await asRole(page, "admin");
    await open(page, path);
    await heading(page, title);
    expect(pathOf(page) === path, `landed on ${pathOf(page)}`);
    await noBanner(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await settle(page);
    await heading(page, title);
    await noBanner(page);
    await noSidewaysScroll(page);
  });
}

await check("app", "dashboard: figures, chart, live feed and map", async () => {
  await asRole(page, "admin");
  await open(page, "/");
  await heading(page, "Digital Twin");
  await page.waitForFunction(() => /\d/.test(document.querySelector("main")?.innerText.match(/M8\.1\s*([\d.]+)/)?.[1] ?? ""), null, { timeout: 20000 })
    .catch(() => { throw new Error("KPI figures never loaded"); });
  const text = await mainText(page);
  for (const label of ["CONGESTION INDEX", "AVG SPEED", "ROAD QUALITY", "COMPLAINTS", "RESOLUTION RATE", "SATISFACTION"]) {
    expect(text.toUpperCase().includes(label), `KPI "${label}" is missing`);
  }
  expect(!/—\s*\/100/.test(text), "a KPI is still showing a placeholder");
  expect(/50,0\d\d km of road network/.test(text), "network length is missing from the header");
  expect(/17,5\d\d named places/.test(text), "place count is missing from the header");
  expect(await page.locator("main canvas").count() >= 1, "congestion chart is missing");
  await page.getByText("LIVE", { exact: true }).waitFor({ timeout: 10000 });

  await mapControls(page);
  await page.locator(".leaflet-control-layers").hover();
  const layers = page.locator(".leaflet-control-layers-overlays label");
  const names = await layers.allInnerTexts();
  expect(names.length === 7, `layer control lists ${names.length} layers: ${names.join(", ")}`);
  for (const expected of ["Place names", "Road network", "Traffic", "CCTV", "Border crossings", "Projects", "Road damage"]) {
    expect(names.some((n) => n.includes(expected)), `layer "${expected}" is missing`);
  }
  for (let i = 0; i < names.length; i++) {
    const box = layers.nth(i).locator("input");
    await page.locator(".leaflet-control-layers").hover();
    await box.uncheck();
    expect(!(await box.isChecked()), `layer ${names[i]} would not switch off`);
    await box.check();
    expect(await box.isChecked(), `layer ${names[i]} would not switch back on`);
  }
  // The feed ticks every five seconds; make sure a tick does not break anything.
  await page.waitForTimeout(6000);
  await noBanner(page);
});

await check("app", "traffic: ranking chart and all junctions", async () => {
  await asRole(page, "admin");
  await open(page, "/traffic");
  await page.locator("tbody tr").first().waitFor({ timeout: 15000 });
  expect(await page.locator("tbody tr").count() === 20, `table has ${await page.locator("tbody tr").count()} junctions, expected 20`);
  expect(await page.locator("main canvas").count() >= 1, "ranking chart is missing");
  const row = await page.locator("tbody tr").first().innerText();
  expect(/\d/.test(row), "table rows hold no figures");

  // M4: a 24-hour forecast for the selected junction.
  await page.waitForFunction(() => document.querySelectorAll("main canvas").length >= 2, null, { timeout: 30000 })
    .catch(() => { throw new Error("the forecast chart never appeared"); });
  const select = page.getByLabel("Junction to forecast");
  const first = await select.inputValue();
  const second = await page.locator("tbody tr").nth(3).getByRole("button").innerText();
  await page.locator("tbody tr").nth(3).getByRole("button").click();
  await page.waitForTimeout(800);
  const chosen = await select.locator("option:checked").innerText();
  expect(chosen === second, `clicking "${second}" selected "${chosen}"`);
  expect(await select.inputValue() !== first, "clicking a junction did not change the forecast");
  await select.selectOption({ index: 0 });
  await page.waitForTimeout(800);
  expect(await page.locator("main canvas").count() >= 2, "the forecast chart vanished after choosing a junction");
  expect(/average of the same hour over the\s+last 14 days/.test(await mainText(page)), "the forecast does not say how it is made");
  await noBanner(page);
});

await check("app", "cameras: add sites, sweep, guide, map and every TEST button", async () => {
  await asRole(page, "admin");
  await open(page, "/cameras");
  await page.locator("tbody tr").first().waitFor({ timeout: 15000 });
  await mapControls(page);

  await page.getByRole("button", { name: "ADD SITES" }).click();
  await page.waitForFunction(() => /in the registry/.test(document.body.innerText), null, { timeout: 10000 })
    .catch(() => { throw new Error("ADD SITES gave no confirmation"); });
  await page.getByRole("button", { name: "HEALTH SWEEP" }).click();
  await page.waitForFunction(() => /Sweep complete/.test(document.body.innerText), null, { timeout: 15000 })
    .catch(() => { throw new Error("HEALTH SWEEP gave no confirmation"); });

  const tests = page.getByRole("button", { name: "TEST", exact: true });
  const count = await tests.count();
  expect(count === 20, `${count} TEST buttons, expected 20`);
  for (let i = 0; i < count; i++) {
    const rowLocator = page.locator("tbody tr").nth(i);
    await rowLocator.scrollIntoViewIfNeeded();
    await rowLocator.getByRole("button").click();
    await page.waitForFunction((n) => /not marked authorised|online|offline|unreachable/i.test(document.querySelectorAll("tbody tr")[n].innerText.replace(/unauthorized/g, "")), i, { timeout: 10000 })
      .catch(() => { throw new Error(`TEST on camera ${i + 1} showed no result`); });
  }
  const guide = page.getByRole("button", { name: /CONNECTING REAL CAMERAS/ });
  await guide.click();
  expect((await mainText(page)).includes("Authorisation."), "guide did not open");
  await guide.click();
  expect(!(await mainText(page)).includes("Authorisation."), "guide did not close");
  await noBanner(page);
});

await check("app", "dispatch: every incident with every service", async () => {
  await asRole(page, "admin");
  await open(page, "/dispatch");
  await mapReady(page);
  const select = page.locator("main select");
  const INCIDENTS = { "Sheikh Zayed Rd @ Interchange 2": [25.218, 55.279], "Al Garhoud Bridge": [25.245, 55.332],
    "Dubai Marina": [25.078, 55.14], "Abu Dhabi Corniche": [24.475, 54.34] };
  for (const incident of Object.keys(INCIDENTS)) {
    await page.getByRole("button", { name: incident }).click();
    for (const service of ["hospital", "fire", "police"]) {
      await select.selectOption(service);
      await page.waitForFunction(() => !/Routing…/.test(document.querySelector("main").innerText) && /DISPATCH →/.test(document.querySelector("main").innerText), null, { timeout: 15000 })
        .catch(() => { throw new Error(`${incident} / ${service}: no dispatch recommendation`); });
      const text = await mainText(page);
      const eta = text.match(/DISPATCH →\s*\n.*\n\s*([\d.]+)/)?.[1];
      expect(eta && Number(eta) > 0, `${incident} / ${service}: no arrival time (${eta})`);
      expect(/ranked by real drive time/.test(text), `${incident} / ${service}: not routed on the real network`);
      expect(await page.locator("main tbody tr").count() >= 1, `${incident} / ${service}: no candidates listed`);
      await noBanner(page);
    }
    await mapLooksAt(page, ...INCIDENTS[incident], 0.25, `incident "${incident}"`);
  }
  await mapControls(page);
  const layerNames = await page.locator(".leaflet-control-layers-overlays label").allTextContents();
  expect(!layerNames.some((n) => /Traffic/.test(n)), `the incident is listed as a map layer: ${layerNames.join(", ")}`);
});

await check("app", "complaints: file a report and see it listed", async () => {
  await asRole(page, "admin");
  await open(page, "/complaints");
  await page.locator("tbody tr").first().waitFor({ timeout: 15000 });
  const before = await page.locator("tbody tr").count();
  const text = `Traffic light broken at the school crossing ${Date.now()}`;
  await page.getByLabel("Describe the problem").fill(text);
  await page.getByRole("button", { name: /Submit report/i }).click();
  await page.locator('[role="status"]').filter({ hasText: "AI analysis result" }).waitFor({ timeout: 15000 });
  await page.waitForFunction((n) => document.querySelectorAll("tbody tr").length === n + 1, before, { timeout: 10000 })
    .catch(() => { throw new Error("the new report did not appear in the list"); });
  const first = await page.locator("tbody tr").first().innerText();
  expect(first.includes("traffic_signal"), `new report was not classified as a signal fault: ${first}`);
  expect(first.includes("traffic_signals"), "new report was not routed to the signals team");

  // The dashboard counts it and shows it in the live feed.
  await page.locator('#app-sidebar nav a').first().click();
  await heading(page, "Digital Twin");
  await page.waitForFunction((n) => new RegExp(`M8\\.4\\s*${n + 1}\\b`).test(document.querySelector("main").innerText), before, { timeout: 20000 })
    .catch(() => { throw new Error("the dashboard complaint count did not include the new report"); });
  await noBanner(page);
});

await check("app", "maintenance: priority queue", async () => {
  await asRole(page, "admin");
  await open(page, "/maintenance");
  await page.locator("tbody tr").first().waitFor({ timeout: 15000 });
  expect(await page.locator("tbody tr").count() >= 5, "queue is nearly empty");
  expect(/%/.test(await page.locator("tbody tr").first().innerText()), "rows hold no severity figures");
  await noBanner(page);
});

await check("app", "network: search, filters, imports, map detail and identify", async () => {
  await asRole(page, "admin");
  await open(page, "/network");
  await mapReady(page);
  const text = await mainText(page);
  expect(/170,8\d\d/.test(text) && /17,5\d\d/.test(text), "network figures are missing");
  const drawn = () => page.evaluate(() => document.querySelector("main").innerText.match(/([\d,]+) links · ([\d,]+) places drawn/)?.slice(1, 3));

  for (const [label, expectLinks] of [["Motorways", true], ["+ Trunk", true], ["+ Primary", true], ["All", true]]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await settle(page, 600);
    const [links] = await drawn();
    expect(expectLinks && Number(links.replace(/,/g, "")) > 0, `filter "${label}" drew ${links} links`);
    await noBanner(page);
  }
  const [crossBorder, placeNames] = [page.getByRole("checkbox").nth(0), page.getByRole("checkbox").nth(1)];
  await crossBorder.check();
  await settle(page, 600);
  await crossBorder.uncheck();
  await settle(page, 600);
  expect(Number((await drawn())[0].replace(/,/g, "")) > 0, "links did not return after clearing the cross-border filter");
  await placeNames.uncheck();
  expect((await drawn())[1] === "0", "place names did not switch off");
  await placeNames.check();
  expect(Number((await drawn())[1].replace(/,/g, "")) > 0, "place names did not switch back on");

  for (const emirate of ["Abu Dhabi", "Dubai", "Sharjah", "Ajman", "Umm Al Quwain", "Ras Al Khaimah", "Fujairah"]) {
    await page.locator("main button").filter({ hasText: new RegExp(`^${emirate}`) }).filter({ hasText: /places/ }).click();
    await page.waitForFunction((e) => [...document.querySelectorAll('[role="status"]')].some((n) => n.textContent.startsWith(e)), emirate, { timeout: 10000 })
      .catch(() => { throw new Error(`import button for ${emirate} gave no response`); });
  }
  await page.getByRole("button", { name: /RE-INGEST|INGEST NETWORK/ }).click();
  await page.waitForFunction(() => /up to date|Loaded/.test(document.body.innerText), null, { timeout: 15000 })
    .catch(() => { throw new Error("RE-INGEST gave no response"); });

  for (const [term, expected] of [["dubai mall", /The Dubai Mall/], ["sheikh zayed road", /Sheikh Zayed/], ["rashid hospital", /Rashid Hospital/]]) {
    await searchFor(page, term, expected);
  }
  await searchFor(page, "dubai mall", /The Dubai Mall/);
  await page.locator('[role="option"] button').filter({ hasText: "The Dubai Mall" }).first().click();
  await page.getByText("Located").waitFor({ timeout: 5000 });
  await page.waitForTimeout(700);
  expect(await page.locator('[role="option"]').count() === 0, "results reopened after choosing one");
  await page.waitForFunction(() => /\d+ streets in view/.test(document.querySelector(".leaflet-container").innerText), null, { timeout: 30000 })
    .catch(() => { throw new Error("street detail never loaded after flying to a place"); });
  const streets = Number((await page.locator(".leaflet-container").innerText()).match(/([\d,]+) streets in view/)[1].replace(/,/g, ""));
  expect(streets > 50, `only ${streets} streets drawn at street level`);

  await page.locator(".leaflet-container").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const map = await page.locator(".leaflet-container").boundingBox();
  await page.mouse.click(map.x + map.width * 0.4, map.y + map.height * 0.5, { button: "right" });
  await page.waitForFunction(() => {
    const t = document.querySelector(".leaflet-popup-content")?.innerText ?? "";
    return t && !/Identifying/.test(t);
  }, null, { timeout: 20000 }).catch(() => { throw new Error("right-click identify never answered"); });
  const popup = await page.locator(".leaflet-popup-content").innerText();
  expect(!/Couldn't reach/.test(popup), "right-click identify failed");
  expect(/\d+\.\d{5}, \d+\.\d{5}/.test(popup), `identify popup has no coordinates: ${popup}`);
  expect(/ m\b/.test(popup), `identify found nothing nearby in central Dubai: ${popup}`);
  expect((await mainText(page)).includes("Oman"), "international corridors list is missing");
  await noBanner(page);
});

await check("app", "infrastructure: register, filters and sources", async () => {
  await asRole(page, "admin");
  await open(page, "/infrastructure");
  await mapControls(page);
  await page.getByRole("button", { name: /LOAD REGISTER/ }).click();
  await page.waitForFunction(() => /register is current|Loaded \d+ project/.test(document.body.innerText), null, { timeout: 10000 })
    .catch(() => { throw new Error("LOAD REGISTER gave no confirmation"); });
  const cards = () => page.locator("main").getByRole("link", { name: /source/ }).count();
  const counts = {};
  for (const filter of ["all", "under construction", "completed", "planned"]) {
    await page.getByRole("button", { name: filter, exact: true }).click();
    await page.waitForTimeout(300);
    counts[filter] = await cards();
  }
  expect(counts.all === 8, `register shows ${counts.all} projects, expected 8`);
  expect(counts["under construction"] + counts.completed + counts.planned === counts.all,
    `filters do not add up: ${JSON.stringify(counts)}`);
  const kpi = await mainText(page);
  expect(new RegExp(`M11\\.2\\s*${counts["under construction"]}\\b`).test(kpi), "under-construction figure disagrees with the list");
  expect(new RegExp(`M11\\.3\\s*${counts.completed}\\b`).test(kpi), "completed figure disagrees with the list");
  const sources = await page.locator("main").getByRole("link", { name: /source/ }).evaluateAll((as) => as.map((a) => [a.href, a.target, a.rel]));
  for (const [href, target, rel] of sources) {
    expect(/^https:\/\//.test(href), `source link is not https: ${href}`);
    expect(target === "_blank" && /noopener/.test(rel), `source link does not open safely in a new tab: ${href}`);
  }
  await noBanner(page);
});

await check("app", "route design: studied corridors, lanes, custom corridor and validation", async () => {
  await asRole(page, "admin");
  await open(page, "/route-design");
  const presets = ["Bur Dubai → Dubai Islands", "Abu Dhabi CBD → Al Reem Island",
    "Dubai Silicon Oasis → Sharjah University City", "Dubai → Hatta (Oman border)"];
  const TITLES = ["Bur Dubai → Dubai Islands", "Abu Dhabi CBD → Al Reem Island",
    "Dubai Silicon Oasis → Sharjah University City", "Dubai → Hatta / Al Wajajah crossing"];
  const MIDPOINTS = [[25.278, 55.3065], [24.4945, 54.386], [25.2055, 55.435], [24.9974, 55.7054]];
  // The result names its corridor; that is how to tell a new answer from the last one.
  const assessed = (title) => page.waitForFunction(
    (t) => [...document.querySelectorAll('main section[aria-busy="false"] .font-display')].some((d) => d.textContent.trim() === t),
    title, { timeout: 90000 });
  for (const [i, name] of presets.entries()) {
    await page.getByRole("button", { name }).click();
    await assessed(TITLES[i]).catch(() => { throw new Error(`"${name}" produced no assessment`); });
    await settle(page, 500);
    await mapReady(page);
    await mapLooksAt(page, ...MIDPOINTS[i], i === 3 ? 0.45 : 0.25, `corridor "${name}"`);
    const text = await mainText(page);
    expect(/(Hold|Advance|Shortlist|Do not pursue)/.test(text), `"${name}" has no recommendation`);
    expect(/Capacity\s*\n?\s*10,800 v\/h/.test(text), `"${name}" capacity is not 6 lanes x 1,800`);
    await noBanner(page);
  }
  await mapControls(page);

  const lanes = page.getByLabel("LANES");
  await lanes.fill("12");
  await page.getByRole("button", { name: presets[2] }).click();
  await page.waitForFunction(() => /21,600 v\/h/.test(document.querySelector("main").innerText), null, { timeout: 15000 })
    .catch(() => { throw new Error("changing lanes to 12 did not change the capacity"); });
  await lanes.fill("2");
  await page.getByRole("button", { name: presets[2] }).click();
  await page.waitForFunction(() => /3,600 v\/h/.test(document.querySelector("main").innerText), null, { timeout: 15000 })
    .catch(() => { throw new Error("changing lanes to 2 did not change the capacity"); });
  await lanes.fill("");
  await lanes.pressSequentially("8");
  expect(await lanes.inputValue() === "8", `typing 8 into an emptied lanes box gave "${await lanes.inputValue()}"`);
  for (const bad of ["20", "1", "2.5"]) {
    await lanes.fill(bad);
    await page.getByRole("button", { name: presets[2] }).click();
    await page.waitForTimeout(400);
    expect((await banners(page)).some((b) => /whole number from 2 to 12/.test(b)), `lanes "${bad}" was not rejected`);
  }
  await lanes.fill("6");

  const fill = async (values) => {
    for (const [placeholder, value] of Object.entries(values)) await page.getByPlaceholder(placeholder).fill(value);
  };
  const analyse = page.getByRole("button", { name: "ANALYSE CORRIDOR" });

  await fill({ "Origin name": "A", "Origin lat": "abc", "Origin lon": "55.38", "Dest name": "B", "Dest lat": "25.29", "Dest lon": "55.49" });
  await analyse.click();
  await page.waitForTimeout(400);
  expect((await banners(page)).some((b) => /must be numbers/.test(b)), "non-numeric coordinates were not rejected");

  await fill({ "Origin lat": "95" });
  await analyse.click();
  await page.waitForTimeout(400);
  expect((await banners(page)).some((b) => /Latitude must be between/.test(b)), "an out-of-range latitude was not rejected");

  await fill({ "Origin lat": "25.29", "Origin lon": "55.49" });
  await analyse.click();
  await page.waitForFunction(() => [...document.querySelectorAll('[role="alert"]')].some((a) => /same point/.test(a.textContent)), null, { timeout: 10000 })
    .catch(() => { throw new Error("identical origin and destination were not rejected"); });

  // A corridor the API was never asked about: worked out in the browser.
  await fill({ "Origin name": "Jumeirah", "Origin lat": "25.2048", "Origin lon": "55.2400",
    "Dest name": "Al Ain", "Dest lat": "24.2075", "Dest lon": "55.7447" });
  await analyse.click();
  await assessed("Jumeirah → Al Ain").catch(() => { throw new Error("the custom corridor was never assessed"); });
  const custom = await mainText(page);
  const km = Number(custom.match(/Network Distance\s*\n?\s*([\d.]+) km/)?.[1]);
  const straight = Number(custom.match(/Straight Line\s*\n?\s*([\d.]+) km/)?.[1]);
  expect(straight > 110 && straight < 130, `straight-line distance Dubai–Al Ain is ${straight} km`);
  expect(km > straight && km < straight * 1.8, `routed distance ${km} km is implausible for ${straight} km straight`);
  await noBanner(page);
});

await check("app", "planner: suggestions, typed questions and edge cases", async () => {
  await asRole(page, "admin");
  await open(page, "/planner");
  for (const suggestion of ["Show the busiest junctions", "Which roads should be widened?", "What needs maintenance most urgently?"]) {
    await page.getByRole("button", { name: suggestion }).click();
    await page.waitForFunction((s) => document.querySelector("main").innerText.includes(`> ${s}`), suggestion, { timeout: 10000 });
    const text = await mainText(page);
    const answer = text.split(`> ${suggestion}`).pop();
    expect(/Based on current city data/.test(answer), `"${suggestion}" was answered with: ${answer.slice(0, 120)}`);
    expect(/Grounded in \d+ live data point/.test(answer), `"${suggestion}" cites no sources`);
  }
  const box = page.getByPlaceholder(/Ask about congestion/);
  const turns = () => page.locator("main").getByText(/^> /).count();

  let before = await turns();
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.waitForTimeout(400);
  expect(await turns() === before, "an empty question was submitted");

  await box.fill("Where is traffic congestion worst?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.waitForFunction((n) => [...document.querySelectorAll("main div")].filter((d) => /^> /.test(d.textContent) && d.children.length === 0).length > n, before, { timeout: 10000 })
    .catch(() => { throw new Error("the Ask button did not submit a typed question"); });
  expect(await box.inputValue() === "", "the question box was not cleared");
  expect(/congestion score/.test((await mainText(page)).split("Where is traffic congestion worst?").pop()), "a congestion question got no congestion answer");

  before = await turns();
  await box.fill("Which potholes need repair?");
  await box.press("Enter");
  await page.waitForFunction((n) => [...document.querySelectorAll("main div")].filter((d) => /^> /.test(d.textContent) && d.children.length === 0).length > n, before, { timeout: 10000 })
    .catch(() => { throw new Error("Enter did not submit a typed question"); });
  expect(/pothole/.test((await mainText(page)).split("Which potholes need repair?").pop()), "a maintenance question got no maintenance answer");

  await box.fill("What is the weather tomorrow?");
  await box.press("Enter");
  await page.waitForFunction(() => /don't have enough current data/.test(document.querySelector("main").innerText), null, { timeout: 10000 })
    .catch(() => { throw new Error("an unanswerable question did not get the fallback reply"); });
  await noBanner(page);
});

await check("app", "analytics: figures and every time range", async () => {
  await asRole(page, "admin");
  await open(page, "/analytics");
  for (const range of ["7D", "3D", "24H"]) {
    await page.getByRole("button", { name: range, exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("main canvas").length >= 2 && !/No history yet/.test(document.querySelector("main").innerText), null, { timeout: 30000 })
      .catch(() => { throw new Error(`the ${range} range shows no congestion trend`); });
    await noBanner(page);
  }
  const text = await mainText(page);
  expect(!/—\s*(\/100|%|km\/h)/.test(text), "a KPI is still showing a placeholder");
});

await check("app", "brand link and sign-out", async () => {
  await asRole(page, "admin");
  await open(page, "/analytics");
  await page.locator("#app-sidebar a").first().click();
  await heading(page, PUBLIC_PAGES["/welcome"]);
  await open(page, "/traffic");
  await heading(page, "Smart Traffic Analysis");
  await page.getByRole("button", { name: "SIGN OUT" }).click();
  await heading(page, PUBLIC_PAGES["/welcome"]);
  await page.goto(url("/traffic"), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => location.pathname.endsWith("/welcome"), null, { timeout: 15000 })
    .catch(() => { throw new Error("the console is still open after signing out"); });
});

await check("app", "leaving a map mid-zoom", async () => {
  await asRole(page, "admin");
  await open(page, "/");
  await mapReady(page);
  for (const next of ["/cameras", "/network", "/dispatch", "/"]) {
    await page.locator(".leaflet-control-zoom-in").first().click();
    await page.waitForTimeout(60);
    await page.locator(`#app-sidebar nav a[href="${hrefOf(next)}"]`).click();
    await heading(page, CONSOLE_PAGES[next]);
    await mapReady(page);
  }
  await page.waitForTimeout(800);
});

/* ============================================================== PHONE */

const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mobile = await phone.newPage();
watch(mobile);

for (const path of Object.keys(PUBLIC_PAGES)) {
  await check("phone", `website ${path} fits the screen`, async () => {
    await open(mobile, path);
    await heading(mobile, PUBLIC_PAGES[path]);
    await noSidewaysScroll(mobile);
    if (path !== "/login") {
      const nav = mobile.locator("header");
      const box = await nav.boundingBox();
      expect(box.width <= 391, `header is ${box.width}px wide on a 390px screen`);
      for (const label of ["Report an Issue", "About", "FAQ", "SIGN IN"]) {
        const reachable = await mobile.locator("header").getByRole("link", { name: label, exact: true }).first().isVisible().catch(() => false)
          || await mobile.locator("header").getByRole("button", { name: /menu/i }).isVisible().catch(() => false);
        expect(reachable, `"${label}" cannot be reached from the header on a phone`);
      }
    }
  });
}

await check("phone", "website menu reaches every page", async () => {
  for (const [label, title] of [["Report an Issue", "Report a problem"], ["About", "About the platform"], ["FAQ", "Frequently asked questions"], ["SIGN IN", "Sign in"]]) {
    await open(mobile, "/welcome");
    const toggle = mobile.locator("header").getByRole("button", { name: /menu/i });
    if (await toggle.isVisible().catch(() => false)) await toggle.click();
    const link = mobile.locator("header").getByRole("link", { name: label, exact: true }).first();
    await link.click();
    await heading(mobile, title);
  }
});

await check("phone", "website menu closes on Escape and on tapping the current page", async () => {
  await open(mobile, "/about");
  const toggle = mobile.locator("header").getByRole("button", { name: /menu/i });
  await toggle.click();
  expect(await mobile.locator("#public-menu").isVisible(), "the menu did not open");
  await mobile.keyboard.press("Escape");
  await mobile.waitForTimeout(200);
  expect(await mobile.locator("#public-menu").count() === 0, "Escape did not close the menu");
  await toggle.click();
  await mobile.locator("#public-menu").getByRole("link", { name: "About", exact: true }).click();
  await mobile.waitForTimeout(300);
  expect(await mobile.locator("#public-menu").count() === 0, "the menu stayed open after tapping the current page");
});

await check("phone", "console menu drawer", async () => {
  await asRole(mobile, "admin");
  await open(mobile, "/");
  await heading(mobile, "Digital Twin");
  const toggle = mobile.getByRole("button", { name: "Open menu" });
  await toggle.click();
  const drawer = mobile.locator("#app-sidebar");
  await mobile.waitForTimeout(400);
  expect((await drawer.boundingBox()).x >= 0, "the drawer did not slide in");
  expect(await drawer.evaluate((el) => getComputedStyle(el).visibility) === "visible", "the open drawer is not visible");
  await mobile.keyboard.press("Escape");
  await mobile.waitForTimeout(400);
  expect((await drawer.boundingBox()).x < 0, "Escape did not close the drawer");
  expect(await drawer.evaluate((el) => getComputedStyle(el).visibility) === "hidden",
    "the closed drawer's links can still be reached with Tab");

  await mobile.getByRole("button", { name: "Open menu" }).click();
  await mobile.waitForTimeout(400);
  await mobile.mouse.click(370, 400);
  await mobile.waitForTimeout(400);
  expect((await drawer.boundingBox()).x < 0, "tapping outside did not close the drawer");

  for (const path of ["/traffic", "/network", "/analytics"]) {
    await mobile.getByRole("button", { name: "Open menu" }).click();
    await mobile.waitForTimeout(350);
    await mobile.locator(`#app-sidebar nav a[href="${hrefOf(path)}"]`).click();
    await heading(mobile, CONSOLE_PAGES[path]);
    await mobile.waitForTimeout(400);
    expect((await drawer.boundingBox()).x < 0, `the drawer stayed open after going to ${path}`);
  }
});

for (const path of Object.keys(CONSOLE_PAGES)) {
  await check("phone", `console ${path} fits the screen`, async () => {
    await asRole(mobile, "admin");
    await open(mobile, path);
    await heading(mobile, CONSOLE_PAGES[path]);
    await settle(mobile, 600);
    await noBanner(mobile);
    await noSidewaysScroll(mobile);
  });
}

/* ============================================================== LINKS */

await check("links", "every internal link resolves", async () => {
  const seen = new Set();
  await asRole(page, "admin");
  for (const path of [...Object.keys(PUBLIC_PAGES), ...Object.keys(CONSOLE_PAGES)]) {
    await open(page, path);
    for (const href of await page.locator("a[href]").evaluateAll((as) => as.map((a) => a.href))) {
      if (href.startsWith(ORIGIN)) seen.add(href.split("#")[0]);
    }
  }
  const bad = [];
  for (const href of seen) {
    const res = await context.request.get(href, { maxRedirects: 5 });
    if (res.status() >= 400) bad.push(`${res.status()} ${href}`);
  }
  expect(bad.length === 0, `dead internal links: ${bad.join(", ")}`);
  expect(seen.size >= 15, `only ${seen.size} internal links found`);
});

/* ------------------------------------------------------------- report */

await browser.close();

const failed = results.filter((r) => !r.ok);
const byArea = {};
for (const r of results) {
  const area = r.label.split(" › ")[0];
  byArea[area] ??= { passed: 0, failed: 0 };
  byArea[area][r.ok ? "passed" : "failed"]++;
}
console.log("\n" + "-".repeat(64));
for (const [area, n] of Object.entries(byArea)) console.log(`${area.padEnd(10)} ${String(n.passed).padStart(3)} passed  ${String(n.failed).padStart(3)} failed`);
console.log(`${"total".padEnd(10)} ${String(results.length - failed.length).padStart(3)} passed  ${String(failed.length).padStart(3)} failed`);
if (external.size) {
  console.log(`\nthird-party requests that failed (not counted): ${[...external].map(([h, n]) => `${h} x${n}`).join(", ")}`);
}
if (process.env.E2E_REPORT) writeFileSync(process.env.E2E_REPORT, JSON.stringify({ base: BASE, results, external: [...external] }, null, 2));
process.exit(failed.length ? 1 : 0);
