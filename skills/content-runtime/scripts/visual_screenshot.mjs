#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const specPath = process.argv[2];
if (!specPath) {
  console.error("usage: node visual_screenshot.mjs <spec.json>");
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(here, "../../xhs-card/package.json"));
const { chromium } = require("playwright");
const chromiumPath = String(process.env.AIFIOS_PLAYWRIGHT_CHROMIUM_PATH || "").trim();
if (process.env.AIFIOS_DESKTOP === "1" && !chromiumPath) {
  console.error("AIFIOS desktop runtime is missing its bundled Chromium executable.");
  process.exit(2);
}
if (chromiumPath && !fs.existsSync(chromiumPath)) {
  console.error(`configured AIFIOS Playwright Chromium is missing: ${chromiumPath}`);
  process.exit(2);
}

const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
if (!spec.html || !Array.isArray(spec.targets)) {
  console.error("spec must contain html and targets");
  process.exit(2);
}

let browser;
try {
browser = await chromium.launch({
  ...(chromiumPath ? { executablePath: chromiumPath } : {}),
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({
  viewport: { width: 2400, height: 1800 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
await page.route(/^https?:\/\//, route => route.abort());
await page.goto(pathToFileURL(path.resolve(spec.html)).href, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.evaluate(async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  if (window.echoNativeLayoutReady) await window.echoNativeLayoutReady;
  await Promise.all(Array.from(document.images).map(async (img) => {
    if (img.complete) return;
    try { await img.decode(); } catch { /* handled by screenshot visibility checks */ }
  }));
});
await page.waitForTimeout(250);

const metrics = {
  schema: "aifios.visual-screenshot-metrics.v1",
  html: path.basename(spec.html),
  targets: {},
};

for (const target of spec.targets) {
  if (!target.id || !target.output) {
    console.error("target must contain id and output");
    process.exitCode = 2;
    continue;
  }
  const locator = page.locator(`[id="${target.id}"]`);
  const count = await locator.count();
  if (count !== 1) {
    console.error(`expected one node for ${target.id}, got ${count}`);
    process.exitCode = 1;
    continue;
  }
  // Check the actual text nodes and their painted line boxes before saving.
  // A source string in a recipe does not prove that it reached the image.
  let copyCheck = null;
  if (Array.isArray(target.expectedCopy)) {
    copyCheck = await locator.evaluate((poster, expected) => {
      const normalize = value => String(value).replace(/\s+/g, " ").trim();
      const nodes = [...poster.querySelectorAll('[data-approved-copy]')];
      const errors = [];
      if (nodes.length !== expected.length) errors.push("field_count");
      const frame = poster.getBoundingClientRect();
      const inside = (rect, bounds) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
        && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
      nodes.forEach((node, index) => {
        if (normalize(node.innerText) !== normalize(expected[index] ?? "")) errors.push(`field_${index}_text`);
        const range = document.createRange();
        range.selectNodeContents(node);
        const lines = [...range.getClientRects()];
        if (!lines.length || lines.some(rect => !rect.width || !rect.height || !inside(rect, frame))) errors.push(`field_${index}_outside`);
        for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) errors.push(`field_${index}_hidden`);
          const rect = ancestor.getBoundingClientRect();
          if (/(hidden|clip|scroll|auto)/.test(style.overflowX) && lines.some(line => line.left < rect.left - 1 || line.right > rect.right + 1)) errors.push(`field_${index}_clip_x`);
          if (/(hidden|clip|scroll|auto)/.test(style.overflowY) && lines.some(line => line.top < rect.top - 1 || line.bottom > rect.bottom + 1)) errors.push(`field_${index}_clip_y`);
          if (ancestor === poster) break;
        }
      });
      return { status: errors.length ? "failed" : "pass", field_count: nodes.length, errors: [...new Set(errors)] };
    }, target.expectedCopy);
    if (copyCheck.status !== "pass") {
      metrics.targets[target.id] = { copy_fidelity: copyCheck };
      console.error(`小红书 ${target.id} 文字未完整显示，请缩短该页或调整排版后重试（${copyCheck.errors.join(", ")}）。`);
      process.exitCode = 1;
      continue;
    }
  }
  metrics.targets[target.id] = await locator.evaluate((poster) => {
    const posterRect = poster.getBoundingClientRect();
    const nodes = [
      ...(poster.matches('[data-evidence="true"]') ? [poster] : []),
      ...poster.querySelectorAll('[data-evidence="true"]'),
    ];
    const rectangles = nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        left: Math.max(posterRect.left, rect.left),
        right: Math.min(posterRect.right, rect.right),
        top: Math.max(posterRect.top, rect.top),
        bottom: Math.min(posterRect.bottom, rect.bottom),
      };
    }).filter((rect) => rect.right > rect.left && rect.bottom > rect.top);

    const xEdges = [...new Set(rectangles.flatMap((rect) => [rect.left, rect.right]))].sort((a, b) => a - b);
    let evidenceArea = 0;
    for (let index = 0; index < xEdges.length - 1; index += 1) {
      const left = xEdges[index];
      const right = xEdges[index + 1];
      if (right <= left) continue;
      const intervals = rectangles
        .filter((rect) => rect.left < right && rect.right > left)
        .map((rect) => [rect.top, rect.bottom])
        .sort((a, b) => a[0] - b[0]);
      let coveredHeight = 0;
      let active = null;
      for (const interval of intervals) {
        if (!active || interval[0] > active[1]) {
          if (active) coveredHeight += active[1] - active[0];
          active = [...interval];
        } else {
          active[1] = Math.max(active[1], interval[1]);
        }
      }
      if (active) coveredHeight += active[1] - active[0];
      evidenceArea += (right - left) * coveredHeight;
    }

    const posterArea = Math.max(0, posterRect.width) * Math.max(0, posterRect.height);
    const round = (value) => Number(value.toFixed(6));
    const evidenceImages = [...new Set(nodes.flatMap((node) => [
      ...(node.matches?.("img") ? [node] : []),
      ...(node.querySelectorAll ? node.querySelectorAll("img") : []),
    ]))];
    const detailScores = evidenceImages.map((image) => {
      try {
        if (!image.complete || image.naturalWidth < 2 || image.naturalHeight < 2) return null;
        const size = 64;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return null;
        context.drawImage(image, 0, 0, size, size);
        const pixels = context.getImageData(0, 0, size, size).data;
        let sum = 0;
        let squared = 0;
        const buckets = new Set();
        const luminance = [];
        for (let index = 0; index < pixels.length; index += 4) {
          const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
          const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          luminance.push(y);
          sum += y;
          squared += y * y;
          buckets.add(`${r >> 4}:${g >> 4}:${b >> 4}`);
        }
        const mean = sum / luminance.length;
        const deviation = Math.sqrt(Math.max(0, squared / luminance.length - mean * mean));
        let edgeTotal = 0;
        let edgeCount = 0;
        for (let y = 0; y < size; y += 1) {
          for (let x = 0; x < size; x += 1) {
            const index = y * size + x;
            if (x + 1 < size) {
              edgeTotal += Math.abs(luminance[index] - luminance[index + 1]);
              edgeCount += 1;
            }
            if (y + 1 < size) {
              edgeTotal += Math.abs(luminance[index] - luminance[index + size]);
              edgeCount += 1;
            }
          }
        }
        const edgeMean = edgeCount ? edgeTotal / edgeCount : 0;
        const score = Math.min(
          1,
          (deviation / 64) * 0.5 + (edgeMean / 32) * 0.3 + Math.min(1, buckets.size / 64) * 0.2,
        );
        return round(score);
      } catch {
        return null;
      }
    }).filter((value) => typeof value === "number");
    return {
      poster_width: round(posterRect.width),
      poster_height: round(posterRect.height),
      poster_area: round(posterArea),
      evidence_area: round(evidenceArea),
      evidence_ratio: posterArea > 0 ? round(Math.min(1, evidenceArea / posterArea)) : 0,
      evidence_node_count: nodes.length,
      evidence_image_count: evidenceImages.length,
      evidence_detail_score: detailScores.length ? Math.max(...detailScores) : null,
    };
  });
  if (copyCheck) metrics.targets[target.id].copy_fidelity = copyCheck;
  if (copyCheck && await locator.getAttribute('data-native-layout') === 'editorial-v1') {
    const layout = await locator.evaluate(poster => {
      const frame = poster.getBoundingClientRect();
      const fields = [...poster.querySelectorAll('[data-approved-copy]')];
      const color = value => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const luminance = rgb => rgb.map(value => { const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      const paper = luminance(color(getComputedStyle(poster.querySelector('.native-stage')).backgroundColor));
      const rects = fields.map(node => node.getBoundingClientRect());
      const measurements = fields.map((node, i) => {
        const style = getComputedStyle(node);
        const ink = luminance(color(style.color));
        const contrast = (Math.max(paper, ink) + .05) / (Math.min(paper, ink) + .05);
        return { role: node.classList.contains('native-note') ? 'note' : node.classList.contains('native-title') ? 'title' : 'body', font_size: parseFloat(style.fontSize), contrast: Number(contrast.toFixed(3)),
          min_font: node.classList.contains('native-note') ? 36 : node.classList.contains('native-title') ? 48 : 42,
          opacity: Number(style.opacity), width: rects[i].width, height: rects[i].height };
      });
      const span = Math.max(...rects.map(r => r.bottom)) - Math.min(...rects.map(r => r.top));
      const margin = Math.min(...rects.flatMap(r => [r.left - frame.left, frame.right - r.right, r.top - frame.top, frame.bottom - r.bottom]));
      const overlapping = rects.some((r, i) => rects.slice(i + 1).some(other => r.bottom > other.top + 1 && other.bottom > r.top + 1 && r.right > other.left + 1 && other.right > r.left + 1));
      const hasEvidence = Boolean(poster.querySelector('.native-evidence'));
      const short = poster.classList.contains('native-short');
      const errors = [];
      if (frame.width !== 1080 || frame.height !== 1440) errors.push('dimensions');
      if (fields.length < 2 || fields.length > 5) errors.push('field_count');
      if (measurements.some(m => m.font_size < m.min_font - .1 || m.font_size > 144)) errors.push('font_size');
      if (measurements.some(m => m.contrast < (m.font_size >= 72 ? 3 : 4.5) || m.opacity < .95)) errors.push('contrast');
      if (margin < 56) errors.push('safe_margin');
      if (overlapping) errors.push('overlap');
      if (!hasEvidence && span < 288) errors.push('copy_too_small');
      if (!hasEvidence && short && Math.max(...measurements.map(m => m.font_size)) < 96) errors.push('short_copy_scale');
      return { schema:'echo-founder.native-card-layout.v1', status:errors.length ? 'blocked' : 'pass',
        mode:hasEvidence ? 'evidence' : 'text', short_copy:short, width:frame.width, height:frame.height,
        field_count:fields.length, text_span:span, safe_margin:margin, overlapping,
        fields:measurements, errors };
    });
    layout.copy_sha256 = createHash('sha256').update(target.expectedCopy.join(' ')).digest('hex');
    metrics.targets[target.id].native_layout = layout;
    if (layout.status !== 'pass') {
      console.error(`小红书 ${target.id} 排版未通过可读性检查，请调整文字或排版后重试（${layout.errors.join(', ')}）。`);
      process.exitCode = 1;
      continue;
    }
  }
  fs.mkdirSync(path.dirname(path.resolve(target.output)), { recursive: true });
  await locator.screenshot({
    path: path.resolve(target.output),
    animations: "disabled",
    caret: "hide",
    timeout: 60000,
  });
  console.log(`saved ${target.output}`);
}

const specParts = path.parse(path.resolve(specPath));
const metricsPath = path.resolve(spec.metrics || path.join(specParts.dir, `${specParts.name}.metrics.json`));
fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
fs.writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf-8");
console.log(`saved ${metricsPath}`);
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }
}
