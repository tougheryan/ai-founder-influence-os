#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const PERFORMANCE_COLLECTOR = path.join(SCRIPT_DIR, "performance_collector.py");
const DEFAULT_START_URL = "https://mp.weixin.qq.com/";
const DEFAULT_AUTO_TIMEOUT_MS = 180000;
const DEFAULT_MAX_ARTICLES = 50;
const DEFAULT_MAX_PAGES = 5;
const STATS_LINK_LABELS = ["查看数据", "数据详情", "数据", "图文数据", "统计", "图文统计", "分析", "详情"];
const CONTENT_NAV_LABELS = ["内容管理", "内容与互动", "发表记录", "已发表", "图文消息", "群发记录"];
const PUBLISHED_NAV_LABELS = ["已发表", "发表记录", "群发记录", "图文消息"];
const SENSITIVE_FIELD_RE = /(?:access_?token|token|secret|cookie|authorization|openid|unionid|nickname|headimgurl|phone|mobile|email|user_?id)$/i;
const SENSITIVE_TEXT_RE = /(?:\+?86[-\s]?)?1[3-9]\d{9}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|微信(?:号)?[:：]?\s*[A-Za-z0-9_-]{5,}|weixin[:：]?\s*[A-Za-z0-9_-]{5,}|wx[:：]?\s*[A-Za-z0-9_-]{5,}/gi;
const SENSITIVE_QUERY_KEYS = /^(?:access_?token|token|secret|cookie|authorization|session|sid|ticket|key|signature)$/i;

function printHelp() {
  console.log(`AIFIOS WeChat MP browser performance collector

Usage:
  node skills/content-runtime/scripts/wechat_mp_browser_collector.mjs \\
    --project ~/ai-content-system \\
    --slug article-slug

Options:
  --project <path>       AIFIOS project root, required
  --slug <text>          Article slug, required
  --title <text>         Optional fallback title
  --publish-url <url>    Optional fallback publish URL
  --published-at <date>  Optional fallback publish time/date
  --url <url>            Browser start URL, default https://mp.weixin.qq.com/
  --profile <path>       Persistent Chromium profile directory
  --fixture <path>       Local HTML fixture for tests; does not launch browser
  --auto-after-login     User only logs in; collector auto-opens target stats page
  --all-published        Batch collect all visible published articles after login
  --capture-content      Open each public article URL and capture body text + analysis
  --max-articles <n>     Batch limit, default ${DEFAULT_MAX_ARTICLES}
  --max-pages <n>        Batch list pages to traverse, default ${DEFAULT_MAX_PAGES}
  --auto-timeout-ms <n>  Auto login/navigation timeout, default ${DEFAULT_AUTO_TIMEOUT_MS}
  --no-wait              Do not wait for manual login/navigation
  --headless             Run headless; not recommended for real login collection
  --help                 Show this help

This command only整理用户已登录后台当前可见页面，不绕过登录、不破解接口、不规避微信权限。
`);
}

