'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { Play, Square, Sparkles, Loader2, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAgentStream } from '@/hooks/useAgentStream';
import { LogViewer } from './LogViewer';
import { ResultPreview } from './ResultPreview';
import type { PipelineStep, SkillParameter, LLMConfig, FileItem, RuntimeValidationResult } from '@/lib/types';
import { SKILL_NAMES } from '@/lib/pipeline-state';

type ParamValue = string | number | boolean | string[] | undefined;
type ParamMap = Record<string, ParamValue>;

interface AgentExecutorProps {
  step: PipelineStep;
  config: LLMConfig;
  parameters: SkillParameter[];
  initialParams?: Record<string, unknown>;
  initialJobName?: string;
  compact?: boolean;
  autoRunToken?: number;
  beforeRun?: (params: Record<string, unknown>) => boolean | Promise<boolean>;
  onStart?: (params: Record<string, unknown>) => void;
  onComplete?: (output: string, validation?: RuntimeValidationResult, stepId?: number) => void;
  onSaved?: (path: string) => void;
  onLog?: (message: string, level?: 'info' | 'warning' | 'error' | 'success') => void;
}

function generateSlug(text: string): string {
  if (!text || text.length < 2) return '';
  const englishWords = text.match(/[a-zA-Z]+/g);
  if (englishWords && englishWords.length >= 3) {
    return englishWords.slice(0, 6).join('-').toLowerCase();
  }
  const chineseChars = text.replace(/[^一-龥]/g, '').slice(0, 10);
  if (chineseChars) return chineseChars;
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 30);
}

