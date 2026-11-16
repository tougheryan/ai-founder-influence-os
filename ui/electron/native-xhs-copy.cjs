"use strict";

// Pure text contract shared by the reader, local draft preparation and desktop send boundary.
const XHS_COPY_MISMATCH = "小红书发布文案与当前原稿不一致。请点击“重新整理成品”，核对完整正文和结尾问题后再确认。";

// Keep source offsets for editing. Comments and code samples cannot define fields.
function nativeVisible(text) {
  const mask = (value) => value.replace(/[^\r\n]/g, ' ');
  let visible = String(text).replace(/<!--[\s\S]*?(?:-->|$)/g, mask);
  let fence = null;
  visible = visible.replace(/[^\r\n]*(?:\r\n|\r|\n|$)/g, (line) => {
    const marker = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return mask(line);
    }
    return fence ? mask(line) : line;
  });
  return visible;
}
function nativeFieldSpans(text, labels) {
  const visible = nativeVisible(text);
  const boundaries = [];
  for (const line of visible.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (!line[0]) continue;
    const value = line[0].replace(/[\r\n]+$/, '');
    const heading = /^(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(value);
    const field = /^[ \t]*[-*][ \t]+(?:\*\*)?([^：:\r\n]{1,60}?)(?:\*\*)?[ \t]*[：:][ \t]*/.exec(value);
    if (heading) boundaries.push({ start: line.index, valueStart: line.index + line[0].length, label: heading[2].replace(/[：:][ \t]*$/, '').trim(), heading: true });
    else if (field) boundaries.push({ start: line.index, valueStart: line.index + field[0].length, label: field[1].trim(), heading: false });
  }
  return boundaries.flatMap((entry, index) => {
    if (!labels.includes(entry.label)) return [];
    const next = boundaries.slice(index + 1).find((item) => entry.label !== '正文' || item.heading || ['标题', '正文', '结尾问题'].includes(item.label));
    const end = next?.start ?? text.length;
    const raw = text.slice(entry.valueStart, end);
    const start = entry.valueStart + raw.length - raw.trimStart().length;
    const stop = Math.max(start, end - (raw.length - raw.trimEnd().length));
    return [{ label: entry.label, start, end: stop, text: text.slice(start, stop) }];
  });
}

function readNativeField(text, labels) {
  const fields = nativeFieldSpans(text, labels);
  if (fields.length > 1) throw new Error(`“${labels[0]}”重复或冲突，请保留一个明确值后再继续。`);
  const value = fields.length ? nativeVisible(text).slice(fields[0].start, fields[0].end).trim() : '';
  if (labels.some((label) => ['发布标题', '标题'].includes(label)) && /[\r\n]/.test(value)) throw new Error('发布标题包含多行文字，请保留一个明确标题。');
  return value;
}

function nativePlatforms(value) {
  const aliases = { '公众号': 'wechat', wechat: 'wechat', '小红书': 'xhs', xhs: 'xhs', xiaohongshu: 'xhs', '视频号': 'shipinhao', shipinhao: 'shipinhao' };
  const tokens = value.trim().split(/[\s,，、;；/|]+/).filter(Boolean);
  const platforms = tokens.map((token) => Object.hasOwn(aliases, token) ? aliases[token] : undefined);
  if (!tokens.length || platforms.some((platform) => !platform) || new Set(platforms).size !== platforms.length) {
    throw new Error('本期平台为空、重复或包含未知名称，请核对已选平台。');
  }
  return platforms;
}
function visibleText(markdown) {
  return String(markdown).replace(/\r\n?/g, "\n").replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "");
}
function headingSection(text, level, title) {
  const lines = text.split("\n");
  const starts = [];
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const marker = lines[index].match(/^[ \t]*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = lines[index].match(/^(#{1,6})[ \t]+(.+?)[ \t]*$/);
    if (heading) starts.push({ index, level: heading[1].length, title: heading[2] });
  }
  const matches = starts.filter((entry) => entry.level === level && title.test(entry.title));
  if (matches.length !== 1) throw new Error(XHS_COPY_MISMATCH);
  const start = matches[0];
  const end = starts.find((entry) => entry.index > start.index && entry.level <= level)?.index ?? lines.length;
  return lines.slice(start.index + 1, end).join("\n").trim();
}
function publishingFields(text) {
  return Object.fromEntries(['标题', '正文', '结尾问题'].map((label) => [label, readNativeField(text, [label])]));
}

function readNativeXhsCopy(markdown) {
  const visible = visibleText(markdown);
  const section = headingSection(visible, 2, /^2\.\s*小红书原生图文$/);
  const fields = publishingFields(headingSection(section, 3, /^发布正文$/));
  const tags = headingSection(section, 3, /^结尾标签$/);
  const title = fields["标题"], body = fields["正文"], question = fields["结尾问题"];
  if (!title || title.includes("\n") || !body || !question || !tags) throw new Error(XHS_COPY_MISMATCH);
  const publishingBody = body.endsWith(question) ? body : `${body}\n\n${question}`;
  return { title, body, question, tags, publishingBody, text: `${publishingBody}\n\n${tags}` };
}

function nativeXhsCopyMatches(markdown, prepared, payload) {
  try {
    const expected = readNativeXhsCopy(markdown);
    const normalizeTags = (value) => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
    return payload?.title === expected.title
      && normalizeTags(payload?.metadata?.tags) === normalizeTags(expected.tags)
      && String(prepared).replace(/\r\n?/g, "\n").trim() === expected.text;
  } catch { return false; }
}

module.exports = { readNativeXhsCopy, nativeXhsCopyMatches, XHS_COPY_MISMATCH, nativeFieldSpans, readNativeField, nativePlatforms };