function parseArgs(argv) {
  const args = {
    wait: true,
    headless: false,
    url: DEFAULT_START_URL,
    autoTimeoutMs: DEFAULT_AUTO_TIMEOUT_MS,
    maxArticles: DEFAULT_MAX_ARTICLES,
    maxPages: DEFAULT_MAX_PAGES,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      args.help = true;
    } else if (item === "--no-wait") {
      args.wait = false;
    } else if (item === "--auto-after-login") {
      args.autoAfterLogin = true;
      args.wait = false;
    } else if (item === "--all-published") {
      args.allPublished = true;
      args.wait = false;
    } else if (item === "--capture-content") {
      args.captureContent = true;
    } else if (item === "--headless") {
      args.headless = true;
    } else if (item.startsWith("--")) {
      const key = item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${item}`);
      }
      args[key] = value;
      index += 1;
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

function timestamp() {
  const now = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    "-",
    pad(now.getMilliseconds(), 3),
  ].join("");
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

async function waitForUser() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("");
  console.log("请在打开的浏览器中登录微信公众平台，进入目标文章的数据/统计/留言页面。");
  console.log("采集器只读取当前可见页面文字，不绕过登录、不调用非授权接口。准备好后回到终端按 Enter。");
  await rl.question("Press Enter to collect current visible page...");
  rl.close();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function redactUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return text;
  }
}

function redactForStorage(value, fieldName = "") {
  if (SENSITIVE_FIELD_RE.test(fieldName)) return "[已脱敏]";
  if (Array.isArray(value)) return value.map((item) => redactForStorage(item, fieldName));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactForStorage(item, key)]));
  }
  if (typeof value !== "string") return value;
  const text = /(?:url|href)$/i.test(fieldName) ? redactUrl(value) : value;
  return text.replace(SENSITIVE_TEXT_RE, "[已脱敏]");
}

function stripHtml(html) {
  return cleanText(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<[^>]+>/g, "\n"));
}

function firstHref(html) {
  const match = String(html || "").match(/href=["']([^"']*mp\.weixin\.qq\.com[^"']*)["']/i);
  return match ? match[1].replace(/&amp;/g, "&") : "";
}

function parseNumber(value) {
  const text = String(value || "").replace(/,/g, "").trim();
  const match = text.match(/(\d+(?:\.\d+)?)\s*(万|w|W|千|k|K)?/);
  if (!match) return 0;
  let number = Number(match[1]);
  const unit = match[2] || "";
  if (unit === "万" || unit.toLowerCase() === "w") number *= 10000;
  if (unit === "千" || unit.toLowerCase() === "k") number *= 1000;
  return Number.isInteger(number) ? number : Number(number.toFixed(2));
}

function resolvePageUrl(rawUrl, baseUrl = "") {
  const text = String(rawUrl || "").trim();
  if (!text) return "";
  try {
    if (text.startsWith("//")) return `https:${text}`;
    return new URL(text, baseUrl || DEFAULT_START_URL).toString();
  } catch {
    return text;
  }
}

function splitSentences(text) {
  return cleanText(text)
    .split(/[。！？!?；;\n]+/)
    .map((item) => cleanText(item))
    .filter((item) => item.length >= 8);
}

function firstMeaningfulParagraph(paragraphs, fallbackText) {
  return (paragraphs || []).find((item) => cleanText(item).length >= 12) || splitSentences(fallbackText)[0] || "";
}

function compactEvidence(lines, limit = 3) {
  const seen = new Set();
  const results = [];
  for (const item of lines || []) {
    const text = cleanText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    results.push(text);
    if (results.length >= limit) break;
  }
  return results;
}

function findCtaEvidence(paragraphs) {
  return (paragraphs || [])
    .map((item) => cleanText(item))
    .filter((item) => /留言|评论|回复|私信|扫码|咨询|填写|告诉我|写下|欢迎|联系/.test(item))
    .filter((item) => /(如果|可以|欢迎|请|把|在|到|写|告诉|回复|留言区|评论区).*(留言|评论|回复|私信|扫码|咨询|填写|告诉我|写下|联系)|留言区|评论区/.test(item))
    .slice(0, 3);
}

function boundedScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function hasPattern(text, pattern) {
  return pattern.test(cleanText(text));
}

function selectEvidence(sentences, pattern, limit = 2) {
  return compactEvidence(sentences.filter((item) => pattern.test(item)), limit);
}

function firstEvidence(items, fallback) {
  return compactEvidence(items, 1)[0] || cleanText(fallback || "").slice(0, 120);
}

function makeScorecardItem(dimension, score, evidence, diagnosis, recommendation) {
  return {
    dimension,
    score: boundedScore(score),
    evidence: compactEvidence(Array.isArray(evidence) ? evidence : [evidence], 3),
    diagnosis,
    recommendation,
  };
}

function makeSuggestion(priority, problem, evidence, recommendation, rewriteDirection, expectedEffect) {
  return {
    priority,
    problem,
    evidence: compactEvidence(Array.isArray(evidence) ? evidence : [evidence], 3),
    recommendation,
    rewrite_direction: rewriteDirection,
    expected_effect: expectedEffect,
  };
}

function titleBodyOverlapScore(title, contentText) {
  const titleTerms = cleanText(title)
    .replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, " ")
    .split(/\s+/)
    .flatMap((term) => {
      if (/^[\u4e00-\u9fff]+$/.test(term) && term.length >= 4) {
        return [term.slice(0, 2), term.slice(2, 4), term.slice(-2)];
      }
      return [term];
    })
    .filter((term) => term.length >= 2);
  if (!titleTerms.length) return 60;
  const hits = titleTerms.filter((term) => contentText.includes(term)).length;
  return 45 + Math.min(45, Math.round((hits / titleTerms.length) * 45));
}

function analyzeArticleContent(articleContent) {
  const contentText = cleanText(articleContent?.content_text || "");
  const paragraphs = Array.isArray(articleContent?.paragraphs) ? articleContent.paragraphs.map(cleanText).filter(Boolean) : [];
  const headings = Array.isArray(articleContent?.headings) ? articleContent.headings.map(cleanText).filter(Boolean) : [];
  const opening = firstMeaningfulParagraph(paragraphs, contentText);
  const headingPoints = headings
    .map((item) => item.replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, ""))
    .filter((item) => item.length >= 4);
  const sentencePoints = splitSentences(contentText).slice(0, 5);
  const keyPoints = compactEvidence(headingPoints.length ? headingPoints : sentencePoints, 5);
  const ctaEvidence = findCtaEvidence(paragraphs);
  const hasMethodSignal = /方法|步骤|模板|清单|怎么|如何|判断|执行/.test(`${articleContent?.title || ""}\n${contentText}`);
  const hasCaseSignal = /案例|故事|现场|饭局|客户|项目|经历/.test(`${articleContent?.title || ""}\n${contentText}`);
  let structureType = "essay_longform";
  if (headings.length >= 2 && hasMethodSignal) {
    structureType = "method_article";
  } else if (headings.length >= 2 && hasCaseSignal) {
    structureType = "case_analysis";
  } else if (headings.length >= 2) {
    structureType = "structured_longform";
  } else if (paragraphs.length <= 3) {
    structureType = "short_note";
  }
  const risks = [];
  if (!ctaEvidence.length) risks.push("cta_missing_or_not_obvious");
  if (headings.length < 2 && paragraphs.length >= 6) risks.push("structure_not_easy_to_scan");
  if (/(保证|一定|唯一|第一|最[好佳强快]|100%|\d+\s*(倍|%))/.test(contentText)) {
    risks.push("hard_claim_or_absolute_wording_review");
  }
  if (/微信号|加微信|扫码|二维码|手机号|私信/.test(contentText)) {
    risks.push("private_traffic_compliance_review");
  }
  const optimizationQuestions = [
    "开头是否在 3 句话内说清读者处境、冲突和代价？",
    "每个小标题是否都能单独成为读者愿意继续看的判断句？",
    "结尾是否把评论区问题设计成下一篇选题输入？",
  ];
  if (!ctaEvidence.length) optimizationQuestions.unshift("是否需要增加更具体的评论区提问或业务场景收集入口？");
  if (risks.includes("structure_not_easy_to_scan")) optimizationQuestions.unshift("是否需要补充 2-4 个小标题来降低长文阅读压力？");
  const sentences = splitSentences(contentText);
  const title = cleanText(articleContent?.title || "");
  const titleAndText = `${title}\n${contentText}`;
  const readerSceneEvidence = selectEvidence(sentences, /你|客户|读者|老板|创业|业务|预算|没人|卡|怕|焦虑|困惑|问题|场景/, 3);
  const conflictEvidence = selectEvidence(sentences, /不是|而是|但是|但|却|卡|怕|难|风险|代价|问题|冲突|失效|误区|坑/, 3);
  const methodEvidence = compactEvidence([
    ...headingPoints,
    ...selectEvidence(sentences, /方法|步骤|模板|清单|怎么|如何|判断|执行|先|再|最后|应该|可以/, 4),
  ], 5);
  const proofEvidence = selectEvidence(sentences, /\d|万|亿|%|案例|客户|项目|经历|现场|饭局|调研|数据|申请|估值|成本|预算/, 4);
  const averageParagraphLength = paragraphs.length ? Math.round(contentText.length / paragraphs.length) : contentText.length;
  const openingHasReaderScene = hasPattern(opening, /你|客户|读者|老板|创业|业务|预算|没人|卡|怕|焦虑|问题|场景/);
  const openingHasConflict = hasPattern(opening, /不是|而是|但|却|问题|卡|怕|冲突|代价|难|失效|误区/);
  const openingHasClaim = hasPattern(opening, /应该|不是|而是|关键|核心|真正|先|再|最后|判断/);
  const openingScore = boundedScore(
    45
    + (openingHasReaderScene ? 18 : 0)
    + (openingHasConflict ? 16 : 0)
    + (openingHasClaim ? 12 : 0)
    + (opening.length >= 35 && opening.length <= 180 ? 9 : 0),
  );
  const structureScore = boundedScore(
    40
    + (headings.length >= 2 ? 24 : 0)
    + (paragraphs.length >= 4 ? 10 : 0)
    + (averageParagraphLength <= 260 ? 10 : 0)
    + (keyPoints.length >= 3 ? 8 : 0),
  );
  const depthScore = boundedScore(
    38
    + (proofEvidence.length >= 2 ? 22 : proofEvidence.length * 10)
    + (hasPattern(titleAndText, /案例|客户|项目|经历|现场|饭局/) ? 14 : 0)
    + (hasPattern(titleAndText, /\d|万|亿|%/) ? 12 : 0)
    + (hasPattern(titleAndText, /为什么|底层|逻辑|原因|机制|本质/) ? 10 : 0),
  );
  const readerValueScore = boundedScore(
    42
    + (readerSceneEvidence.length >= 2 ? 18 : readerSceneEvidence.length * 8)
    + (methodEvidence.length >= 2 ? 18 : methodEvidence.length * 8)
    + (hasPattern(titleAndText, /模板|清单|方法|判断|步骤|指南|建议|怎么/) ? 12 : 0),
  );
  const conversionScore = boundedScore(
    ctaEvidence.length
      ? 68 + (hasPattern(ctaEvidence.join("\n"), /留言|评论|场景|问题|业务|告诉我|写下/) ? 17 : 5)
      : 32,
  );
  const titleScore = titleBodyOverlapScore(title, contentText);
  const scorecard = [
    makeScorecardItem(
      "opening_hook",
      openingScore,
      opening,
      openingScore >= 80 ? "开头能较快给出读者处境或核心判断。" : "开头的读者处境、冲突或代价还不够集中。",
      openingScore >= 80 ? "保留开头判断，再补一句更具体的读者代价。" : "用“具体人群 + 正在卡住的事 + 错做法代价”重写前 3 句。",
    ),
    makeScorecardItem(
      "structure_scanability",
      structureScore,
      headings.length ? headings.slice(0, 4) : paragraphs.slice(0, 2),
      structureScore >= 78 ? "结构基本可扫读。" : "结构层级不足，读者不容易快速判断每段价值。",
      "把小标题改成可独立传播的判断句，并让每节只解决一个问题。",
    ),
    makeScorecardItem(
      "depth_and_evidence",
      depthScore,
      proofEvidence.length ? proofEvidence : sentences.slice(0, 2),
      depthScore >= 78 ? "正文有一定事实、案例或机制支撑。" : "正文的事实锚点和例子还不够密，容易停留在观点表达。",
      "每个核心判断至少补一个具体场景、数字、对话或反例。",
    ),
    makeScorecardItem(
      "reader_value",
      readerValueScore,
      methodEvidence.length ? methodEvidence : readerSceneEvidence,
      readerValueScore >= 78 ? "读者能带走方法或判断。" : "读者可执行的下一步还不够明确。",
      "把方法沉淀成 3 步判断、清单或可复制句式。",
    ),
    makeScorecardItem(
      "conversion_design",
      conversionScore,
      ctaEvidence.length ? ctaEvidence : paragraphs.slice(-2),
      ctaEvidence.length ? "结尾有互动或行动入口。" : "结尾没有明显评论区任务，难以沉淀真实问题。",
      "用一个填空式问题收集业务场景、卡点或读者下一篇想看的问题。",
    ),
    makeScorecardItem(
      "title_body_alignment",
      titleScore,
      [title, keyPoints[0] || opening],
      titleScore >= 75 ? "标题与正文主题基本一致。" : "标题承诺和正文展开可能存在偏移。",
      "检查标题里的最大承诺是否在正文前三分之一被兑现。",
    ),
  ];
  const openingAnalysis = {
    score: openingScore,
    evidence: firstEvidence([opening], contentText),
    strength: openingHasClaim ? "有明确判断句。" : "已能提取出开头段落。",
    problem: openingScore >= 80 ? "主要问题不是方向，而是还可以把代价写得更尖锐。" : "开头需要更快出现具体读者、具体卡点和错误做法代价。",
    recommendation: openingScore >= 80 ? "保留判断，补一处真实读者场景。" : "前三句按“谁在什么场景卡住 - 常见错法 - 这篇给出什么新判断”重写。",
    rewrite_direction: "不要从概念开场，先写一个读者正在发生的业务现场，再抛出本文判断。",
  };
  const structureAnalysis = {
    score: structureScore,
    evidence: compactEvidence(headings.length ? headings : paragraphs, 5),
    problem: structureScore >= 78 ? "结构可读，但小标题还可以更像判断句。" : "小标题或分段不足，长文容易变成连续观点流。",
    recommendation: "将正文压成 3-5 个层级：问题、误区、判断、证据、行动。",
    rewrite_direction: "把描述性小标题改成“读者能转发的结论”，例如“先把问题说准，再介绍方法”。",
  };
  const depthAnalysis = {
    score: depthScore,
    evidence: proofEvidence,
    problem: depthScore >= 78 ? "证据能支撑主判断，但可继续增加反例或对照。" : "关键判断缺少足够具体的事实锚点。",
    recommendation: "每个判断后补一个可复核细节：数字、人物动作、真实对话、前后对比或失败样本。",
    rewrite_direction: "减少抽象评价，增加“发生了什么、谁做了什么、结果有什么变化”。",
  };
  const audienceAnalysis = {
    score: readerValueScore,
    evidence: readerSceneEvidence.length ? readerSceneEvidence : methodEvidence,
    problem: readerValueScore >= 78 ? "读者价值较明确，可继续把适用边界写清。" : "目标读者和可执行收益需要再收窄。",
    recommendation: "明确这篇最适合谁、不适合谁，以及读者读完能立刻做哪一个动作。",
    rewrite_direction: "把泛泛的“大家/我们”改成具体人群，如“服务型创始人/内容负责人/预算有限的小团队”。",
  };
  const conversionAnalysis = {
    score: conversionScore,
    evidence: ctaEvidence,
    problem: ctaEvidence.length ? "有行动入口，但还可以更像诊断问题。" : "缺少评论区任务，内容读完后没有把读者问题回流回来。",
    recommendation: ctaEvidence.length
      ? "把 CTA 改成填空式问题，收集业务场景和下一篇素材。"
      : "结尾增加低压力评论入口：让读者写业务场景、当前卡点或想看的案例。",
    rewrite_direction: "结尾用“如果你也在___，留言区写___，我下一篇拆___”承接。",
  };
  const optimizationSuggestions = [
    makeSuggestion(
      openingScore >= 80 ? "P1" : "P0",
      openingAnalysis.problem,
      openingAnalysis.evidence,
      openingAnalysis.recommendation,
      openingAnalysis.rewrite_direction,
      "提高从标题点击到首屏继续读的留存。",
    ),
    makeSuggestion(
      structureScore >= 78 ? "P2" : "P1",
      structureAnalysis.problem,
      structureAnalysis.evidence,
      structureAnalysis.recommendation,
      structureAnalysis.rewrite_direction,
      "降低长文阅读压力，让读者更容易扫读和转发。",
    ),
    makeSuggestion(
      depthScore >= 78 ? "P2" : "P1",
      depthAnalysis.problem,
      depthAnalysis.evidence.length ? depthAnalysis.evidence : [opening],
      depthAnalysis.recommendation,
      depthAnalysis.rewrite_direction,
      "增强可信度，减少“观点对但不够有现场感”的损耗。",
    ),
    makeSuggestion(
      conversionScore >= 75 ? "P1" : "P0",
      conversionAnalysis.problem,
      conversionAnalysis.evidence.length ? conversionAnalysis.evidence : paragraphs.slice(-2),
      conversionAnalysis.recommendation,
      conversionAnalysis.rewrite_direction,
      "把阅读转成评论样本和下一篇选题输入。",
    ),
  ].sort((left, right) => {
    const order = { P0: 0, P1: 1, P2: 2 };
    return (order[left.priority] ?? 9) - (order[right.priority] ?? 9);
  });
  const nextContentOpportunities = compactEvidence([
    keyPoints[0] ? `围绕“${keyPoints[0]}”单独拆一篇更具体的方法文。` : "",
    readerSceneEvidence[0] ? `把读者场景继续追问：${readerSceneEvidence[0]}` : "",
    proofEvidence[0] ? `把文中的事实锚点扩写成案例复盘：${proofEvidence[0]}` : "",
    ctaEvidence[0] ? `根据评论区 CTA 收集到的问题做下一篇答疑。` : "下一篇可以专门补“读者该怎么做”的清单型内容。",
  ], 4);
  const scoreAverage = Math.round(scorecard.reduce((sum, item) => sum + item.score, 0) / scorecard.length);
  return {
    analysis_version: "aifios-wechat-content-analysis-v2",
    structure_type: structureType,
    diagnosis_summary: `综合评分 ${scoreAverage}/100；优先优化：${optimizationSuggestions.filter((item) => item.priority === "P0")[0]?.problem || optimizationSuggestions[0].problem}`,
    opening_summary: opening.slice(0, 140),
    key_points: keyPoints,
    cta_detected: ctaEvidence.length > 0,
    cta_evidence: ctaEvidence,
    content_risks: risks,
    optimization_questions: optimizationQuestions,
    scorecard,
    opening_analysis: openingAnalysis,
    structure_analysis: structureAnalysis,
    depth_analysis: depthAnalysis,
    audience_analysis: audienceAnalysis,
    conversion_analysis: conversionAnalysis,
    optimization_suggestions: optimizationSuggestions,
    next_content_opportunities: nextContentOpportunities,
    revision_brief: {
      primary_fix: optimizationSuggestions[0]?.recommendation || "补充开头、结构和 CTA。",
      secondary_fix: optimizationSuggestions[1]?.recommendation || "补充事实证据和小标题。",
      keep: keyPoints.slice(0, 2),
      suggested_title_angle: title ? `保留“${title}”的核心承诺，但正文前三分之一必须兑现标题最大钩子。` : "标题需要明确读者、冲突和收益。",
      comment_prompt: ctaEvidence[0] || "如果你也遇到类似问题，留言写下你的业务场景和当前最卡的一步。",
    },
    paragraph_count: paragraphs.length,
    heading_count: headings.length,
    character_count: contentText.length,
    estimated_reading_seconds: Math.max(10, Math.round(contentText.length / 5)),
  };
}

function metricAfter(text, labels) {
  for (const label of labels) {
    const pattern = new RegExp(`${label}\\s*[:：]?\\s*([0-9][0-9,.]*(?:\\.\\d+)?\\s*(?:万|w|W|千|k|K)?)`);
    const match = text.match(pattern);
    if (match) return parseNumber(match[1]);
  }
  return 0;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasMetricSignal(text, args) {
  const payload = extractVisiblePayload({ html: "", text, pageUrl: "", args });
  return Object.keys(payload.metrics || {}).length > 0;
}

async function pageSnapshot(page) {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: document.body?.innerText || "",
    html: document.documentElement?.outerHTML || "",
  }));
}

async function articleContentSnapshot(page, sourceUrl) {
  return page.evaluate((sourceUrlIn) => {
    function clean(value) {
      return String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    function firstText(selectors) {
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        const text = clean(node?.innerText || node?.textContent || "");
        if (text) return text;
      }
      return "";
    }

    const contentRoot = document.querySelector("#js_content")
      || document.querySelector(".rich_media_content")
      || document.querySelector("[data-role='content']")
      || document.querySelector("article")
      || document.querySelector("main")
      || document.body;
    const paragraphs = Array.from(contentRoot.querySelectorAll("p, section"))
      .map((node) => clean(node.innerText || node.textContent || ""))
      .filter((text) => text.length >= 2);
    const headings = Array.from(contentRoot.querySelectorAll("h1, h2, h3, strong"))
      .map((node) => clean(node.innerText || node.textContent || ""))
      .filter((text) => text.length >= 2 && text.length <= 80);
    const title = firstText([
      "#activity-name",
      ".rich_media_title",
      "h1.rich_media_title",
      "h1",
      "title",
    ]);
    const accountName = firstText([
      "#js_name",
      ".profile_nickname",
      ".rich_media_meta_nickname",
      "[class*='nickname']",
    ]);
    const publishedAt = firstText([
      "#publish_time",
      "em#publish_time",
      ".rich_media_meta_text",
      "[class*='publish_time']",
    ]);
    const contentText = clean(contentRoot.innerText || contentRoot.textContent || "");
    return {
      source_url: sourceUrlIn,
      page_url: location.href,
      title,
      account_name: accountName,
      published_at: publishedAt,
      content_text: contentText,
      paragraphs,
      headings,
      paragraph_count: paragraphs.length,
      heading_count: headings.length,
      character_count: contentText.length,
      image_count: contentRoot.querySelectorAll("img").length,
    };
  }, sourceUrl);
}

function detectPageState(snapshot) {
  const url = String(snapshot?.url || "");
  let decodedUrl = url;
  try {
    decodedUrl = decodeURIComponent(url);
  } catch {
    decodedUrl = url;
  }
  const head = cleanText(`${decodedUrl}\n${snapshot?.title || ""}\n${snapshot?.text || ""}`).slice(0, 3000);
  if (/验证码|安全验证|环境异常|访问过于频繁|verify|captcha|antispider/i.test(head)) {
    return { status: "blocked", reason: "页面需要验证码或安全验证" };
  }
  if (/login|passport|sso|wxamp_login/i.test(decodedUrl) && /登录|扫码|sign\s*in|login/i.test(head)) {
    return { status: "needs_login", reason: "等待用户完成公众号后台登录" };
  }
  if (/扫码登录|请登录|登录后查看|登录后可见|未登录/.test(head)) {
    return { status: "needs_login", reason: "等待用户完成公众号后台登录" };
  }
  return { status: "ready", reason: "" };
}

async function waitForLoginIfNeeded(page, args) {
  const timeoutMs = Number(args.autoTimeoutMs || DEFAULT_AUTO_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    const snapshot = await pageSnapshot(page).catch(() => ({ url: page.url(), title: "", text: "", html: "" }));
    const state = detectPageState(snapshot);
    if (state.status === "blocked") {
      throw new Error(`${state.reason}；请在浏览器中处理后重试。`);
    }
    if (state.status !== "needs_login") return state;
    if (args.headless) {
      throw new Error("当前页面需要登录，但 headless 模式无法手动扫码登录。请去掉 --headless 后重试。");
    }
    if (!announced) {
      console.error("请在打开的浏览器中完成微信公众号后台登录。登录成功后系统会自动继续，不需要按 Enter。");
      announced = true;
    }
    await page.waitForTimeout(2000);
  }
  throw new Error(`等待登录超时（${timeoutMs}ms）。请确认已在浏览器完成公众号后台登录。`);
}

async function waitForPageSettled(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);
}

async function captureArticleContent(context, rawUrl, baseUrl, project, slug, stamp) {
  const sourceUrl = resolvePageUrl(rawUrl, baseUrl);
  if (!sourceUrl) {
    throw new Error("missing publish_url for article content capture");
  }
  const page = await context.newPage();
  try {
    await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForPageSettled(page);
    const articleContent = await articleContentSnapshot(page, sourceUrl);
    if (!articleContent.content_text || articleContent.content_text.length < 10) {
      throw new Error("article body text was not visible");
    }
    const analysis = analyzeArticleContent(articleContent);
    const capturePath = path.join(project, "materials", "performance", "article-captures", `${slug}-${stamp}.json`);
    const articleContentWithPath = {
      ...articleContent,
      capture_path: capturePath,
    };
    writeJson(capturePath, {
      schema: "aifios.wechat-mp-article-content.v1",
      captured_at: new Date().toISOString(),
      source_boundary: "public article URL opened from an authorized visible publish record",
      article_content: articleContentWithPath,
      content_analysis: analysis,
    });
    return {
      article_capture_path: capturePath,
      article_content: articleContentWithPath,
      content_analysis: analysis,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function attachArticleContentIfRequested(context, payload, args, project, slug, stamp, baseUrl) {
  if (!args.captureContent) return payload;
  const publishUrl = payload.publish_url || args.publishUrl || "";
  if (!publishUrl) {
    payload.anomalies = [...(payload.anomalies || []), "article_content_capture_skipped:missing_publish_url"];
    return payload;
  }
  try {
    const captured = await captureArticleContent(context, publishUrl, baseUrl, project, slug, stamp);
    payload.publish_url = captured.article_content.source_url || publishUrl;
    payload.article_capture_path = captured.article_capture_path;
    payload.article_content = captured.article_content;
    payload.content_analysis = captured.content_analysis;
  } catch (error) {
    payload.anomalies = [
      ...(payload.anomalies || []),
      `article_content_capture_failed:${String(error?.message || error)}`,
    ];
  }
  return payload;
}

async function waitForMetricsVisible(page, args, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await pageSnapshot(page).catch(() => null);
    if (snapshot && hasMetricSignal(snapshot.text, args)) return true;
    await page.waitForTimeout(800);
  }
  return false;
}

async function clickLocator(locator, page) {
  try {
    await Promise.all([
      page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {}),
      locator.first().click({ timeout: 2500 }),
    ]);
    await waitForPageSettled(page);
    return true;
  } catch {
    return false;
  }
}

async function searchTitleIfPossible(page, title) {
  if (!title) return false;
  const inputSelectors = [
    "input[placeholder*='搜索']",
    "input[placeholder*='标题']",
    "input[type='search']",
    "input",
    "textarea[placeholder*='搜索']",
  ];
  for (const selector of inputSelectors) {
    const input = page.locator(selector).first();
    if (await input.count().catch(() => 0) === 0) continue;
    try {
      await input.fill(title, { timeout: 1500 });
      await input.press("Enter", { timeout: 1500 }).catch(async () => {
        const searchButton = page.locator("button, a, [role='button']").filter({ hasText: /搜索|查询/ }).first();
        if (await searchButton.count().catch(() => 0)) await searchButton.click({ timeout: 1500 });
      });
      await waitForPageSettled(page);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function clickStatsLinkNearTitle(page, title) {
  if (!title) return false;
  const blockSelector = [
    "article", "tr", "li", "section",
    ".appmsg-item", ".weui-desktop-mass-appmsg", ".weui-desktop-card", ".mass_appmsg_item",
    "div",
  ].join(", ");
  const blocks = page.locator(blockSelector).filter({ hasText: title });
  const count = Math.min(await blocks.count().catch(() => 0), 30);
  for (let index = 0; index < count; index += 1) {
    const block = blocks.nth(index);
    const blockText = await block.innerText({ timeout: 1000 }).catch(() => "");
    if (!blockText.includes(title)) continue;
    for (const label of STATS_LINK_LABELS) {
      const labelPattern = new RegExp(label);
      const candidate = block.locator("a, button, [role='button'], [class*='btn'], [class*='link']").filter({ hasText: labelPattern }).first();
      if (await candidate.count().catch(() => 0)) {
        if (await clickLocator(candidate, page)) return true;
      }
      const textCandidate = block.getByText(labelPattern).first();
      if (await textCandidate.count().catch(() => 0)) {
        if (await clickLocator(textCandidate, page)) return true;
      }
    }
  }
  return false;
}

async function clickLikelyContentNav(page, labels = CONTENT_NAV_LABELS) {
  for (const label of labels) {
    const exactPattern = new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`);
    const preferred = [
      page.locator("a[href]").filter({ hasText: exactPattern }).first(),
      page.locator("button, [role='button']").filter({ hasText: exactPattern }).first(),
      page.locator("[class*='menu'], [class*='nav']").filter({ hasText: exactPattern }).first(),
    ];
    for (const candidate of preferred) {
      if (await candidate.count().catch(() => 0)) {
        if (await clickLocator(candidate, page)) return label;
      }
    }
  }
  return "";
}