function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function AgentExecutor({
  step,
  config,
  parameters,
  initialParams,
  initialJobName,
  compact = false,
  autoRunToken,
  beforeRun,
  onStart,
  onComplete,
  onSaved,
  onLog,
}: AgentExecutorProps) {
  const defaultParams = useMemo(() => {
    const defaults: ParamMap = {};
    parameters.forEach((p) => {
      if (p.default !== undefined) defaults[p.name] = p.default as ParamValue;
    });
    return defaults;
  }, [parameters]);

  const [paramOverrides, setParamOverrides] = useState<ParamMap>({});
  const [jobNameOverride, setJobNameOverride] = useState('');
  const [materials, setMaterials] = useState<FileItem[]>([]);
  const [materialLoading, setMaterialLoading] = useState(false);
  const runInFlightRef = useRef(false);

  const { isRunning, output, thinking, error, savedPath, warning, validation, invoke, stop } = useAgentStream();

  const params = useMemo<ParamMap>(
    () => ({ ...defaultParams, ...(initialParams as ParamMap | undefined), ...paramOverrides }),
    [defaultParams, initialParams, paramOverrides]
  );
  const runParams = useMemo<ParamMap>(() => {
    const cleaned: ParamMap = {};
    Object.entries(params).forEach(([key, value]) => {
      cleaned[key] = value === '__empty__' ? undefined : value;
    });
    return cleaned;
  }, [params]);

  const generatedJobName = useMemo(() => {
    const firstTextParam = parameters.find((p) => p.type === 'textarea' || p.type === 'string');
    if (!firstTextParam) return '';
    const value = params[firstTextParam.name];
    return typeof value === 'string' && value.length >= 5 ? generateSlug(value) : '';
  }, [params, parameters]);

  const jobName = jobNameOverride || initialJobName || generatedJobName;

  useEffect(() => {
    if (error) {
      onLog?.(error, 'error');
    }
  }, [error, onLog]);

  useEffect(() => {
    if (warning) {
      onLog?.(warning, 'warning');
    }
  }, [warning, onLog]);

  useEffect(() => {
    if (savedPath) {
      onLog?.(`已保存到 ${savedPath}`, 'success');
    }
  }, [savedPath, onLog]);

  useEffect(() => {
    const materialParams = parameters.filter((p) => p.type === 'material');
    if (materialParams.length === 0) return;

    async function loadMaterials() {
      setMaterialLoading(true);
      try {
        const requests = materialParams.map(async (p) => {
          const categories = (p.materialCategory || 'materials')
            .split(',')
            .map((category) => category.trim())
            .filter(Boolean);
          const categoryRequests = categories.map(async (category) => {
            const isPipeline = category === 'pipeline' || category.startsWith('pipeline/');
            const stage = category === 'pipeline' ? '' : category.replace('pipeline/', '');
            const url = isPipeline
              ? `/api/materials?source=pipeline${stage ? `&stage=${encodeURIComponent(stage)}` : ''}`
              : `/api/materials${category !== 'materials' ? `?type=${encodeURIComponent(category.replace('materials/', ''))}` : ''}`;
            const res = await fetch(url);
            const data = await res.json();
            return data.items || [];
          });
          return (await Promise.all(categoryRequests)).flat();
        });
        const results = await Promise.all(requests);
        const merged = results
          .flat()
          .filter((item, index, self) => self.findIndex((i) => i.path === item.path) === index);
        setMaterials(merged);
      } catch {
        onLog?.('加载文件列表失败', 'warning');
      } finally {
        setMaterialLoading(false);
      }
    }

    loadMaterials();
  }, [parameters, onLog]);

  const handleRun = async () => {
    if (!step.skill) return;
    if (isRunning || runInFlightRef.current) {
      onLog?.('已有任务正在执行，请先停止或等待完成', 'warning');
      return;
    }

    const displayName = SKILL_NAMES[step.skill] || step.skill;

    if (!jobName.trim()) {
      onLog?.('请填写任务名称，用于保存输出文件', 'error');
      return;
    }

    const missingRequired = parameters.filter((p) => {
      const value = runParams[p.name];
      return p.required && (value === undefined || value === '' || (Array.isArray(value) && value.length === 0));
    });
    if (missingRequired.length > 0) {
      onLog?.(`请填写必填项：${missingRequired.map((p) => p.label).join('、')}`, 'error');
      return;
    }

    if (beforeRun && !(await beforeRun(runParams))) return;

    onLog?.(`开始执行 ${displayName}`, 'info');
    const runningStepId = step.id;

    try {
      runInFlightRef.current = true;
      onStart?.(runParams);
      const result = await invoke(step.skill, { ...runParams, slug: jobName.trim() }, config, (type, content) => {
        void type;
        void content;
      });
      const runtimeValidation = result.validation;
      if (runtimeValidation?.valid === false) {
        onLog?.('执行完成，但 runtime 校验未通过，请返修后再推进', 'warning');
      } else if (runtimeValidation?.valid === true) {
        onLog?.('执行完成，runtime 校验通过', 'success');
      } else {
        onLog?.('执行完成，但未收到 runtime 校验结果，请人工确认后再推进', 'warning');
      }
      if (runtimeValidation?.valid !== false) {
        onSaved?.(result.savedPath);
      }
      onComplete?.(result.output, runtimeValidation, runningStepId);
    } catch (e) {
      const message = e instanceof Error ? e.message : '执行失败';
      onLog?.(message, 'error');
    } finally {
      runInFlightRef.current = false;
    }
  };

  useEffect(() => {
    if (!autoRunToken) return;
    if (isRunning) return;
    void handleRun();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRunToken]);

  const inputClass =
    'min-h-12 h-12 px-4 border border-[rgba(28,28,30,0.1)] bg-white text-[#1A1A1A] placeholder:text-[#9A9A9A] focus:border-[#E85D4C] focus-visible:ring-0 focus-visible:ring-offset-0 rounded-xl disabled:cursor-not-allowed disabled:bg-[#F7F7F7] disabled:text-[#9A9A9A] disabled:opacity-80';

  const textareaClass =
    'border border-[rgba(28,28,30,0.1)] bg-white text-[#1A1A1A] placeholder:text-[#9A9A9A] focus:border-[#E85D4C] focus-visible:ring-0 focus-visible:ring-offset-0 rounded-xl resize-none px-4 py-3 disabled:cursor-not-allowed disabled:bg-[#F7F7F7] disabled:text-[#9A9A9A] disabled:opacity-80';

  const optionLabel = (value: string): string => {
    const map: Record<string, string> = {
      wechat: '公众号',
      xiaohongshu: '小红书',
      all: '全部',
      auto: '自动识别',
      personal: '个人履历',
      interview: '访谈演讲',
      growth: '个人成长',
      business: '业务获客',
      global: '全球化',
      illustration: '内容配图',
      'wechat-cover': '公众号封面',
      'xiaohongshu-cover': '小红书封面',
      'xiaohongshu-graphic': '小红书图文',
      xiaohei: '小黑手绘',
      magazine: '杂志风',
      swiss: '瑞士风',
      readonly: '只读观察',
      'show-dna': '显示 DNA',
      'list-patterns': '列出模式',
      evolution: '进化追踪',
    };
    return map[value] || value;
  };

  const renderField = (param: SkillParameter) => {
    const value = params[param.name] ?? '';

    switch (param.type) {
      case 'textarea':
        return (
          <Textarea
            key={param.name}
            value={String(value || '')}
            onChange={(e) => setParamOverrides((prev) => ({ ...prev, [param.name]: e.target.value }))}
            placeholder={param.placeholder}
            rows={5}
            disabled={isRunning}
            className={`${textareaClass}`}
          />
        );
      case 'number':
        return (
          <Input
            key={param.name}
            type="number"
            value={typeof value === 'number' ? value : String(value || '')}
            onChange={(e) => setParamOverrides((prev) => ({ ...prev, [param.name]: Number(e.target.value) }))}
            placeholder={param.placeholder}
            disabled={isRunning}
            className={inputClass}
          />
        );
      case 'select':
        return (
          <Select
            key={param.name}
            value={String(value || param.default || '')}
            onValueChange={(v) => setParamOverrides((prev) => ({ ...prev, [param.name]: String(v) }))}
            disabled={isRunning}
          >
            <SelectTrigger className={`${inputClass}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="rounded-xl border border-[rgba(28,28,30,0.1)] bg-white">
              {param.options?.map((opt) => (
                <SelectItem key={opt} value={opt} className="text-[#1A1A1A] focus:bg-[#FDF8F3]">
                  {optionLabel(opt)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      case 'boolean':
        return (
          <label key={param.name} className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={!!value}
              onChange={(e) => setParamOverrides((prev) => ({ ...prev, [param.name]: e.target.checked }))}
              disabled={isRunning}
              className="h-5 w-5 accent-[#E85D4C] rounded border-[rgba(28,28,30,0.2)]"
            />
            <span className="text-[14px] text-[#6B6B6B]">{param.placeholder || '启用'}</span>
          </label>
        );
      case 'multi-select':
        return (
          <div key={param.name} className="flex flex-wrap gap-3">
            {param.options?.map((opt) => {
              const selected = Array.isArray(value) ? value : [];
              const isSelected = selected.includes(opt);
              return (
                <label
                  key={opt}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-[14px] transition-colors ${
                    isSelected
                      ? 'border-[#E85D4C] bg-[rgba(232,93,76,0.08)] text-[#E85D4C]'
                      : 'border-[rgba(28,28,30,0.1)] bg-white text-[#6B6B6B]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={(e) => {
                      const current = Array.isArray(params[param.name]) ? (params[param.name] as string[]) : [];
                      const next = e.target.checked
                        ? [...current, opt]
                        : current.filter((v: string) => v !== opt);
                      setParamOverrides((prev) => ({ ...prev, [param.name]: next }));
                    }}
                    disabled={isRunning}
                    className="h-4 w-4 accent-[#E85D4C]"
                  />
                  {optionLabel(opt)}
                </label>
              );
            })}
          </div>
        );
      case 'material':
        return (
          <div key={param.name} className="space-y-2">
            <Select
              value={String(value || '')}
              onValueChange={(v) => setParamOverrides((prev) => ({ ...prev, [param.name]: String(v) }))}
              disabled={materialLoading || isRunning}
            >
              <SelectTrigger className={`${inputClass}`}>
                <SelectValue placeholder={materialLoading ? '加载文件中...' : '选择文件...'} />
              </SelectTrigger>
              <SelectContent className="rounded-xl border border-[rgba(28,28,30,0.1)] bg-white max-h-72">
                {materials.length === 0 && (
                  <SelectItem value="__empty__" disabled className="text-[#9A9A9A]">
                    暂无可用文件
                  </SelectItem>
                )}
                {materials.map((item) => (
                  <SelectItem
                    key={item.path}
                    value={item.path}
                    className="text-[#1A1A1A] focus:bg-[#FDF8F3]"
                  >
                    <span className="flex items-center gap-2">
                      <FileText size={14} />
                      <span className="truncate max-w-[320px]">{item.name}</span>
                      <span className="text-[#9A9A9A] text-[12px]">{formatBytes(item.size)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      default:
        return (
          <Input
            key={param.name}
            value={String(value || '')}
            onChange={(e) => setParamOverrides((prev) => ({ ...prev, [param.name]: e.target.value }))}
            placeholder={param.placeholder}
            disabled={isRunning}
            className={inputClass}
          />
        );
    }
  };

  if (!step.skill) {
    return (
      <div className="rounded-2xl border border-[rgba(28,28,30,0.08)] bg-white p-8 shadow-sm">
        <p className="text-[#6B6B6B]">此步骤无需调用 Agent。{step.description}</p>
      </div>
    );
  }

  const configReady = !!(config.apiKey || config.hasSavedKey || config.hasEnvKey);
  const previewOutput = output || stringifyOutput(step.output);

  return (
    <div className={compact ? "space-y-[12px]" : "space-y-6"} aria-busy={isRunning}>
      <div className={compact ? "rounded-[16px] border border-[rgba(28,28,30,0.08)] bg-[#FDF8F3] p-[14px]" : "rounded-2xl border border-[rgba(28,28,30,0.08)] bg-white p-8 shadow-sm"}>
        <div className={compact ? "mb-[14px] flex flex-col gap-[10px] sm:flex-row sm:items-center sm:justify-between" : "mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"}>
          <div className="flex items-center gap-4">
            <div className={compact ? "flex h-9 w-9 items-center justify-center rounded-[10px] bg-white text-[#E85D4C]" : "flex h-11 w-11 items-center justify-center rounded-xl bg-[rgba(232,93,76,0.1)] text-[#E85D4C]"}>
              <Sparkles size={compact ? 17 : 20} />
            </div>
            <div>
              <div className={compact ? "text-[15px] font-bold text-[#1A1A1A]" : "text-[18px] font-semibold text-[#1A1A1A]"}>
                {SKILL_NAMES[step.skill] || step.skill}
              </div>
              <div className={compact ? "mt-[2px] text-[12px] text-[#6B6B6B]" : "text-[14px] text-[#6B6B6B]"}>{step.description}</div>
            </div>
          </div>

          <Button
            onClick={isRunning ? stop : handleRun}
            disabled={isRunning ? false : !configReady || materialLoading}
            className={isRunning
              ? 'rounded-full border border-[#1C1C1E] bg-[#1C1C1E] px-5 py-2 text-[14px] font-semibold text-white hover:bg-[#6B6B6B]'
              : 'rounded-full bg-[#E85D4C] px-5 py-2 text-[14px] font-semibold text-white transition-opacity hover:opacity-90'
            }
          >
            {isRunning ? (
              <>
                <Square size={16} className="mr-1" />
                停止
              </>
            ) : (
              <>
                <Play size={16} className="mr-1" />
                执行
              </>
            )}
          </Button>
        </div>

        {!configReady && (
          <div className="mb-6 rounded-xl border border-[rgba(232,93,76,0.2)] bg-[rgba(232,93,76,0.05)] p-4 text-[14px] text-[#E85D4C]">
            未配置 API Key，请在<a href="/settings" className="underline">设置页面</a>配置，或设置环境变量。
          </div>
        )}

        {isRunning && (
          <div className="mb-6 rounded-xl border border-[rgba(28,28,30,0.08)] bg-[#FDF8F3] p-4 text-[14px] text-[#6B6B6B]">
            当前任务执行中，参数已锁定。本次结果写入 runtime 并完成校验后才会接入下一步。
          </div>
        )}

        <div className={compact ? "space-y-[10px]" : "space-y-5"}>
          <div className={compact ? "rounded-[13px] border border-[rgba(28,28,30,0.08)] bg-white px-[10px] py-[9px]" : ""}>
            <Label className="mb-2 block text-[14px] font-normal text-[#6B6B6B]">
              {compact ? "保存名" : "任务名称"}
              <span className="text-[#E85D4C]"> *</span>
            </Label>
            <Input
              value={jobName}
              onChange={(e) => setJobNameOverride(e.target.value)}
              placeholder="用于保存输出文件，例如 ai-founder-content-strategy"
              disabled={isRunning}
              className={inputClass}
            />
            <p className="mt-1.5 text-[12px] text-[#9A9A9A]">
              未填写时将自动从首个文本框内容生成
            </p>
          </div>

          {parameters.map((param) => (
            <div key={param.name}>
              <Label className="mb-2 block text-[14px] font-normal text-[#6B6B6B]">
                {param.label}
                {param.required && <span className="text-[#E85D4C]"> *</span>}
              </Label>
              {renderField(param)}
            </div>
          ))}
        </div>
      </div>

      {isRunning && thinking && (
        <div className="rounded-2xl border border-[rgba(28,28,30,0.08)] bg-white p-5 shadow-sm">
          <div className="mb-2 flex items-center gap-2 text-[14px] text-[#6B6B6B]">
            <Loader2 size={14} className="animate-spin" />
            思考中
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-[14px] text-[#6B6B6B]">
            {thinking}
          </pre>
        </div>
      )}

      <LogViewer logs={step.logs} />

      {previewOutput && (
        <ResultPreview content={previewOutput} savedPath={savedPath} validation={validation} />
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
