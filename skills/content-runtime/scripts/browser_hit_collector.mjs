#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const PLATFORMS = new Set(["wechat", "xhs"]);

const START_URLS = {
  wechat: (keyword) => `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(keyword || "")}`,
  xhs: (keyword) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword || "")}`,
};

const PLATFORM_HINTS = {
  wechat: "公众号：可用搜狗微信搜索公开文章，或手动打开 mp.weixin.qq.com / 文章页后按回车采集可见内容。",
  xhs: "小红书：请手动登录并停在搜索结果页、账号主页或笔记详情页。",
};

const SELECTOR_PROFILES = {
  wechat: {
    version: "wechat-visible-v1",
    selectors: [".news-box li", ".txt-box", "li", "article", "section", "a[href*='mp.weixin.qq.com']"],
    urlPattern: /(mp\.weixin\.qq\.com|weixin\.sogou\.com)/i,
    notes: "搜狗微信公开搜索、公众号文章页和可见列表。",
  },
  xhs: {
    version: "xhs-visible-v1",
    selectors: ["section", "article", "[class*='note']", "[class*='card']", "[class*='feed']", "a[href*='/explore/']"],
    urlPattern: /(xiaohongshu\.com|xhslink\.com)/i,
    notes: "小红书搜索结果、账号主页和笔记详情可见卡片。",
  },
};

function printHelp() {
  console.log(`AIFIOS browser hit collector

Usage:
  node browser_hit_collector.mjs --project ~/ai-content-system --platform xhs --keyword "个人 IP"

Options:
  --project <path>       AIFIOS project root, required
  --platform <name>      wechat | xhs, required
  --keyword <text>       Search keyword and hit-library keyword
  --url <url>            Open a specific URL instead of the platform default
  --profile <path>       Persistent browser profile directory
  --limit <n>            Max imported samples, default 30
  --max-scrolls <n>      Scroll rounds before extraction finishes, default 3
  --queue               Save recognized samples to pending queue instead of importing
  --no-wait             Do not wait for manual login/search before collecting
  --headless            Run headless, not recommended for login-state collection
  --diagnostics         Always save screenshot/html/trace diagnostics
  --help                Show this help

Install dependency:
  make browser-hit-install
`);
}

function parseArgs(argv) {
  const args = {
    limit: 30,
    maxScrolls: 3,
    wait: true,
    headless: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--help" || item === "-h") {
      args.help = true;
    } else if (item === "--no-wait") {
      args.wait = false;
    } else if (item === "--headless") {
      args.headless = true;
    } else if (item === "--queue") {
      args.queue = true;
    } else if (item === "--diagnostics") {
      args.diagnostics = true;
    } else if (item.startsWith("--")) {
      const key = item.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`Missing value for ${item}`);
      }
      args[key] = next;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${item}`);
    }
  }
  return args;
}

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function runtimePythonBinary() {
  const configured = String(process.env.AIFIOS_DESKTOP_PYTHON_BINARY || process.env.AIFIOS_PYTHON || "").trim();
  if (process.env.AIFIOS_DESKTOP === "1") {
    if (!configured || !path.isAbsolute(configured)) {
      throw new Error("AIFIOS desktop runtime is missing its bundled Python interpreter.");
    }
    return configured;
  }
  return configured && path.isAbsolute(configured) ? configured : "python3";
}

function packagedChromiumPath() {
  const configured = String(process.env.AIFIOS_PLAYWRIGHT_CHROMIUM_PATH || "").trim();
  if (process.env.AIFIOS_DESKTOP === "1" && !configured) {
    throw new Error("AIFIOS desktop runtime is missing its bundled Chromium executable.");
  }
  if (configured && !fs.existsSync(configured)) {
    throw new Error(`Configured AIFIOS Chromium executable is missing: ${configured}`);
  }
  return configured;
}