async function openPublishedListIfPossible(page, batchActions) {
  const navRounds = [
    CONTENT_NAV_LABELS,
    PUBLISHED_NAV_LABELS,
    PUBLISHED_NAV_LABELS,
  ];
  for (const labels of navRounds) {
    if ((await extractPublishedArticleCandidates(page, 1)).length) return true;
    const navLabel = await clickLikelyContentNav(page, labels);
    if (navLabel) {
      batchActions.push(`opened_nav:${navLabel}`);
      await waitForPageSettled(page);
    }
  }
  return (await extractPublishedArticleCandidates(page, 1)).length > 0;
}

async function extractPublishedArticleCandidates(page, limit) {
  return page.evaluate(({ limit, statsLabels }) => {
    const selectors = [
      "article",
      "tr",
      "li",
      "section",
      ".appmsg-item",
      ".weui-desktop-mass-appmsg",
      ".weui-desktop-card",
      ".mass_appmsg_item",
      "div[class*='appmsg']",
      "div[class*='card']",
    ].join(", ");

    function clean(value) {
      return String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{2,}/g, "\n")
        .trim();
    }

    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 40 && rect.height > 20 && style.display !== "none" && style.visibility !== "hidden";
    }

    function linesOf(text) {
      return clean(text).split(/\n+/).map((line) => clean(line)).filter(Boolean);
    }

    function extractPublishedAt(text) {
      const match = clean(text).match(/(?:发表时间|发布时间|群发时间|发布于|发布)\s*[：:]?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2})?)/);
      return match ? match[1].replace(/\//g, "-") : "";
    }

    function titleFromLines(lines) {
      return lines.find((line) => {
        if (line.length < 4 || line.length > 80) return false;
        if (/数据分析|昨日阅读|昨日分享|添加合集|声明创作来源|原创|转载/.test(line)) return false;
        if (/^(数据|查看数据|统计|图文统计|详情|分析|删除|编辑|预览|已发表|发表记录)$/.test(line)) return false;
        if (/^(发布于|发表时间|发布时间|群发时间)/.test(line)) return false;
        if (/恢复后用户|确定恢复|临时入口|置顶|仅自己可见|关闭推荐|复制链接/.test(line)) return false;
        if (/^[0-9,.\s万wW千kK:-]+$/.test(line)) return false;
        return true;
      }) || "";
    }

    function statsHref(el) {
      const links = Array.from(el.querySelectorAll("a[href]"));
      for (const label of statsLabels) {
        const found = links.find((link) => clean(link.innerText || link.textContent).includes(label));
        if (found) {
          try {
            return new URL(found.getAttribute("href"), location.href).toString();
          } catch {
            return found.getAttribute("href") || "";
          }
        }
      }
      const fallback = links.find((link) => /(stat|data|analysis|detail|appmsg|mp)/i.test(link.getAttribute("href") || ""));
      if (fallback) {
        try {
          return new URL(fallback.getAttribute("href"), location.href).toString();
        } catch {
          return fallback.getAttribute("href") || "";
        }
      }
      return "";
    }

    const results = [];
    const seen = new Set();
    for (const el of Array.from(document.querySelectorAll(selectors))) {
      if (!visible(el)) continue;
      const text = clean(el.innerText || el.textContent || "");
      if (!text) continue;
      const hasStatsLabel = statsLabels.some((label) => text.includes(label));
      if (!hasStatsLabel && !/(阅读|曝光|评论|分享|收藏|在看)/.test(text)) continue;
      const lines = linesOf(text);
      const title = titleFromLines(lines);
      if (!title) continue;
      const href = statsHref(el);
      const publishedAt = extractPublishedAt(text);
      const articleOperationSignal = /发表数据|置顶|仅自己可见|关闭推荐|复制链接|还可以修改/.test(text);
      if (!href && !publishedAt && !articleOperationSignal) continue;
      const key = `${title}::${href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        title,
        published_at: publishedAt,
        stats_url: href,
      });
      if (results.length >= limit) break;
    }
    return results;
  }, { limit, statsLabels: STATS_LINK_LABELS });
}

async function extractPublishHistoryRows(page, limit) {
  return page.evaluate(({ limit }) => {
    function clean(value) {
      return String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{2,}/g, "\n")
        .trim();
    }

    function parseNumber(value) {
      const text = String(value || "").replace(/,/g, "").replace(/^¥/, "").trim();
      const match = text.match(/^(\d+(?:\.\d+)?)\s*(万|w|W|千|k|K)?$/);
      if (!match) return null;
      let number = Number(match[1]);
      const unit = match[2] || "";
      if (unit === "万" || unit.toLowerCase() === "w") number *= 10000;
      if (unit === "千" || unit.toLowerCase() === "k") number *= 1000;
      return Number.isInteger(number) ? number : Number(number.toFixed(2));
    }

    function cleanTitle(value) {
      return clean(value)
        .replace(/\s*(原创|已修改|转载|已群发|已发表)\s*$/g, "")
        .replace(/\s*(原创|已修改|转载)\s*$/g, "")
        .trim();
    }

    const rows = [];
    const seen = new Set();
    const nodes = Array.from(document.querySelectorAll(".weui-desktop-mass__content"));
    for (const node of nodes) {
      const link = node.querySelector("a.weui-desktop-mass-appmsg__title[href], a[href*='mp.weixin.qq.com/s/']");
      if (!link) continue;
      let href = link.getAttribute("href") || "";
      try {
        href = new URL(href, location.href).toString();
      } catch {
        href = link.getAttribute("href") || "";
      }
      const title = cleanTitle(link.innerText || link.textContent || "");
      if (!title || !href || seen.has(href)) continue;
      seen.add(href);
      const lines = clean(node.innerText || node.textContent || "")
        .split(/\n+/)
        .map((line) => clean(line))
        .filter(Boolean);
      const titleIndex = lines.findIndex((line) => line.includes(title) || title.includes(line));
      const dateLine = lines.find((line) => /^(今天\s+\d{1,2}:\d{2}|\d{1,4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日)/.test(line)) || "";
      const lineNumericValues = lines
        .slice(titleIndex >= 0 ? titleIndex + 1 : 0)
        .map((line) => parseNumber(line))
        .filter((value) => value !== null);
      const metricNodeText = Array.from(node.querySelectorAll(
        ".weui-desktop-mass-media__data, .weui-desktop-mass-appmsg span, .weui-desktop-mass-appmsg a.weui-desktop-icon__response-mouse",
      ))
        .map((item) => clean(item.innerText || item.textContent || ""))
        .filter(Boolean)
        .join(" ");
      const metricText = metricNodeText || lines.slice(titleIndex >= 0 ? titleIndex + 1 : 0).join(" ");
      const numericValues = lineNumericValues.length
        ? lineNumericValues
        : Array.from(metricText.matchAll(/¥?\d+(?:\.\d+)?\s*(?:万|w|W|千|k|K)?/g))
          .map((match) => parseNumber(match[0]))
          .filter((value) => value !== null);
      rows.push({
        source: "publish-history-row",
        title,
        published_at: dateLine,
        publish_url: href,
        visible_list_metrics: numericValues,
        metrics: numericValues.length ? { reads: numericValues[0] } : {},
      });
      if (rows.length >= limit) break;
    }
    return rows;
  }, { limit });
}

async function clickNextListPage(page) {
  const candidates = [
    page.locator("a, button, [role='button']").filter({ hasText: /下一页|下页|更多|加载更多/ }).first(),
    page.locator(".next, .pagination-next, [class*='next']").first(),
  ];
  for (const candidate of candidates) {
    if (await candidate.count().catch(() => 0)) {
      const disabled = await candidate.getAttribute("disabled").catch(() => "") || "";
      const classes = await candidate.getAttribute("class").catch(() => "") || "";
      if (disabled || /disabled|disable/.test(classes)) continue;
      if (await clickLocator(candidate, page)) return true;
    }
  }
  return false;
}

function itemSlug(prefix, index) {
  return `${prefix}-${String(index + 1).padStart(3, "0")}`;
}

async function openStatsFromCandidate(page, candidate) {
  if (candidate.stats_url) {
    await page.goto(candidate.stats_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForPageSettled(page);
    return true;
  }
  return clickStatsLinkNearTitle(page, candidate.title);
}

async function collectAllPublishedWithBrowser(args, project, stamp) {
  const { chromium } = loadPlaywright();
  const executablePath = packagedChromiumPath();
  const profile = path.resolve(expandHome(args.profile || path.join(os.homedir(), ".aifios-browser-profiles", "wechat-mp-performance")));
  const context = await chromium.launchPersistentContext(profile, {
    headless: Boolean(args.headless),
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
    ...(executablePath ? { executablePath } : {}),
  });
  const items = [];
  const failures = [];
  const batchActions = [];
  const seen = new Set();
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(args.url || DEFAULT_START_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForLoginIfNeeded(page, args);
    await openPublishedListIfPossible(page, batchActions);
    const maxArticles = Number(args.maxArticles || DEFAULT_MAX_ARTICLES);
    const maxPages = Number(args.maxPages || DEFAULT_MAX_PAGES);
    for (let pageIndex = 0; pageIndex < maxPages && items.length < maxArticles; pageIndex += 1) {
      const listUrl = page.url();
      const historyRows = await extractPublishHistoryRows(page, maxArticles - items.length);
      const candidates = historyRows.length ? historyRows : await extractPublishedArticleCandidates(page, maxArticles - items.length);
      if (!candidates.length) break;
      batchActions.push(`list_page_${pageIndex + 1}:candidates_${candidates.length}`);
      for (const candidate of candidates) {
        if (items.length >= maxArticles) break;
        const key = `${candidate.title}::${candidate.stats_url || candidate.publish_url || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const slug = itemSlug(args.slug, items.length);
        try {
          let payload;
          let contentBaseUrl = listUrl;
          if (candidate.source === "publish-history-row") {
            payload = {
              slug,
              title: candidate.title,
              publish_url: candidate.publish_url || "",
              published_at: candidate.published_at || "",
              authorization_mode: "self-account",
              data_source: "微信公众平台发表记录列表登录态可见数据",
              captured_by: "wechat-mp-browser-publish-history",
              evidence: "登录态浏览器发表记录列表当前可见行；不绕过平台授权；不抓取无权限数据。",
              metrics: candidate.metrics || {},
              comments: [],
              visible_list_metrics: candidate.visible_list_metrics || [],
              anomalies: ["metrics_from_publish_history_visible_list"],
            };
          } else {
            await openStatsFromCandidate(page, candidate);
            await waitForMetricsVisible(page, { ...args, title: candidate.title }, 15000);
            const snapshot = await pageSnapshot(page);
            contentBaseUrl = snapshot.url;
            payload = extractVisiblePayload({
              html: snapshot.html,
              text: snapshot.text,
              pageUrl: snapshot.url,
              args: {
                ...args,
                slug,
                title: candidate.title,
                publishedAt: candidate.published_at || args.publishedAt || "",
                publishUrl: "",
              },
            });
          }
          await attachArticleContentIfRequested(context, payload, args, project, slug, stamp, contentBaseUrl);
          if (!Object.keys(payload.metrics || {}).length) {
            payload.anomalies = [...(payload.anomalies || []), "no_visible_metrics_detected"];
          }
          const capturePath = path.join(project, "materials", "performance", "browser-captures", `${slug}-${stamp}.json`);
          const inputPath = path.join(project, "materials", "performance", "browser-inputs", `${slug}-${stamp}.json`);
          writeJson(capturePath, {
            schema: "aifios.wechat-mp-browser-capture.v1",
            captured_at: new Date().toISOString(),
            source_boundary: "visible logged-in browser page only",
            automation_mode: "all-published",
            automation_actions: [`batch_item:${items.length + 1}`],
            candidate,
            payload,
          });
          writeJson(inputPath, payload);
          const result = runPerformanceCollector(project, inputPath);
          items.push({
            slug,
            title: payload.title,
            published_at: payload.published_at,
            status: result.status,
            quality_status: result.quality_status,
            raw_path: result.raw_path,
            normalized_path: result.normalized_path,
            review_input_path: result.review_input_path,
            performance_report_path: result.performance_report_path,
            browser_capture_path: capturePath,
            browser_input_path: inputPath,
            article_capture_path: payload.article_capture_path || "",
          });
        } catch (error) {
          failures.push({
            title: candidate.title,
            stats_url: candidate.stats_url || "",
            error: String(error?.message || error),
          });
        } finally {
          if (page.url() !== listUrl) {
            await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
            await waitForPageSettled(page);
          }
        }
      }
      if (items.length >= maxArticles) break;
      if (!(await clickNextListPage(page))) break;
      await waitForPageSettled(page);
    }
  } finally {
    await context.close();
  }
  const batchCapturePath = path.join(project, "materials", "performance", "browser-captures", `${args.slug}-${stamp}-batch.json`);
  writeJson(batchCapturePath, {
    schema: "aifios.wechat-mp-browser-batch.v1",
    captured_at: new Date().toISOString(),
    source_boundary: "visible logged-in browser pages only",
    automation_mode: "all-published",
    automation_actions: batchActions,
    collected_count: items.length,
    failed_count: failures.length,
    items,
    failures,
  });
  return {
    status: failures.length ? (items.length ? "batch_partial" : "batch_failed") : "batch_collected",
    slug: args.slug,
    collected_count: items.length,
    failed_count: failures.length,
    items,
    failures,
    batch_capture_path: batchCapturePath,
  };
}

