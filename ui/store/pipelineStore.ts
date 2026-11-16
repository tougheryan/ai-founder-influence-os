import { create } from 'zustand';
import { PIPELINE_STEPS } from '@/lib/pipeline-state';
import { getRuntimeStepForStepId, getStepIdByRuntimeStep } from '@/lib/pipeline-registry';
import type { PipelineStep, LogEntry, LLMConfig } from '@/lib/types';

interface RuntimeStatus {
	  latest?: {
	    current_step: string | null;
	    latest_files: Record<string, string | null>;
	  };
	  sessionState?: Record<string, unknown>;
	  pipelineFiles?: Array<{ path: string; modifiedAt: string }>;
}

interface PipelineStore {
  steps: PipelineStep[];
  currentStep: number;
  status: 'idle' | 'running' | 'completed' | 'failed';
  jobId: string | null;

  startPipeline: () => void;
  resetPipeline: () => void;
  setStepStatus: (stepId: number, status: PipelineStep['status']) => void;
  setStepOutput: (stepId: number, output: unknown) => void;
  setStepInput: (stepId: number, input: Record<string, unknown>) => void;
  addStepLog: (stepId: number, entry: LogEntry) => void;
  setCurrentStep: (stepId: number) => void;
  markCompleted: () => void;
  markFailed: () => void;
  hydrateFromStatus: (status: RuntimeStatus) => void;
}

function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export const usePipelineStore = create<PipelineStore>((set) => ({
  steps: PIPELINE_STEPS.map((s) => ({ ...s, status: 'pending', logs: [] })),
  currentStep: 0,
  status: 'idle',
  jobId: null,

  startPipeline: () =>
    set({
      jobId: generateJobId(),
      status: 'running',
      currentStep: 1,
      steps: PIPELINE_STEPS.map((s) => ({
        ...s,
        status: s.id === 1 ? 'running' : 'pending',
        logs: s.id === 1 ? [{ time: new Date().toISOString(), level: 'info', message: '开始执行' }] : [],
      })),
    }),

  resetPipeline: () =>
    set({
      steps: PIPELINE_STEPS.map((s) => ({ ...s, status: 'pending', logs: [], output: undefined })),
      currentStep: 0,
      status: 'idle',
      jobId: null,
    }),

  setStepStatus: (stepId, status) =>
    set((state) => ({
      steps: state.steps.map((s) => (s.id === stepId ? { ...s, status } : s)),
    })),

  setStepOutput: (stepId, output) =>
    set((state) => ({
      steps: state.steps.map((s) => (s.id === stepId ? { ...s, output } : s)),
    })),

  setStepInput: (stepId, input) =>
    set((state) => ({
      steps: state.steps.map((s) => (s.id === stepId ? { ...s, input } : s)),
    })),

  addStepLog: (stepId, entry) =>
    set((state) => ({
      steps: state.steps.map((s) => (s.id === stepId ? { ...s, logs: [...s.logs, entry] } : s)),
    })),

  setCurrentStep: (stepId) => set({ currentStep: stepId }),

  markCompleted: () => set({ status: 'completed' }),

  markFailed: () => set({ status: 'failed' }),

  hydrateFromStatus: (status) =>
    set((state) => {
      const latestFiles = status.latest?.latest_files || {};
      const currentStepName = status.latest?.current_step;
      const currentStepFromRuntime = getStepIdByRuntimeStep(currentStepName);

      let maxCompleted = 0;
      let hasRunningStep = false;
      const steps = state.steps.map((s) => {
        const stepName = getRuntimeStepForStepId(s.id, latestFiles);
        const filePath = stepName ? latestFiles[stepName] : null;
        const isCurrent = currentStepFromRuntime === s.id;
        const isCompleted = !!filePath;
        const isRunning = isCurrent && !isCompleted;
        if (isCompleted && s.id > maxCompleted) maxCompleted = s.id;
        if (isRunning) hasRunningStep = true;

        const logs = [...s.logs];
        if (isCompleted && !logs.some((l) => l.message.includes('runtime'))) {
          logs.push({ time: new Date().toISOString(), level: 'success', message: `已从 runtime 加载产物：${filePath}` });
        }
        if (isRunning && !logs.some((l) => l.message.includes('当前步骤'))) {
          logs.push({ time: new Date().toISOString(), level: 'info', message: `当前步骤（runtime）：${stepName}` });
        }

        return {
          ...s,
          status: (isRunning ? 'running' : isCompleted ? 'completed' : 'pending') as PipelineStep['status'],
          output: filePath || undefined,
          logs,
        };
      });

      const currentStepId = currentStepFromRuntime || maxCompleted || 1;
      return {
        steps,
        currentStep: currentStepId,
        status: hasRunningStep ? 'running' : state.status === 'failed' ? 'failed' : 'idle',
      };
    }),
}));

interface ConfigStore {
  config: LLMConfig;
  setConfig: (config: Partial<LLMConfig>) => void;
}

const defaultConfig: LLMConfig = {
  provider: 'deepseek',
  apiKey: '',
  model: 'deepseek-v4-flash',
  baseUrl: '',
  temperature: 0.7,
  maxTokens: 8000,
};

export const useConfigStore = create<ConfigStore>((set) => ({
  config: defaultConfig,
  setConfig: (partial) => set((state) => ({ config: { ...state.config, ...partial } })),
}));