function loadPlaywright() {
  try {
    const require = createRequire(new URL("../../xhs-card/package.json", import.meta.url));
    return require("playwright");
  } catch (error) {
    console.error(JSON.stringify({
      error: "Playwright dependency is not installed.",
      resolution: "Run `make browser-hit-install` from AIFI-OS root, then retry.",
      detail: error.message,
    }, null, 2));
    process.exit(1);
  }
}

function isBrowserRuntimeUnavailable(error) {
  const message = String(error?.message || error || "");
  return (
    message.includes("Playwright dependency is not installed") ||
    message.includes("launchPersistentContext") ||
    message.includes("browserType.launch") ||
    message.includes("MachPortRendezvous") ||
    message.includes("Permission denied") ||
    message.includes("Operation not permitted") ||
    message.includes("listen EPERM")
  );
}

function buildStartUrl(platform, keyword, url) {
  if (url) return url;
  return START_URLS[platform](keyword || "");
}

async function waitForUser(platform) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("");
  console.log(PLATFORM_HINTS[platform]);
  console.log("请在打开的浏览器里完成登录、搜索、筛选或打开目标页面。准备采集当前可见页面后，回到终端按 Enter。");
  await rl.question("Press Enter to collect visible samples...");
  rl.close();
}

async function collectFromPage(page, platform, keyword, limit, selectorProfile) {
  return page.evaluate(({ platform, keyword, limit, selectorProfile }) => {
    const metricNames = {
      reads: ["阅读", "阅读量", "reads"],
      likes: ["点赞", "赞", "likes", "like"],
      collects: ["收藏", "collects", "收藏量"],
      comments: ["评论", "留言", "comments"],
      shares: ["分享", "转发", "shares"],
      wows: ["在看", "wows"],
      recommends: ["推荐", "recommends"],
    };

    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 40 && rect.height > 20 && style.display !== "none" && style.visibility !== "hidden";
    }

    function clean(text) {
      return String(text || "")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    function safeDecode(value) {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }

    function pageState() {
      const url = location.href;
      const decodedUrl = safeDecode(url);
      const title = document.title || "";
      const body = clean(document.body.innerText || "");
      const head = `${url}\n${decodedUrl}\n${title}\n${body.slice(0, 1200)}`;
      if (/antispider|verify|captcha|验证码|验证中|安全验证|环境异常|访问过于频繁/.test(head)) {
        return { status: "blocked", reason: "页面需要验证码或触发反自动化验证" };
      }
      if (/login|passport|sso/.test(decodedUrl) && /登录|扫码|sign\s*in|login/i.test(head)) {
        return { status: "needs_login", reason: "页面需要登录后采集" };
      }
      if (/扫码登录|请登录|登录后查看|登录后可见|未登录/.test(head)) {
        return { status: "needs_login", reason: "页面需要登录后采集" };
      }
      if (platform === "xhs" && /沪ICP备|行吟信息科技|创作中心|业务合作/.test(body) && !/点赞|收藏|评论/.test(body)) {
        return { status: "empty_or_needs_login", reason: "小红书页面未加载出笔记列表，可能需要登录或手动搜索" };
      }
      return { status: "ok", reason: "" };
    }

    function compactLines(text) {
      return clean(text)
        .split(/\n+/)
        .map((line) => clean(line))
        .filter(Boolean);
    }

    function firstMeaningfulLine(lines) {
      return lines.find((line) => {
        if (line.length < 4 || line.length > 80) return false;
        if (/^(赞|评论|收藏|分享|转发|关注|已关注|登录|打开|搜索)$/.test(line)) return false;
        if (/^\d+(\.\d+)?[wW万kK]?$/.test(line)) return false;
        return true;
      }) || "";
    }

    function escapeRegExp(value) {
      return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function metricRegexAfter(label) {
      return new RegExp(`${escapeRegExp(label)}\\s*[:：]?\\s*([0-9]+(?:\\.[0-9]+)?\\s*(?:万|w|W|k|K)?)`, "i");
    }

    function metricRegexBefore(label) {
      return new RegExp(`([0-9]+(?:\\.[0-9]+)?\\s*(?:万|w|W|k|K)?)\\s*${escapeRegExp(label)}`, "i");
    }

    function parseMetrics(text) {
      const metrics = {};
      for (const [field, labels] of Object.entries(metricNames)) {
        for (const label of labels) {
          const matched = text.match(metricRegexAfter(label)) || text.match(metricRegexBefore(label));
          if (matched) {
            metrics[field] = matched[1].replace(/\s+/g, "");
            break;
          }
        }
      }
      return metrics;
    }

    function isPlatformUrl(value) {
      try {
        return Boolean(value && new RegExp(selectorProfile.urlPattern, "i").test(value));
      } catch {
        return Boolean(value);
      }
    }

    function hasSampleSignal(text, url, metrics) {
      if (Object.keys(metrics).length > 0) return true;
      if (isPlatformUrl(url) || isPlatformUrl(location.href)) return true;
      return /作者|账号|博主|公众号|点赞|收藏|评论|留言|阅读|在看|分享|转发|推荐|封面|开头|钩子/.test(text);
    }

    function nearestUrl(el) {
      const link = el.matches("a") ? el : el.querySelector("a[href]");
      if (!link) return "";
      try {
        return new URL(link.getAttribute("href"), location.href).toString();
      } catch {
        return link.getAttribute("href") || "";
      }
    }

    function authorFromLines(lines) {
      const byLine = lines.find((line) => /^(@|作者|账号|公众号|博主)/.test(line));
      if (byLine) return byLine.replace(/^(作者|账号|公众号|博主)[:：]?/, "").trim();
      return "";
    }

    function sampleFromElement(el) {
      const text = clean(el.innerText || el.textContent || "");
      if (text.length < 8) return null;
      if (isNoiseText(text)) return null;
      const lines = compactLines(text);
      const title = firstMeaningfulLine(lines);
      if (!title) return null;
      if (isNoiseTitle(title)) return null;
      const metrics = parseMetrics(text);
      const url = nearestUrl(el) || location.href;
      if (!hasSampleSignal(text, url, metrics)) return null;
      const author = authorFromLines(lines);
      const hook = lines.find((line) => line !== title && line.length >= 6 && line.length <= 120) || "";
      const coverText = platform === "xhs" ? lines.slice(0, 3).join(" / ") : "";
      return {
        platform,
        title,
        url,
        author,
        keyword: keyword || "",
        cover_text: coverText,
        hook,
        summary: lines.slice(0, 8).join("\n"),
        metrics,
        source_type: "browser-visible",
      };
    }

    function isNoiseText(text) {
      return /验证码|VerifyCode|返回首页|沪ICP备|营业执照|行吟信息科技|违法不良信息举报|多人运营|内容管理|互动管理|扫码登录|请登录/.test(text);
    }

    function isNoiseTitle(title) {
      return /返回首页|验证码|登录|创作中心|业务合作|多人运营|内容管理|互动管理|关于我们|全部|图文|用户/.test(title);
    }

    const state = pageState();
    if (state.status !== "ok") {
      return { state, samples: [] };
    }

    const nodes = [];
    for (const selector of selectorProfile.selectors || ["article", "section", "a"]) {
      document.querySelectorAll(selector).forEach((el) => {
        if (visible(el)) nodes.push(el);
      });
    }

    if (nodes.length === 0) {
      nodes.push(document.body);
    }

    const seen = new Set();
    const samples = [];
    for (const node of nodes) {
      const sample = sampleFromElement(node);
      if (!sample) continue;
      const key = `${sample.platform}|${sample.url}|${sample.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      samples.push(sample);
      if (samples.length >= limit) break;
    }

    if (samples.length === 0 && document.title) {
      const fallbackText = clean(document.body.innerText || "");
      const fallbackMetrics = parseMetrics(fallbackText);
      if (!isNoiseText(fallbackText) && hasSampleSignal(fallbackText, location.href, fallbackMetrics)) {
        samples.push({
        platform,
        title: document.title,
        url: location.href,
        keyword: keyword || "",
        summary: fallbackText.slice(0, 1200),
        metrics: fallbackMetrics,
        source_type: "browser-visible",
        });
      }
    }

    return {
      state,
      samples: samples.slice(0, limit),
      selector_profile: {
        platform,
        version: selectorProfile.version,
        selectors: selectorProfile.selectors,
        notes: selectorProfile.notes,
      },
    };
  }, { platform, keyword, limit, selectorProfile });
}

function dedupeSamples(samples, limit) {
  const seen = new Set();
  const result = [];
  for (const sample of samples) {
    const key = `${sample.platform}|${sample.url || ""}|${sample.title || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(sample);
    if (result.length >= limit) break;
  }
  return result;
}

function safeName(value) {
  return String(value || "unknown")
    .replace(/[^0-9A-Za-z._\-\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "unknown";
}

function textPreview(text, limit = 3000) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, limit);
}

async function saveDiagnostics({ page, context, project, args, status, reason, samples, capturePath, selectorProfile, error }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.join(project, "materials", "hit-library", "diagnostics", `${stamp}-${safeName(args.platform)}-${safeName(status)}`);
  fs.mkdirSync(root, { recursive: true });
  const summary = {
    status,
    reason: reason || "",
    error: error ? String(error.message || error) : "",
    platform: args.platform,
    keyword: args.keyword || "",
    queue_mode: Boolean(args.queue),
    url: "",
    title: "",
    captured_at: new Date().toISOString(),
    sample_count: samples?.length || 0,
    capture_file: capturePath || "",
    selector_profile: selectorProfile || {},
    files: {},
  };
  try {
    summary.url = page.url();
  } catch {}
  try {
    summary.title = await page.title();
  } catch {}
  try {
    const screenshot = path.join(root, "screenshot.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    summary.files.screenshot = screenshot;
  } catch (screenshotError) {
    summary.files.screenshot_error = screenshotError.message;
  }
  try {
    const html = path.join(root, "page.html");
    fs.writeFileSync(html, await page.content(), "utf8");
    summary.files.html = html;
  } catch (htmlError) {
    summary.files.html_error = htmlError.message;
  }
  try {
    const bodyText = path.join(root, "body-preview.txt");
    const body = await page.evaluate(() => document.body?.innerText || "");
    fs.writeFileSync(bodyText, textPreview(body, 6000), "utf8");
    summary.files.body_preview = bodyText;
  } catch (bodyError) {
    summary.files.body_preview_error = bodyError.message;
  }
  if (context) {
    try {
      const trace = path.join(root, "trace.zip");
      await context.tracing.stop({ path: trace });
      summary.files.trace = trace;
      summary.trace_stopped = true;
    } catch (traceError) {
      summary.files.trace_error = traceError.message;
    }
  }
  const summaryPath = path.join(root, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  return { dir: root, summary: summaryPath, summaryData: summary };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    printHelp();
    process.exit(2);
  }
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.project || !args.platform) {
    printHelp();
    process.exit(2);
  }
  if (!PLATFORMS.has(args.platform)) {
    throw new Error(`Unsupported platform: ${args.platform}`);
  }

  const project = path.resolve(expandHome(args.project));
  const selectorProfile = SELECTOR_PROFILES[args.platform];
  const profile = path.resolve(expandHome(args.profile || path.join(project, "sessions", "browser-profiles", args.platform)));
  fs.mkdirSync(profile, { recursive: true });

  const { chromium } = loadPlaywright();
  const executablePath = packagedChromiumPath();
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: Boolean(args.headless),
      viewport: { width: 1440, height: 1000 },
      ...(executablePath ? { executablePath } : {}),
    });
  } catch (error) {
    if (isBrowserRuntimeUnavailable(error)) {
      console.log(JSON.stringify({
        status: "skipped",
        reason: "当前环境无法启动浏览器运行时，浏览器采集能力已跳过。",
        resolution: "在允许启动 Chromium/Playwright 的本机环境运行，或执行 `make browser-hit-install` 后重试。",
        detail: String(error?.message || error).slice(0, 1200),
        platform: args.platform,
        keyword: args.keyword || "",
        selector_profile: {
          platform: args.platform,
          version: selectorProfile.version,
          selectors: selectorProfile.selectors,
          notes: selectorProfile.notes,
        },
      }, null, 2));
      return;
    }
    throw error;
  }
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false }).catch(() => {});
  const page = context.pages()[0] || await context.newPage();
  const targetUrl = buildStartUrl(args.platform, args.keyword, args.url);
  if (targetUrl) {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  }

  if (args.wait && !args.headless) {
    await waitForUser(args.platform);
  }

  const allSamples = [];
  let lastState = { status: "ok", reason: "" };
  const maxScrolls = Number(args.maxScrolls || 0);
  const limit = Number(args.limit || 30);
  for (let i = 0; i <= maxScrolls; i += 1) {
    const collected = await collectFromPage(page, args.platform, args.keyword || "", limit, {
      version: selectorProfile.version,
      selectors: selectorProfile.selectors,
      urlPattern: selectorProfile.urlPattern.source,
      notes: selectorProfile.notes,
    });
    lastState = collected.state || lastState;
    allSamples.push(...(collected.samples || []));
    if (lastState.status !== "ok") {
      break;
    }
    if (i < maxScrolls) {
      await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 0.9, 700)));
      await page.waitForTimeout(1200);
    }
  }

  const samples = dedupeSamples(allSamples, limit);
  const currentUrl = page.url();
  const captureDir = path.join(project, "materials", "hit-library", "browser-captures");
  fs.mkdirSync(captureDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const capturePath = path.join(captureDir, `${stamp}-${args.platform}.json`);
  const capturePayload = {
    selector_profile: {
      platform: args.platform,
      version: selectorProfile.version,
      selectors: selectorProfile.selectors,
      notes: selectorProfile.notes,
    },
    samples,
  };
  fs.writeFileSync(capturePath, JSON.stringify(capturePayload, null, 2), "utf8");

  const hitCollector = fileURLToPath(new URL("./hit_collector.py", import.meta.url));
  let importResult = null;
  if (samples.length > 0) {
    const command = args.queue ? "queue" : "import";
    const result = spawnSync(runtimePythonBinary(), [
      hitCollector,
      "--project", project,
      command,
      "--platform", args.platform,
      "--file", capturePath,
      "--format", "json",
      "--keyword", args.keyword || "",
      "--source-type", "browser-visible",
    ], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || "hit_collector import failed");
    }
    importResult = JSON.parse(result.stdout);
  }

  const finalStatus = lastState.status !== "ok" ? lastState.status : (samples.length ? "collected" : "no_samples");
  let diagnostics = null;
  if (args.diagnostics || finalStatus !== "collected") {
    diagnostics = await saveDiagnostics({
      page,
      context,
      project,
      args,
      status: finalStatus,
      reason: lastState.reason || "",
      samples,
      capturePath,
      selectorProfile: capturePayload.selector_profile,
    });
  } else {
    await context.tracing.stop().catch(() => {});
  }

  await context.close();
  console.log(JSON.stringify({
    status: finalStatus,
    reason: lastState.reason || "",
    platform: args.platform,
    keyword: args.keyword || "",
    current_url: currentUrl,
    capture_file: capturePath,
    diagnostics_dir: diagnostics?.dir || "",
    diagnostics_summary: diagnostics?.summary || "",
    count: samples.length,
    queue_mode: Boolean(args.queue),
    selector_profile: capturePayload.selector_profile,
    import_result: importResult,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }, null, 2));
  process.exit(1);
});