async function automateAfterLogin(page, args) {
  const actions = [];
  await waitForLoginIfNeeded(page, args);
  if (await waitForMetricsVisible(page, args, 1500)) {
    return { mode: "auto-after-login", actions: ["already_on_stats_page"] };
  }
  if (args.title) {
    if (await searchTitleIfPossible(page, args.title)) actions.push("searched_title");
    if (await clickStatsLinkNearTitle(page, args.title)) {
      actions.push("opened_stats_for_title");
      if (await waitForMetricsVisible(page, args, 15000)) {
        return { mode: "auto-after-login", actions };
      }
    }
  }
  const navLabel = await clickLikelyContentNav(page);
  if (navLabel) actions.push(`opened_nav:${navLabel}`);
  if (args.title) {
    if (await searchTitleIfPossible(page, args.title)) actions.push("searched_title_after_nav");
    if (await clickStatsLinkNearTitle(page, args.title)) {
      actions.push("opened_stats_for_title_after_nav");
      if (await waitForMetricsVisible(page, args, 15000)) {
        return { mode: "auto-after-login", actions };
      }
    }
  }
  if (await waitForMetricsVisible(page, args, 1500)) {
    return { mode: "auto-after-login", actions: [...actions, "metrics_visible_after_nav"] };
  }
  throw new Error("自动化没有进入文章数据页。请传 TITLE 精确文章标题；如果微信后台菜单改版，可追加 URL 指向已发表/统计列表页后重试。");
}

