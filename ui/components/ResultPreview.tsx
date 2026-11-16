import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { RuntimeValidationResult } from '@/lib/types';

interface ResultPreviewProps {
  content: string;
  savedPath?: string;
  validation?: RuntimeValidationResult;
}

export function ResultPreview({ content, savedPath, validation }: ResultPreviewProps) {
  const isHtml = content.trim().startsWith('<');
  const safeContent = escapeHtml(content);
  const validationDetails = validation ? summarizeValidation(validation) : [];
  const hasValidationReviews = Boolean(validation?.valid && validationDetails.length > 0);

  return (
    <div className="overflow-hidden rounded-2xl border border-[rgba(28,28,30,0.08)] bg-white shadow-sm">
      <div className="border-b border-[rgba(28,28,30,0.08)] px-5 py-3 text-[12px] font-semibold uppercase tracking-wide text-[#6B6B6B]">
        执行结果
      </div>
      {savedPath && (
        <div className="border-b border-[rgba(28,28,30,0.08)] bg-[#FDF8F3] px-5 py-2 text-[13px] text-[#6B6B6B]">
          已保存到：
          <code className="text-[#E85D4C]">{savedPath}</code>
        </div>
      )}
      {validation && (
        <div className={`border-b px-5 py-3 text-[13px] ${
          validation.valid && !hasValidationReviews
            ? 'border-[rgba(47,125,85,0.16)] bg-[rgba(47,125,85,0.08)] text-[#2F7D55]'
            : validation.valid
              ? 'border-[rgba(179,116,31,0.18)] bg-[rgba(179,116,31,0.08)] text-[#8A5A16]'
            : 'border-[rgba(232,93,76,0.18)] bg-[rgba(232,93,76,0.07)] text-[#9B3328]'
        }`}>
          <div className="font-semibold">
            {validation.valid
              ? hasValidationReviews
                ? 'Runtime 校验通过，但需要复核'
                : 'Runtime 校验通过，可以进入下一步'
              : 'Runtime 校验未通过，需要返修后再推进'}
          </div>
          {validationDetails.length > 0 && (
            <ul className="mt-2 space-y-1 text-[12px] leading-5">
              {validationDetails.map((detail) => (
                <li key={detail}>- {detail}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Tabs defaultValue="preview" className="w-full">
        <TabsList className="m-5 gap-1 rounded-full border border-[rgba(28,28,30,0.08)] bg-[#FDF8F3] p-1">
          <TabsTrigger
            value="preview"
            className="rounded-full text-[14px] font-semibold text-[#6B6B6B] data-[state=active]:bg-[#1C1C1E] data-[state=active]:text-white"
          >
            预览
          </TabsTrigger>
          <TabsTrigger
            value="raw"
            className="rounded-full text-[14px] font-semibold text-[#6B6B6B] data-[state=active]:bg-[#1C1C1E] data-[state=active]:text-white"
          >
            原始 Markdown
          </TabsTrigger>
        </TabsList>
        <TabsContent value="preview" className="mt-0">
          <ScrollArea className="h-96">
            <div
              className="prose max-w-none p-5 text-[16px] leading-[1.6] text-[#1A1A1A]"
              dangerouslySetInnerHTML={{
                __html: isHtml ? `<pre class="whitespace-pre-wrap">${safeContent}</pre>` : renderMarkdown(safeContent),
              }}
            />
          </ScrollArea>
        </TabsContent>
        <TabsContent value="raw" className="mt-0">
          <ScrollArea className="h-96">
            <pre className="whitespace-pre-wrap p-5 text-[14px] text-[#6B6B6B]">
              {content}
            </pre>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function summarizeValidation(validation: RuntimeValidationResult): string[] {
  const result = validation.result || {};
  const fields = [
    ['missing_frontmatter', '缺少 frontmatter'],
    ['missing_patterns', '缺少必需章节'],
    ['missing_sections', '缺少必需章节'],
    ['quality_errors', '质量阻断'],
    ['quality_reviews', '需要复核'],
  ] as const;

  const details: string[] = [];
  for (const [key, label] of fields) {
    const value = result[key];
    if (!Array.isArray(value) || value.length === 0) continue;
    const items = value.map((item) => String(item)).slice(0, 3).join('；');
    const suffix = value.length > 3 ? ` 等 ${value.length} 项` : '';
    details.push(`${label}：${items}${suffix}`);
  }

  if (result.step_invalid) details.push('frontmatter 中的 step 与当前步骤不一致');
  return details.slice(0, 4);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdown(md: string): string {
  return md
    .replace(/### (.*)/g, '<h3 class="text-[#1A1A1A]">$1</h3>')
    .replace(/## (.*)/g, '<h2 class="text-[#1A1A1A]">$1</h2>')
    .replace(/# (.*)/g, '<h1 class="text-[#1A1A1A]">$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong class="text-[#1A1A1A]">$1</strong>')
    .replace(/\*(.*?)\*/g, '<em class="text-[#6B6B6B]">$1</em>')
    .replace(/`([^`]+)`/g, '<code class="bg-[#FDF8F3] px-1 text-[#1A1A1A]">$1</code>')
    .replace(/\n/g, '<br />');
}
