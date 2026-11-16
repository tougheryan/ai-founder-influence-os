'use client';

import { useState, useCallback, useRef } from 'react';
import type { LLMConfig, RuntimeValidationResult } from '@/lib/types';

type StreamFailurePayload = {
  error?: unknown;
  displayMessage?: unknown;
  code?: unknown;
  debugId?: unknown;
};

type StreamQualityEvent = {
  type?: unknown;
  status?: unknown;
};

export function streamQualityWarning(event: StreamQualityEvent): string {
  if (event.type === 'language_quality' && event.status === 'review_required') {
    return '内容已经保存，但有几处表达偏模板化。发布前请再检查一次。';
  }
  if (event.type === 'release_gate' && event.status === 'review_required') {
    return '全部内容已经保存，但有几处需要你在发布前确认。';
  }
  return '';
}

export async function readUserFacingFailure(response: Response): Promise<string> {
  try {
    const payload = await response.json() as StreamFailurePayload;
    const message = typeof payload.error === 'string'
      ? payload.error.trim()
      : typeof payload.displayMessage === 'string'
        ? payload.displayMessage.trim()
        : '';
    return message || '暂时无法开始生成，请重试。';
  } catch {
    return '暂时无法开始生成，请重试。';
  }
}

interface AgentStreamState {
  isRunning: boolean;
  output: string;
  thinking: string;
  error: string | null;
  savedPath?: string;
  warning?: string;
  validation?: RuntimeValidationResult;
}

export interface AgentStreamResult {
  output: string;
  savedPath: string;
  validation?: RuntimeValidationResult;
}

export function useAgentStream() {
  const [state, setState] = useState<AgentStreamState>({
    isRunning: false,
    output: '',
    thinking: '',
    error: null,
  });
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef('');
  const outputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const invocationIdRef = useRef(0);

  const invoke = useCallback(
    async (
	      skill: string,
	      params: Record<string, unknown>,
      config: LLMConfig,
      onChunk?: (
        type: 'text' | 'thinking' | 'saved' | 'warning' | 'validation',
        content: string | RuntimeValidationResult
      ) => void
    ) => {
      const invocationId = invocationIdRef.current + 1;
      invocationIdRef.current = invocationId;
      if (outputFlushTimerRef.current !== null) {
        clearTimeout(outputFlushTimerRef.current);
        outputFlushTimerRef.current = null;
      }
      setState({ isRunning: true, output: '', thinking: '', error: null });
      outputRef.current = '';
      abortRef.current = new AbortController();
      let savedPath = '';
      let runtimeValidation: RuntimeValidationResult | undefined;
      let streamError = '';
      const requestedRuntimeStep = typeof params.runtimeStep === 'string' ? params.runtimeStep.trim() : '';
      const requestParams = { ...params };
      delete requestParams.runtimeStep;

      // Provider streams commonly arrive one or two tokens at a time. Updating
      // a full workbench on every chunk turns a long generation into thousands
      // of React renders, even when that screen does not show the raw stream.
      const flushOutput = () => {
        if (invocationIdRef.current !== invocationId) return;
        if (outputFlushTimerRef.current !== null) {
          clearTimeout(outputFlushTimerRef.current);
          outputFlushTimerRef.current = null;
        }
        setState((prev) => ({ ...prev, output: outputRef.current }));
      };
      const scheduleOutputFlush = () => {
        if (outputFlushTimerRef.current !== null) return;
        outputFlushTimerRef.current = setTimeout(flushOutput, 80);
      };

      try {
        const res = await fetch('/api/agent/invoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            skill,
            params: requestParams,
            config,
            ...(requestedRuntimeStep ? { runtimeStep: requestedRuntimeStep } : {}),
          }),
          signal: abortRef.current.signal,
        });

        if (!res.ok) {
          throw new Error(await readUserFacingFailure(res));
        }

        const reader = res.body?.getReader();
        const decoder = new TextDecoder();

        if (!reader) throw new Error('没有收到生成结果。请重试。');

	        let buffer = '';
		        const handleEvent = (data: string) => {
	          if (data === '[DONE]') return;
	          try {
	            const event = JSON.parse(data);
	            if (event.type === 'text') {
	              outputRef.current += event.content;
	              scheduleOutputFlush();
	              onChunk?.('text', event.content);
	            } else if (event.type === 'thinking') {
	              setState((prev) => ({ ...prev, thinking: prev.thinking + event.content }));
	              onChunk?.('thinking', event.content);
            } else if (event.type === 'saved') {
              savedPath = typeof event.path === 'string' ? event.path : '';
              setState((prev) => ({ ...prev, savedPath: event.path }));
              onChunk?.('saved', event.path);
		            } else if (event.type === 'warning') {
		              setState((prev) => ({ ...prev, warning: event.content }));
		              onChunk?.('warning', event.content);
		            } else if (event.type === 'language_quality' || event.type === 'release_gate') {
		              const warning = streamQualityWarning(event);
		              if (warning) {
		                setState((prev) => ({ ...prev, warning }));
		                onChunk?.('warning', warning);
		              }
		            } else if (event.type === 'validation') {
              const validation: RuntimeValidationResult = {
                path: typeof event.path === 'string' ? event.path : undefined,
                valid: event.valid === true,
                result: typeof event.result === 'object' && event.result !== null ? event.result : undefined,
                step: typeof event.result?.step === 'string' ? event.result.step : undefined,
              };
              runtimeValidation = validation;
              setState((prev) => ({ ...prev, validation }));
              onChunk?.('validation', validation);
	            } else if (event.type === 'error') {
	              streamError = typeof event.displayMessage === 'string'
	                ? event.displayMessage
	                : typeof event.content === 'string'
	                  ? event.content
	                  : '生成中断，请重试。';
	              setState((prev) => ({ ...prev, error: streamError }));
	            }
	          } catch {
	            // ignore malformed events
	          }
	        };

	        while (true) {
	          const { done, value } = await reader.read();
	          if (done) break;

	          buffer += decoder.decode(value, { stream: true });
	          const chunks = buffer.split('\n\n');
	          buffer = chunks.pop() || '';

	          for (const chunk of chunks) {
	            const line = chunk.split('\n').find((l) => l.startsWith('data: '));
	            if (line) handleEvent(line.slice(6));
	          }
	        }

	        if (buffer.trim()) {
	          const line = buffer.split('\n').find((l) => l.startsWith('data: '));
	          if (line) handleEvent(line.slice(6));
	        }

        flushOutput();

	        if (streamError) {
	          throw new Error(streamError);
	        }
        if (!savedPath) {
          throw new Error('生成已结束，但结果没有保存成功。请重试。');
        }

        setState((prev) => ({ ...prev, isRunning: false }));
        return { output: outputRef.current, savedPath, validation: runtimeValidation };
      } catch (e) {
        if (invocationIdRef.current === invocationId && outputFlushTimerRef.current !== null) {
          clearTimeout(outputFlushTimerRef.current);
          outputFlushTimerRef.current = null;
        }
        const message = e instanceof Error ? e.message : '生成中断，请重试。';
        if (message !== 'The operation was aborted.') {
          setState((prev) => ({ ...prev, isRunning: false, error: message }));
        } else {
          setState((prev) => ({ ...prev, isRunning: false }));
        }
        throw e;
      }
    },
    []
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { ...state, invoke, stop };
}