function extractComments(text) {
  const lines = cleanText(text).split(/\n+/).map((line) => cleanText(line)).filter(Boolean);
  const comments = [];
  for (const line of lines) {
    if (!/(评论|留言|comment-card|精选留言|点赞)/i.test(line)) continue;
    if (/^(精选留言|留言|评论)$/.test(line)) continue;
    if (/曝光|阅读|分享|收藏|新增关注|主页访问|线索|在看/.test(line)) continue;
    const content = cleanText(line
      .replace(/^评论\s*\d*\s*[：:]/, "")
      .replace(/^留言\s*\d*\s*[：:]/, "")
      .replace(/点赞\s*[0-9][0-9,.]*(?:万|w|W|千|k|K)?/g, "")
      .replace(/赞\s*[0-9][0-9,.]*(?:万|w|W|千|k|K)?/g, ""));
    if (content.length < 3 || content.length > 160) continue;
    comments.push({
      content,
      likes: metricAfter(line, ["点赞", "赞"]),
      type: "visible-browser-sample",
    });
  }
  return comments.slice(0, 30);
}

function extractTitle(text, fallbackTitle) {
  if (fallbackTitle) return fallbackTitle;
  const lines = cleanText(text).split(/\n+/).map((line) => cleanText(line)).filter(Boolean);
  for (const line of lines) {
    if (line.length < 4 || line.length > 80) continue;
    if (/微信公众平台|图文统计|发表时间|曝光|阅读|精选留言|查看原文/.test(line)) continue;
    if (/^[0-9,.\s万wW千kK]+$/.test(line)) continue;
    return line;
  }
  return "";
}

