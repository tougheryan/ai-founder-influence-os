const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readNativeXhsCopy, nativeXhsCopyMatches } = require('./native-xhs-copy.cjs');

const source = `---
private: metadata
---
## 2. 小红书原生图文
### 发布正文
- 标题：先确认新增项
- 正文：第一段。

第二段。

- 注意：这是正文中的普通列表，必须保留。

第三段。
- 结尾问题：你会怎样确认？
### 结尾标签
#设计 #客户沟通
## 3. 视频号原生口播
这段不能混入。
`;
const body = '第一段。\n\n第二段。\n\n- 注意：这是正文中的普通列表，必须保留。\n\n第三段。';
const expected = `${body}\n\n你会怎样确认？\n\n#设计 #客户沟通`;
const payload = { title: '先确认新增项', metadata: { tags: '#设计 #客户沟通' } };

test('preserves full paragraphs and ordinary lists and includes closing question once', () => {
  const result = readNativeXhsCopy(source);
  assert.equal(result.body, body);
  assert.equal(result.text, expected);
  assert.equal(readNativeXhsCopy(source.replace('第三段。', '第三段。\n\n你会怎样确认？')).text, expected);
});
test('ignores private comments and normalizes CRLF without changing public copy', () => {
  assert.equal(readNativeXhsCopy(source.replace('第二段。', '<!-- 内部备注 -->第二段。').replaceAll('\n', '\r\n')).text, expected);
  assert.equal(nativeXhsCopyMatches(source, `${expected}\r\n`, payload), true);
});
test('rejects truncation, duplicate questions, internal instructions, or different title/tags', () => {
  for (const copy of ['第一段。', expected.replace('你会怎样确认？\n\n', ''), `${expected}\n你会怎样确认？`, `${expected}\n上传说明：pipeline/private.png`]) {
    assert.equal(nativeXhsCopyMatches(source, copy, payload), false);
  }
  assert.equal(nativeXhsCopyMatches(source, expected, { ...payload, title: '改过的标题' }), false);
  assert.equal(nativeXhsCopyMatches(source, expected, { ...payload, metadata: { tags: '#新标签' } }), false);
});
test('fails closed for ambiguous or incomplete source contracts', () => {
  for (const broken of [source + source, source.replace('- 标题：先确认新增项', '- 标题：先确认新增项\n- 标题：另一个'), source.replace('- 结尾问题：你会怎样确认？', ''), source.replace('#设计 #客户沟通', '')]) {
    assert.throws(() => readNativeXhsCopy(broken));
    assert.equal(nativeXhsCopyMatches(broken, expected, payload), false);
  }
});