function extractPublishedAt(text, fallback) {
  if (fallback) return fallback;
  const match = text.match(/(?:发表时间|发布时间|群发时间|发布于)\s*[：:]?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2})?)/);
  return match ? match[1].replace(/\//g, "-") : "";
}

function extractVisiblePayload({ html, text, pageUrl, args }) {
  const visibleText = cleanText(text || stripHtml(html));
  const publishUrl = args.publishUrl || firstHref(html) || (String(pageUrl || "").includes("mp.weixin.qq.com/s/") ? pageUrl : "");
  const metrics = {
    exposures: metricAfter(visibleText, ["曝光", "曝光量", "展示", "展示量"]),
    reads: metricAfter(visibleText, ["阅读量", "阅读次数", "总阅读", "阅读"]),
    readers: metricAfter(visibleText, ["阅读人数", "读者数"]),
    likes: metricAfter(visibleText, ["点赞", "点赞数"]),
    wows: metricAfter(visibleText, ["在看", "在看数"]),
    comments: metricAfter(visibleText, ["评论", "留言", "留言数"]),
    shares: metricAfter(visibleText, ["分享", "转发", "分享次数", "转发次数"]),
    collects: metricAfter(visibleText, ["收藏", "收藏数", "收藏次数"]),
    new_followers: metricAfter(visibleText, ["新增关注", "新增粉丝"]),
    profile_visits: metricAfter(visibleText, ["主页访问", "账号访问"]),
    leads: metricAfter(visibleText, ["线索", "咨询", "留资"]),
  };
  for (const [key, value] of Object.entries(metrics)) {
    if (!value) delete metrics[key];
  }
  const comments = extractComments(visibleText);
  return {
    slug: args.slug,
    title: extractTitle(visibleText, args.title || ""),
    publish_url: publishUrl,
    published_at: extractPublishedAt(visibleText, args.publishedAt || ""),
    authorization_mode: "self-account",
    data_source: "微信公众平台后台登录态可见页面辅助整理",
    captured_by: "wechat-mp-browser-visible-page",
    evidence: "登录态浏览器当前可见页面；不绕过平台授权；不抓取无权限数据。",
    metrics,
    comments,
    anomalies: [],
  };
}

async function collectWithBrowser(args, project, stamp) {
  const { chromium } = loadPlaywright();
  const executablePath = packagedChromiumPath();
  const profile = path.resolve(expandHome(args.profile || path.join(os.homedir(), ".aifios-browser-profiles", "wechat-mp-performance")));
  const context = await chromium.launchPersistentContext(profile, {
    headless: Boolean(args.headless),
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
    ...(executablePath ? { executablePath } : {}),
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(args.url || DEFAULT_START_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    let automation = { mode: "manual-visible-page", actions: [] };
    if (args.autoAfterLogin) {
      automation = await automateAfterLogin(page, args);
    } else if (args.wait) {
      await waitForUser();
    }
    const snapshot = await pageSnapshot(page);
    const payload = extractVisiblePayload({
      html: snapshot.html,
      text: snapshot.text,
      pageUrl: snapshot.url,
      args,
    });
    await attachArticleContentIfRequested(context, payload, args, project, args.slug, stamp, snapshot.url);
    return {
      automation,
      payload,
    };
  } finally {
    await context.close();
  }
}

function collectWithFixture(args) {
  const html = fs.readFileSync(path.resolve(expandHome(args.fixture)), "utf8");
  return {
    automation: { mode: "fixture", actions: ["loaded_fixture"] },
    payload: extractVisiblePayload({ html, text: stripHtml(html), pageUrl: "", args }),
  };
}

function writeJson(pathname, payload) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, `${JSON.stringify(redactForStorage(payload), null, 2)}\n`, "utf8");
}

function runPerformanceCollector(project, inputPath) {
  const result = spawnSync(runtimePythonBinary(), [
    PERFORMANCE_COLLECTOR,
    "--project", project,
    "wechat",
    "--file", inputPath,
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.status !== 0) {
    throw new Error(output || "performance_collector.py failed");
  }
  return JSON.parse(result.stdout);
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
  if (!args.project || !args.slug) {
    console.error("--project and --slug are required");
    printHelp();
    process.exit(2);
  }
  const project = path.resolve(expandHome(args.project));
  const stamp = timestamp();
  const capturePath = path.join(project, "materials", "performance", "browser-captures", `${args.slug}-${stamp}.json`);
  const inputPath = path.join(project, "materials", "performance", "browser-inputs", `${args.slug}-${stamp}.json`);
  try {
    if (args.allPublished) {
      const result = await collectAllPublishedWithBrowser(args, project, stamp);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const collected = args.fixture ? collectWithFixture(args) : await collectWithBrowser(args, project, stamp);
    const payload = collected.payload || collected;
    const automation = collected.automation || { mode: "manual-visible-page", actions: [] };
    if (!payload.title && !args.title) {
      throw new Error("Unable to infer title from current page. Retry with --title.");
    }
    if (!Object.keys(payload.metrics || {}).length) {
      payload.anomalies = [...(payload.anomalies || []), "no_visible_metrics_detected"];
    }
    writeJson(capturePath, {
      schema: "aifios.wechat-mp-browser-capture.v1",
      captured_at: new Date().toISOString(),
      source_boundary: "visible logged-in browser page only",
      automation_mode: automation.mode,
      automation_actions: automation.actions || [],
      payload,
    });
    writeJson(inputPath, payload);
    const result = runPerformanceCollector(project, inputPath);
    console.log(JSON.stringify({
      ...result,
      browser_capture_path: capturePath,
      browser_input_path: inputPath,
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }, null, 2));
    process.exit(1);
  }
}

await main();
