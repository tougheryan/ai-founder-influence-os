"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfigStore } from "@/store/pipelineStore";
import { CurrentDraftCallHistory } from "@/components/production/ProductionCallHistory";
import { LayoutCallHistory } from "@/components/LayoutCallHistory";
import { ServiceCostNotice } from "@/components/ServiceCostNotice";
import { ModelAccountGuide } from "@/components/ModelAccountGuide";
import { CommercialAcceptancePanel } from "@/components/CommercialAcceptancePanel";
import type { CommercialAcceptanceStatus, CommercialServiceStatus } from "@/lib/commercial-acceptance-status";
import type { BrandTemplate } from "@/lib/brand-templates";
import { PublicationBridgeSettings } from "@/components/PublicationBridgeSettings";
import { ProjectBackupSettings } from "@/components/ProjectBackupSettings";
import { TikOmniSettings } from "@/components/TikOmniSettings";
import { DesktopFirstRunGuide } from "@/components/DesktopFirstRunGuide";
import { Md2WechatThemePreview } from "@/components/Md2WechatThemePreview";
import { Md2WechatThemeBrowser } from "@/components/Md2WechatThemeBrowser";
import { Md2WechatThemeComparison } from "@/components/Md2WechatThemeComparison";
import { useMd2WechatThemePreferences } from "@/hooks/useMd2WechatThemePreferences";
import { toggleMd2WechatThemeComparison } from "@/lib/md2wechat-theme-directory";
import { HostedAccessPanel } from "@/components/HostedAccessPanel";
import { LicenseStatusBanner } from "@/components/LicenseStatusBanner";
import { PROVIDER_PRESETS } from "@/lib/llm-client";
import { displayClientError } from "@/lib/client-error-copy";
import { MACOS_KEYCHAIN_EXPLANATION, PRODUCT_COPY, PRODUCT_VERSION_DISPLAY, } from "@/lib/product-copy";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Download,
  Eye,
  EyeOff,
  FolderCheck,
  KeyRound,
  Loader2,
  MonitorCheck,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Trash2,
  XCircle,
} from "lucide-react";

const PARAM_PRESETS = [
  { id: "stable", label: "稳定型", temperature: 0.3, maxTokens: 6000, desc: "更适合审核、复盘、结构化输出" },
  { id: "creative", label: "创作型", temperature: 0.8, maxTokens: 8000, desc: "更适合标题、角度、内容发散" },
  { id: "longform", label: "长文型", temperature: 0.7, maxTokens: 16000, desc: "更适合公众号长文与深度报告" },
];

type TestState = { checkedAt?: string } & (
  | { status: "idle"; message: string }
  | { status: "testing"; message: string }
  | { status: "success"; message: string; latencyMs?: number; model?: string }
  | { status: "error"; message: string });

type DiagnosticStatus = "pass" | "warn" | "fail";

type DiagnosticItem = {
  id: string;
  label: string;
  status: DiagnosticStatus;
  version?: string;
  detail?: string;
};

type DesktopDiagnostics = {
  status: DiagnosticStatus;
  summary: string;
  checkedAt: string;
  project: { name: string; path: string };
  runtime: {
    isDesktop: boolean;
    singleInstance: string;
    nodeEnv: string;
    serverMode: string;
    pythonBinary: string;
    pythonSource: string;
    pythonVersion: string;
    nodeBinary: string;
    nextDistDir: string;
    projectSource: string;
    desktopSettingsPath: string;
    desktopParentPid: string;
    desktopParentAlive: boolean | null;
    serviceRestartCount: string;
    serviceStartedAt: string;
    serviceLastExit: string;
    serviceRestartMax: string;
    serviceWatchdogEnabled: string;
    serviceWatchdogFailureCount: string;
    serviceWatchdogThreshold: string;
    serviceWatchdogRestartCount: string;
    serviceWatchdogIntervalMs: string;
    serviceWatchdogTimeoutMs: string;
    electronVersion: string;
    electronAppVersion: string;
  };
  llm: {
    status: DiagnosticStatus;
    provider: string;
    model: string;
    keySource: string;
    envKeyName: string;
  };
  tools: DiagnosticItem[];
  paths: DiagnosticItem[];
  recommendedActions: string[];
};

type DesktopReleaseGateStatus = "pass" | "warn" | "blocked" | "missing";

type DesktopReleaseGate = {
  id: string;
  label: string;
  status: DesktopReleaseGateStatus;
  detail: string;
  reportPath?: string;
};

type DesktopReleaseReadiness = {
  status: "external_ready" | "internal_ready_external_blocked" | "needs_attention" | "missing_reports" | "fail";
  checkedAt: string;
  summary: string;
  internalReady: boolean;
  externalReady: boolean;
  externalBlockers: string[];
  gates: DesktopReleaseGate[];
  recommendedActions: string[];
  commercialAcceptance?: CommercialAcceptanceStatus;
  reports: {
    releaseAssessment: null | {
      checkedAt: string;
      status: string;
      blockers: string[];
      app: { exists: boolean; bundleId: string; version: string };
      dmg: { exists: boolean; sha256: string; sizeBytes: number | null };
      signing: { signatureKind: string; developerId: boolean; hardenedRuntime: boolean };
    };
    notarization: null | {
      checkedAt: string;
      status: string;
      blockers: string[];
    };
    releaseGate: null | {
      checkedAt: string;
      status: string;
      mode: string;
      durationSeconds: number | null;
      failedSteps: unknown[];
    };
    packagedSoak: null | {
      checkedAt: string;
      status: string;
      iterations: number | null;
      actualDurationSeconds: number | null;
      portClosed: boolean;
      failures: number;
    };
  };
};

function SettingsPageContent() {
  const { config, setConfig } = useConfigStore();
  const [localConfig, setLocalConfig] = useState(config);
  const [configLoading, setConfigLoading] = useState(true);
  const isFirstRun = useSearchParams().get("firstRun") === "1";
  const showDiagnostics = useSearchParams().get("diagnostics") === "1";
  const [showKey, setShowKey] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [desktopCredentialVault, setDesktopCredentialVault] = useState(false);
  const [removeLlmCredential, setRemoveLlmCredential] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [testState, setTestState] = useState<TestState>({ status: "idle", message: "保存设置后，请测试一次连接。" });
  const [desktopDiagnostics, setDesktopDiagnostics] = useState<DesktopDiagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsExporting, setDiagnosticsExporting] = useState(false);
  const [releaseReadiness, setReleaseReadiness] = useState<DesktopReleaseReadiness | null>(null);
  const [releaseReadinessLoading, setReleaseReadinessLoading] = useState(false);
  const [commercialServices, setCommercialServices] = useState<CommercialServiceStatus | null>(null);
  const [commercialAcceptanceLoading, setCommercialAcceptanceLoading] = useState(false);
  const [brandTemplates, setBrandTemplates] = useState<BrandTemplate[]>([]);
  const [brandTemplatesLoading, setBrandTemplatesLoading] = useState(true);
  const [brandTemplatesError, setBrandTemplatesError] = useState<string | null>(null);

  useEffect(() => {
    if (!showDiagnostics || configLoading || brandTemplatesLoading) return;
    const frame = requestAnimationFrame(() => document.getElementById('desktop-diagnostics')?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, [showDiagnostics, configLoading, brandTemplatesLoading]);

  const loadBrandTemplates = useCallback(async () => {
    setBrandTemplatesLoading(true);
    setBrandTemplatesError(null);
    try {
      const res = await fetch("/api/brand-templates", { cache: "no-store" });
      const data = await res.json().catch(() => ({})) as { templates?: BrandTemplate[]; error?: string };
      if (!res.ok || !Array.isArray(data.templates)) throw new Error(data.error || "读取品牌模板失败");
      setBrandTemplates(data.templates);
    } catch (error) {
      setBrandTemplatesError(displayClientError(error, "排版样式没有读取成功。请刷新后重试。"));
    } finally {
      setBrandTemplatesLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => {
        if (data.config) {
          setConfig(data.config);
          setLocalConfig(data.config);
        }
      })
      .catch(() => {
        // ignore config bootstrap errors; form remains editable.
      })
      .finally(() => {
        setConfigLoading(false);
      });
  }, [setConfig]);

  useEffect(() => {
    if (configLoading) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const readTest = async () => {
      try {
        const response = await fetch('/api/config/test', { cache: 'no-store', signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error('record unavailable');
        if (cancelled) return;
        const record = payload.record;
        if (!record) setTestState({ status: 'idle', message: '当前设置还没有连接测试记录。' });
        else if (!payload.matchesCurrentSettings) setTestState({ status: 'idle', message: '已有测试属于其他模型、服务地址或密钥；当前设置尚未测试。' });
        else {
          setTestState({ status: record.status === 'success' ? 'success' : record.status === 'running' ? 'testing' : 'error', message: record.message, checkedAt: record.completedAt || record.startedAt, ...(record.status === 'success' ? { latencyMs: record.latencyMs, model: record.model } : {}) });
          if (record.status === 'running') timer = setTimeout(readTest, 2_000);
        }
      } catch { if (!cancelled) setTestState({ status: 'idle', message: '上次测试记录暂时无法读取；这不代表模型连接失败。' }); }
    };
    void readTest();
    return () => { cancelled = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [config, configLoading]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDesktopCredentialVault(Boolean(window.aifiosCredentials));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadBrandTemplates();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadBrandTemplates]);

  const fetchDesktopDiagnostics = useCallback(async (): Promise<DesktopDiagnostics> => {
    try {
      const res = await fetch("/api/desktop/diagnostics", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "桌面环境诊断失败");
      return data;
    } catch (error) {
      const message = displayClientError(error, "桌面环境没有检查成功。请重新检查。");
      return {
        status: "fail",
        summary: message,
        checkedAt: new Date().toISOString(),
        project: { name: "-", path: "-" },
        runtime: {
          isDesktop: false,
          singleInstance: "",
          nodeEnv: "-",
          serverMode: "",
          pythonBinary: "",
          pythonSource: "",
          pythonVersion: "",
          nodeBinary: "",
          nextDistDir: "",
          projectSource: "",
          desktopSettingsPath: "",
          desktopParentPid: "",
          desktopParentAlive: null,
          serviceRestartCount: "",
          serviceStartedAt: "",
          serviceLastExit: "",
          serviceRestartMax: "",
          serviceWatchdogEnabled: "",
          serviceWatchdogFailureCount: "",
          serviceWatchdogThreshold: "",
          serviceWatchdogRestartCount: "",
          serviceWatchdogIntervalMs: "",
          serviceWatchdogTimeoutMs: "",
          electronVersion: "",
          electronAppVersion: "",
        },
        llm: {
          status: "warn",
          provider: localConfig.provider,
          model: localConfig.model,
          keySource: "未知",
          envKeyName: "",
        },
        tools: [],
        paths: [],
        recommendedActions: [message],
      };
    }
  }, [localConfig.model, localConfig.provider]);

  const loadDesktopDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true);
    try {
      setDesktopDiagnostics(await fetchDesktopDiagnostics());
    } finally {
      setDiagnosticsLoading(false);
    }
  }, [fetchDesktopDiagnostics]);

  const fetchDesktopReleaseReadiness = useCallback(async (): Promise<DesktopReleaseReadiness> => {
    try {
      const res = await fetch("/api/desktop/release-readiness", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "桌面交付状态读取失败");
      return data;
    } catch (error) {
      const message = displayClientError(error, "桌面交付状态没有读取成功。请重新检查。");
      return {
        status: "fail",
        checkedAt: new Date().toISOString(),
        summary: message,
        internalReady: false,
        externalReady: false,
        externalBlockers: [message],
        gates: [],
        recommendedActions: [message],
        reports: {
          releaseAssessment: null,
          notarization: null,
          releaseGate: null,
          packagedSoak: null,
        },
      };
    }
  }, []);

  const loadDesktopReleaseReadiness = useCallback(async () => {
    setReleaseReadinessLoading(true);
    try {
      setReleaseReadiness(await fetchDesktopReleaseReadiness());
    } finally {
      setReleaseReadinessLoading(false);
    }
  }, [fetchDesktopReleaseReadiness]);

  const fetchCommercialServiceStatus = useCallback(async (): Promise<CommercialServiceStatus> => {
    const errors: string[] = [];
    const [tikomniResult] = await Promise.allSettled([
      fetch("/api/settings/tikomni", { cache: "no-store" }).then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "TikOmni 状态读取失败");
        return data as {
          credential?: { configured?: boolean };
          setup?: { status?: string };
          recentCollection?: {
            sampleCount?: number;
            platformChecks?: Record<string, string>;
          };
        };
      }),
    ]);
    const tikomni = tikomniResult.status === "fulfilled" ? tikomniResult.value : undefined;
    if (tikomniResult.status === "rejected") errors.push("TikOmni 状态暂时无法读取");
    const platformChecks = tikomni?.recentCollection?.platformChecks || {};
    const tikomniWeeklySnapshotComplete = ["wechat_mp", "xiaohongshu", "wechat_channels"]
      .every((platform) => platformChecks[platform] === "available");
    return {
      tikomniConfigured: tikomni?.credential?.configured === true && tikomni?.setup?.status === "ready_to_test",
      tikomniWeeklySnapshotComplete,
      tikomniSampleCount: typeof tikomni?.recentCollection?.sampleCount === 'number' && Number.isSafeInteger(tikomni.recentCollection.sampleCount) && tikomni.recentCollection.sampleCount >= 0 ? tikomni.recentCollection.sampleCount : null,
      errors,
    };
  }, []);

  const loadCommercialAcceptance = useCallback(async () => {
    setCommercialAcceptanceLoading(true);
    try {
      const [readiness, services] = await Promise.all([
        fetchDesktopReleaseReadiness(),
        fetchCommercialServiceStatus(),
      ]);
      setReleaseReadiness(readiness);
      setCommercialServices(services);
    } finally {
      setCommercialAcceptanceLoading(false);
    }
  }, [fetchCommercialServiceStatus, fetchDesktopReleaseReadiness]);

  const exportDesktopDiagnostics = useCallback(async () => {
    setDiagnosticsExporting(true);
    try {
      const res = await fetch("/api/desktop/diagnostics/package", { cache: "no-store" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "诊断包导出失败");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `aifios-diagnostics-${Date.now()}.json`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success("诊断包已导出");
    } catch (error) {
      const message = displayClientError(error, "诊断包没有导出成功。请重新选择保存位置后再试。");
      toast.error(message);
    } finally {
      setDiagnosticsExporting(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchDesktopDiagnostics().then((data) => {
      if (!cancelled) setDesktopDiagnostics(data);
    });
    fetchDesktopReleaseReadiness().then((data) => {
      if (!cancelled) setReleaseReadiness(data);
    });
    fetchCommercialServiceStatus().then((data) => {
      if (!cancelled) setCommercialServices(data);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchCommercialServiceStatus, fetchDesktopDiagnostics, fetchDesktopReleaseReadiness]);

  const providerEntries = Object.entries(PROVIDER_PRESETS);
  const preset = PROVIDER_PRESETS[localConfig.provider] || PROVIDER_PRESETS.deepseek;
  const hasManualKey = Boolean(localConfig.apiKey?.trim());
  const hasSavedKey = Boolean(localConfig.hasSavedKey && localConfig.provider === config.provider);
  const hasEnvKey = Boolean(config.hasEnvKey && localConfig.provider === config.provider);
  const configReady = hasManualKey || hasSavedKey || hasEnvKey;
  const isDirty = removeLlmCredential || JSON.stringify(localConfig) !== JSON.stringify(config);
  const canTest = configReady && !isDirty && !configSaving && testState.status !== "testing";
  const runState = isDirty
    ? "dirty"
    : !configReady
      ? "missing"
      : testState.status === "success"
        ? "ready"
        : testState.status === "error"
          ? "failed"
          : "untested";

  const activePreset = useMemo(
    () =>
      PARAM_PRESETS.find(
        (item) =>
          Number(localConfig.temperature) === item.temperature &&
          Number(localConfig.maxTokens) === item.maxTokens
      )?.id,
    [localConfig.maxTokens, localConfig.temperature]
  );

  const handleProviderSelect = (provider: string) => {
    const nextPreset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.deepseek;
    setLocalConfig((prev) => ({
      ...prev,
      provider,
      model: nextPreset.model,
      baseUrl: nextPreset.baseUrl,
      apiKey: provider === prev.provider ? prev.apiKey : "",
      hasSavedKey: provider === prev.provider ? prev.hasSavedKey : false,
    }));
  };

  const applyParamPreset = (presetId: string) => {
    const next = PARAM_PRESETS.find((item) => item.id === presetId);
    if (!next) return;
    setLocalConfig((prev) => ({
      ...prev,
      temperature: next.temperature,
      maxTokens: next.maxTokens,
    }));
  };

  const handleSave = async () => {
    if (configSaving) return;
    setConfigSaving(true);
    const payload: Partial<typeof localConfig> = { ...localConfig };
    const manualApiKey = String(payload.apiKey || "").trim();
    const credentialBridge = typeof window !== "undefined" ? window.aifiosCredentials : undefined;
    if (credentialBridge) {
      // Electron owns the secret. The local Next service receives only
      // non-secret model settings and will fail closed if apiKey is present.
      delete payload.apiKey;
    } else if (!payload.apiKey && payload.hasSavedKey) {
      delete payload.apiKey;
    }
    let nonSecretConfigSaved = false;
    let credentialTransactionCommitted = false;
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("保存失败");
      nonSecretConfigSaved = true;
      if (credentialBridge && manualApiKey) {
        await credentialBridge.save("llm", JSON.stringify({
          provider: localConfig.provider,
          apiKey: manualApiKey,
        }));
      } else if (credentialBridge && removeLlmCredential) {
        await credentialBridge.delete("llm");
      }
      credentialTransactionCommitted = true;
      const fresh = await fetch("/api/config").then((item) => item.json()).catch(() => null);
      if (fresh?.config) {
        setConfig(fresh.config);
        setLocalConfig(fresh.config);
      }
      setRemoveLlmCredential(false);
      setSavedAt(new Date().toISOString());
      setTestState({ status: "idle", message: "设置已保存，可以测试连接。" });
      toast.success("配置已保存");
    } catch (error) {
      let message = displayClientError(error, "设置没有保存成功。请检查填写内容后重试。");
      if (nonSecretConfigSaved && !credentialTransactionCommitted) {
        const rollbackPayload: Partial<typeof localConfig> = { ...config };
        if (credentialBridge) delete rollbackPayload.apiKey;
        const rolledBack = await fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rollbackPayload),
        }).then((response) => response.ok).catch(() => false);
        if (!rolledBack) message = "设置没有保存完整，原设置也没有恢复成功。请重启应用并检查设置后再继续。";
      }
      toast.error(message);
    } finally {
      setConfigSaving(false);
    }
  };

  const testConnection = async () => {
    if (configSaving || testState.status === "testing") return;
    if (isDirty) {
      toast.error("请先保存设置，再测试连接");
      return;
    }
    if (!configReady) {
      setTestState({ status: "error", message: "缺少 API Key，请先填写密钥或配置环境变量。" });
      return;
    }

    setTestState({ status: "testing", message: "正在连接模型..." });
    let checkedAt: string | undefined;
    try {
      const res = await fetch("/api/config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(localConfig),
      });
      const data = await res.json();
      checkedAt = data.record?.completedAt || data.record?.startedAt;
      if (!res.ok || !data.ok) throw new Error(data.message || "连接失败");
      setTestState({
        status: "success",
        message: data.recordWarning || data.record?.message || "本次短文本请求返回成功。",
        latencyMs: data.latencyMs,
        model: data.model,
        checkedAt,
      });
      toast.success("连接测试成功");
    } catch (error) {
      const message = displayClientError(error, "模型服务连接失败。请检查网络和密钥后重试。");
      setTestState({ status: "error", message, checkedAt });
      toast.error(message);
    }
  };

  const resetProviderDefaults = () => {
    setLocalConfig((prev) => ({
      ...prev,
      model: preset.model,
      baseUrl: preset.baseUrl,
      temperature: 0.7,
      maxTokens: 8000,
    }));
    toast.success("已恢复当前模型服务商的默认设置");
  };

  const clearManualKey = () => {
    setLocalConfig((prev) => ({ ...prev, apiKey: "", hasSavedKey: false }));
    setRemoveLlmCredential(true);
    setTestState({ status: "idle", message: "API Key 已清空，保存后会尝试使用其他已配置的密钥。" });
    toast.success("已清空 API Key");
  };

  const inputClass =
    "h-[42px] rounded-[12px] border border-[rgba(28,28,30,0.1)] bg-white px-[12px] text-[14px] text-[#1A1A1A] placeholder:text-[#9A9A9A] focus:border-[#E85D4C] focus-visible:ring-0 focus-visible:ring-offset-0";

  if (configLoading) {
    return (
      <div className="mx-auto flex min-h-[260px] w-full max-w-[880px] items-center justify-center border border-[rgba(28,28,30,0.12)] bg-white p-8">
        <div className="flex items-center gap-3 text-[14px] font-semibold text-[#6B6B6B]">
          <Loader2 size={18} className="animate-spin text-[#E85D4C]" />
          正在读取连接设置
        </div>
      </div>
    );
  }

  if (localConfig.licenseRequired && !localConfig.gatewayConnected) {
    return (
      <HostedAccessPanel
        config={localConfig}
        onConfigChanged={(next) => {
          setConfig(next);
          setLocalConfig(next);
        }}
      />
    );
  }

  return (
    <div className="aifios-editorial-page mx-auto w-full max-w-[1480px] space-y-[18px] pb-8">
      {localConfig.licenseRequired && localConfig.gatewayConnected ? (
        <LicenseStatusBanner
          config={localConfig}
          onDeactivated={async () => {
            const res = await fetch("/api/config", { cache: "no-store" });
            const data = await res.json().catch(() => ({}));
            if (data?.config) {
              setConfig(data.config);
              setLocalConfig(data.config);
            }
          }}
        />
      ) : null}
      <div className="flex flex-col gap-[12px] lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="mb-[4px] text-[13px] font-semibold text-[#9A9A9A]">系统</p>
          <div className="flex items-center gap-[10px]">
            <span className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-[rgba(232,93,76,0.1)] text-[#E85D4C]">
              <Settings2 size={19} strokeWidth={2.35} />
            </span>
            <h1 className="text-[25px] font-bold leading-tight text-[#1A1A1A]">{PRODUCT_COPY.pages.settings.title}</h1>
          </div>
          <p className="mt-[7px] max-w-[720px] text-[14px] leading-[1.7] text-[#6B6B6B]">
            生成前连接写作模型；需要研究平台选题时，再设置数据服务。
          </p>
          <p className="mt-[8px] inline-flex flex-wrap items-center gap-2 rounded-full border border-[rgba(28,28,30,0.1)] bg-white px-3 py-1 text-[13px] text-[#6B6B6B]">
            <span>当前界面版本 <span className="font-mono font-semibold">{PRODUCT_VERSION_DISPLAY}</span></span>
            {/^\d+\.\d+\.\d+-/.test(PRODUCT_VERSION_DISPLAY) ? <span>· 预发布版本</span> : null}
          </p>
        </div>

        <div className="flex flex-wrap gap-[8px]">
          <Link
            href="/production"
            className="inline-flex h-10 min-w-[100px] items-center justify-center gap-2 rounded-lg border border-[rgba(28,28,30,0.1)] bg-white px-3.5 text-[13px] font-semibold text-[#1A1A1A] transition hover:border-[#52790C] hover:bg-[#F7FAF4] hover:text-[#3B5E06]"
          >
            回到工作台继续
            <ArrowRight size={15} />
          </Link>
        </div>
      </div>

      {isFirstRun ? <DesktopFirstRunGuide /> : null}

      <section id="model-connection" aria-label="连接写作服务" className="scroll-mt-6 space-y-5 rounded-[18px] border border-[rgba(28,28,30,0.08)] bg-white p-5 sm:p-6">
        <div>
          <h2 className="text-[18px] font-bold text-[#1A1A1A]">连接写作服务</h2>
          <p className="mt-2 text-sm leading-6 text-[#6B6B6B]">{localConfig.connectionMode === 'hosted' || localConfig.provider === 'aifios-hosted'
            ? '当前使用授权服务，请核对页面中的授权状态与额度。'
            : '选择服务商，填写密钥，再保存并测试。没有密钥时，可以展开下方的账号准备指引。'}</p>
        </div>
        <fieldset disabled={configSaving || testState.status === "testing"} className="min-w-0 space-y-5 disabled:opacity-70">
          <legend className="sr-only">模型账号与连接设置</legend>
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <Label htmlFor="llm-provider" className="flex h-8 items-center text-[13px] font-bold text-[#1A1A1A]">模型服务商</Label>
              <select id="llm-provider" value={localConfig.provider} onChange={(event) => handleProviderSelect(event.target.value)} className={`${inputClass} mt-[7px] w-full`}>
                {!PROVIDER_PRESETS[localConfig.provider] && <option value={localConfig.provider}>{localConfig.provider}（当前服务）</option>}
                {providerEntries.map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
              </select>
              <p className="mt-2 text-xs leading-5 text-[#6B6B6B]">当前模型：{localConfig.model || preset.model}。请确认你的账号可使用；需要调整时展开下方设置。</p>
            </div>
              <div>
                <div className="mb-[7px] flex items-center justify-between">
                  <Label htmlFor="llm-api-key" className="flex items-center gap-[7px] text-[13px] font-bold text-[#1A1A1A]">
                    <KeyRound size={15} className="text-[#E85D4C]" />
                    API Key（密钥）
                  </Label>
                  <button
                    type="button"
                    onClick={() => setShowKey((prev) => !prev)}
                    aria-controls="llm-api-key"
                    aria-pressed={showKey}
                    className="inline-flex h-8 items-center gap-[5px] px-2 text-[12px] font-semibold text-[#6B6B6B] transition hover:bg-[#F7FAF4] hover:text-[#52790C]"
                  >
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    {showKey ? "隐藏" : "显示"}
                  </button>
                </div>
                <Input
                  id="llm-api-key"
                  type={showKey ? "text" : "password"}
                  value={localConfig.apiKey}
                  onChange={(event) => {
                    setRemoveLlmCredential(false);
                    setLocalConfig((prev) => ({ ...prev, apiKey: event.target.value }));
                  }}
                  placeholder={hasSavedKey || hasEnvKey ? "已有密钥；需要更换时再填写" : "粘贴这个服务账号的 API Key"}
                  className={inputClass}
                />
                <div className="mt-[8px] flex flex-wrap items-center justify-between gap-[8px] text-[12px] text-[#6B6B6B]">
                  <span>
                    {hasSavedKey || hasEnvKey
                      ? desktopCredentialVault
                        ? "密钥保存在 macOS 钥匙串中，不会在页面显示。留空保存会继续保留。"
                        : hasSavedKey
                          ? "已保存的密钥不会在页面显示，留空保存会继续保留。"
                          : "已读取本机配置的密钥，无需重复填写。"
                      : desktopCredentialVault
                        ? "桌面版会把密钥保存到 macOS 钥匙串，不会在页面显示。"
                        : "粘贴密钥后保存；也可以使用已经配置的环境变量。"}
                  </span>
                  {(hasManualKey || hasSavedKey || (desktopCredentialVault && hasEnvKey)) && (
                    <button type="button" onClick={clearManualKey} className="inline-flex h-8 items-center gap-[5px] px-2 font-semibold text-[#E85D4C] hover:bg-[#F7FAF4]">
                      <Trash2 size={13} />
                      清空
                    </button>
                  )}
                </div>
                {desktopCredentialVault ? (
                  <p className="mt-[7px] text-[11px] leading-[1.55] text-[#7A716A]">{MACOS_KEYCHAIN_EXPLANATION}</p>
                ) : null}
              </div>


          </div>
          <ModelAccountGuide provider={localConfig.provider} baseUrl={localConfig.baseUrl} connectionMode={localConfig.connectionMode} />
          <details className="rounded-xl border border-[rgba(28,28,30,0.1)]">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-[#52790C]">调整模型、地址与输出参数</summary>
            <div className="space-y-5 border-t border-[rgba(28,28,30,0.08)] p-4">
              <p className="text-xs leading-5 text-[#6B6B6B]">使用自定义服务地址或需要更长输出时再调整。收起设置不会重置你保存的值。</p>
              <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <Label htmlFor="llm-model-name" className="text-[13px] font-bold text-[#1A1A1A]">模型名称</Label>
                <Input
                  id="llm-model-name"
                  value={localConfig.model}
                  onChange={(event) => setLocalConfig((prev) => ({ ...prev, model: event.target.value }))}
                  placeholder={preset.model}
                  className={`${inputClass} mt-[7px]`}
                />
                <p className="mt-[7px] text-[12px] leading-[1.55] text-[#6B6B6B]">
                  选择服务商后会自动填写默认模型；也可以改成你账号可以使用的模型名。
                </p>
              </div>


              <div>
                <Label htmlFor="llm-api-base-url" className="text-[13px] font-bold text-[#1A1A1A]">API 地址（Base URL）</Label>
                <Input
                  id="llm-api-base-url"
                  value={localConfig.baseUrl || ""}
                  onChange={(event) => setLocalConfig((prev) => ({ ...prev, baseUrl: event.target.value }))}
                  placeholder={preset.baseUrl}
                  className={`${inputClass} mt-[7px]`}
                />
                <p className="mt-[7px] text-[12px] leading-[1.55] text-[#6B6B6B]">
                  {preset.note}
                </p>
              </div>

              </div>
              <div className="flex flex-wrap gap-2" aria-label="输出参数预设">
                {PARAM_PRESETS.map((item) => <button key={item.id} type="button" onClick={() => applyParamPreset(item.id)} aria-pressed={activePreset === item.id} title={item.desc} className={`rounded-lg border px-3 py-2 text-sm ${activePreset === item.id ? "border-[#52790C] bg-[#F7FAF4]" : "border-[rgba(28,28,30,0.1)]"}`}>{item.label}</button>)}
              </div>
              <div className="grid gap-5 lg:grid-cols-2">
              <ParamControl
                id="temperature"
                label="创作自由度（Temperature）"
                value={Number(localConfig.temperature ?? 0.7)}
                min={0}
                max={2}
                step={0.1}
                helper="越低越稳定，越高越发散。"
                onChange={(value) => setLocalConfig((prev) => ({ ...prev, temperature: value }))}
              />

              <ParamControl
                id="max-tokens"
                label="单次输出上限（Max Tokens）"
                value={Number(localConfig.maxTokens ?? 8000)}
                min={1000}
                max={200000}
                step={1000}
                helper="公众号长文或多个平台的原生内容需要更高的输出上限。"
                onChange={(value) => setLocalConfig((prev) => ({ ...prev, maxTokens: value }))}
              />

              </div>
              <button type="button" onClick={resetProviderDefaults} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"><RotateCcw size={15} />恢复当前服务的默认设置</button>
            </div>
          </details>
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={configSaving || testState.status === "testing" || !isDirty}
            className="inline-flex h-10 min-w-[108px] items-center justify-center gap-2 rounded-lg bg-[#E85D4C] px-4 text-[13px] font-bold text-white transition hover:bg-[#D84F40] disabled:cursor-not-allowed disabled:bg-[#D7B3AD]"
          >
            {configSaving ? <Loader2 size={15} className="animate-spin" /> : savedAt && !isDirty ? <CheckCircle2 size={15} /> : <Save size={15} />}
            {configSaving ? "保存中" : savedAt && !isDirty ? "已保存" : "保存设置"}
          </button>
          <button
            type="button"
            onClick={testConnection}
            disabled={!canTest}
            className="inline-flex h-10 min-w-[108px] items-center justify-center gap-2 rounded-lg bg-[#1C1C1E] px-4 text-[13px] font-bold text-white transition hover:bg-[#2B2B2E] disabled:cursor-not-allowed disabled:bg-[#CFCFCF]"
          >
            {testState.status === "testing" ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
            {testState.status === "testing" ? "测试中" : testState.status === "success" ? "重新测试" : "测试连接"}
          </button>

        </div>
        <p className="text-xs leading-5 text-[#6B6B6B]">保存设置不调用模型；测试会发送一次短文本请求，可能计费。<a href="#service-costs" className="underline">查看费用说明</a></p>
        <ConnectionGuide state={runState} testState={testState} provider={preset.label || localConfig.provider} model={localConfig.model} />
      </section>

      <ServiceCostNotice config={localConfig} />
      <CurrentDraftCallHistory />
      <LayoutCallHistory />

      <div id="tikomni-research" className="scroll-mt-6">
        <TikOmniSettings />
      </div>

      <div id="publication-bridge" className="scroll-mt-6">
        <PublicationBridgeSettings />
      </div>

      <div id="project-backup" className="scroll-mt-6">
        <ProjectBackupSettings />
      </div>

      {!isFirstRun || showDiagnostics ? (
        <details open={showDiagnostics || undefined} className="group overflow-hidden rounded-[18px] border border-[rgba(28,28,30,0.08)] bg-white shadow-[0_8px_24px_rgba(28,28,30,0.035)]">
          <summary className="flex min-h-[76px] cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 transition hover:bg-[#FAFCF8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#52790C]/25 [&::-webkit-details-marker]:hidden">
            <span className="flex min-w-0 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-[#F2F7ED] text-[#52790C]">
                <Settings2 size={18} />
              </span>
              <span className="min-w-0">
                <span className="block text-[16px] font-bold text-[#1A1A1A]">高级设置与诊断</span>
                <span className="mt-1 block text-[12px] leading-5 text-[#6B6B6B]">文章排版、桌面运行检查和应用信息，日常使用无需展开。</span>
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-[12px] font-semibold text-[#6B6B6B]">
              <span className="group-open:hidden">展开</span>
              <span className="hidden group-open:inline">收起</span>
              <ChevronDown size={17} className="transition-transform duration-200 group-open:rotate-180" />
            </span>
          </summary>
          <div className="space-y-[14px] border-t border-[rgba(28,28,30,0.08)] bg-[#F8FAF6] p-4">
            <BrandTemplatesPanel
              templates={brandTemplates}
              loading={brandTemplatesLoading}
              error={brandTemplatesError}
              onRefresh={loadBrandTemplates}
            />
            <DesktopDiagnosticsPanel
              diagnostics={desktopDiagnostics}
              loading={diagnosticsLoading}
              exporting={diagnosticsExporting}
              onRefresh={loadDesktopDiagnostics}
              onExport={exportDesktopDiagnostics}
            />
            <details className="rounded-xl border border-[rgba(28,28,30,0.1)] bg-white">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-[#52790C]">内部验收与安装包报告</summary>
              <div className="space-y-4 border-t border-[rgba(28,28,30,0.08)] p-4">
                <p className="text-sm leading-6 text-[#6B6B6B]">以下记录供交付排查使用，可能对应较早的安装包。报告中的版本和结果不代表当前界面已通过验收，也不表示你的授权权益。</p>
                <CommercialAcceptancePanel
                  readiness={releaseReadiness}
                  services={commercialServices}
                  loading={commercialAcceptanceLoading || releaseReadinessLoading}
                  onRefresh={loadCommercialAcceptance}
                />
                <DesktopReleaseReadinessPanel
                  readiness={releaseReadiness}
                  loading={releaseReadinessLoading}
                  onRefresh={loadDesktopReleaseReadiness}
                />
              </div>
            </details>
          </div>
        </details>
      ) : null}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="min-h-[320px]" aria-busy="true" />}>
      <SettingsPageContent />
    </Suspense>
  );
}

function BrandTemplatesPanel({
  templates,
  loading,
  error,
  onRefresh,
}: {
  templates: BrandTemplate[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const [previewThemeId, setPreviewThemeId] = useState("");
  const [compareThemeIds, setCompareThemeIds] = useState<string[]>([]);
  const { preferences, recordRecent, toggleFavorite, setDefault } = useMd2WechatThemePreferences();
  const directCount = templates.filter((template) => template.enabled).length;
  const usingMd2Wechat = templates.some((template) => template.source === "md2wechat");
  const previewTheme = templates.find((template) => (
    template.id === previewThemeId
    && template.enabled
    && template.source === "md2wechat"
    && template.themeType === "api"
  )) || templates.find((template) => (
    template.id === preferences.defaultThemeId
    && template.enabled
    && template.source === "md2wechat"
    && template.themeType === "api"
  )) || templates.find((template) => (
    template.enabled && template.source === "md2wechat" && template.themeType === "api"
  ));
  const compareThemes = compareThemeIds.flatMap((themeId) => {
    const theme = templates.find((candidate) => candidate.id === themeId);
    return theme ? [theme] : [];
  });

  function previewTemplate(themeId: string) {
    setPreviewThemeId(themeId);
    recordRecent(themeId);
  }

  function toggleComparison(themeId: string) {
    setCompareThemeIds((current) => toggleMd2WechatThemeComparison(current, themeId));
  }
  return (
    <section className="rounded-[18px] border border-[rgba(28,28,30,0.08)] bg-white p-[16px] shadow-[0_8px_24px_rgba(28,28,30,0.035)]">
      <div className="flex flex-col gap-[12px] border-b border-[rgba(28,28,30,0.08)] pb-[14px] md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 items-start gap-[10px]">
          <span className="flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-[10px] bg-[#FDF3F0] text-[#E85D4C]">
            <SlidersHorizontal size={18} />
          </span>
          <div>
            <h2 className="text-[18px] font-bold text-[#1A1A1A]">md2wechat 主题库</h2>
            <p className="mt-[3px] text-[13px] leading-[1.6] text-[#6B6B6B]">
              直接读取本机 md2wechat 目录，不再维护 Echo Founder 自建的 16 套排版。
            </p>
          </div>
        </div>
        <div className="flex items-center gap-[8px]">
          <span className="rounded-full bg-[#F1F5EA] px-[10px] py-[5px] text-[11px] font-bold text-[#52790C]">
            {templates.length} 个主题 · {directCount} 个支持排版
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex h-[36px] w-[36px] items-center justify-center border border-[rgba(28,28,30,0.1)] text-[#6B6B6B] transition hover:border-[#E85D4C] hover:text-[#E85D4C] disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="刷新 md2wechat 主题"
            title="刷新 md2wechat 主题"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-[12px] border-l-[3px] border-[#E85D4C] bg-[#FFF2EF] px-[10px] py-[8px] text-[12px] leading-[1.55] text-[#B43C2E]">{error}</p>
      )}

      <div className={`mt-[12px] border-l-[3px] px-[11px] py-[9px] text-[12px] leading-[1.6] ${usingMd2Wechat ? "border-[#52790C] bg-[#F7FAF4] text-[#4F5D42]" : "border-[#D99124] bg-[#FFF9EC] text-[#6B5543]"}`}>
        {usingMd2Wechat
          ? "已读取主题目录，尚不代表排版服务账号可用。查看效果需要主动生成示例预览，可能产生外部服务费用。"
          : "未检测到 md2wechat，当前只显示一个基础回退排版。安装或恢复 md2wechat 后刷新即可读取完整目录。"}
      </div>

      <div className="mt-[14px] grid gap-[14px] lg:grid-cols-[minmax(0,1fr)_minmax(390px,0.9fr)] lg:items-start">
        <Md2WechatThemeBrowser
          themes={templates}
          previewThemeId={previewTheme?.id || ""}
          onPreview={previewTemplate}
          compareThemeIds={compareThemeIds}
          onToggleCompare={toggleComparison}
          preferences={preferences}
          onToggleFavorite={toggleFavorite}
        />
        <aside aria-label="md2wechat 主题预览" className="min-w-0 lg:sticky lg:top-[14px]">
          {previewTheme ? (
            <Md2WechatThemePreview
              theme={previewTheme}
              className="mt-0"
              isDefault={previewTheme.id === preferences.defaultThemeId}
              onSetDefault={() => setDefault(previewTheme.id)}
            />
          ) : (
            <div className="flex min-h-[260px] items-center justify-center border border-dashed border-[rgba(28,28,30,0.14)] bg-[#FFFDF9] px-[24px] text-center text-[12px] leading-[1.7] text-[#6B6B6B]">
              检测到可直接使用的 md2wechat API 主题后，这里会显示真实排版预览。
            </div>
          )}
        </aside>
      </div>
      <Md2WechatThemeComparison
        themes={compareThemes}
        defaultThemeId={preferences.defaultThemeId}
        onSetDefault={setDefault}
        onRemove={toggleComparison}
        onClear={() => setCompareThemeIds([])}
      />
    </section>
  );
}

function ConnectionGuide({
  state,
  testState,
  provider,
  model,
}: {
  state: "missing" | "dirty" | "ready" | "failed" | "untested";
  testState: TestState;
  provider: string;
  model: string;
}) {
  const guide = {
    missing: {
      icon: AlertCircle,
      title: "还不能生成内容",
      message: "请先选择模型服务商并填写 API Key。",
      className: "border-[rgba(232,93,76,0.18)] bg-[#FFF7F5] text-[#8A4A3E]",
    },
    dirty: {
      icon: Save,
      title: "设置有未保存改动",
      message: "请先保存设置，再测试连接。",
      className: "border-[rgba(232,93,76,0.18)] bg-[#FDF3F0] text-[#8A4A3E]",
    },
    ready: {
      icon: CheckCircle2,
      title: "上次模型请求返回成功",
      message: `${provider} / ${model} · ${testState.checkedAt ? `${formatTime(testState.checkedAt)} · ` : ''}${testState.message}`,
      className: "border-[rgba(22,128,60,0.18)] bg-[#F8FBF6] text-[#245C36]",
    },
    failed: {
      icon: XCircle,
      title: "连接测试失败",
      message: `${testState.checkedAt ? `${formatTime(testState.checkedAt)} · ` : ''}${testState.message}`,
      className: "border-[rgba(232,93,76,0.2)] bg-[#FFF2EF] text-[#8A4A3E]",
    },
    untested: {
      icon: ShieldCheck,
      title: "设置已填好，请测试连接",
      message: testState.message,
      className: "border-[rgba(28,28,30,0.08)] bg-white text-[#4B4743]",
    },
  }[state];

  const testing = testState.status === "testing";
  const Icon = testing ? Loader2 : guide.icon;

  return (
    <section aria-label="连接结果" aria-live="polite" className={`rounded-xl border p-4 ${guide.className}`}>
      <div className="flex flex-col gap-[12px] xl:flex-row xl:items-center xl:justify-between">
        <div className="flex items-start gap-[11px]">
          <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[12px] bg-white/70 text-[#E85D4C]">
            <Icon size={19} />
          </span>
          <div>
            <h2 className="text-[17px] font-bold text-[#1A1A1A]">{testing ? "正在测试连接" : guide.title}</h2>
            <p className="mt-[4px] text-[13px] leading-[1.7]">{testing ? "正在等待这次短文本请求的结果，请稍候。" : guide.message}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function DesktopDiagnosticsPanel({
  diagnostics,
  loading,
  exporting,
  onRefresh,
  onExport,
}: {
  diagnostics: DesktopDiagnostics | null;
  loading: boolean;
  exporting: boolean;
  onRefresh: () => void;
  onExport: () => void;
}) {
  const statusTone = diagnostics ? diagnosticTone(diagnostics.status) : diagnosticTone("warn");
  const toolItems = diagnostics?.tools || [];
  const pathItems = diagnostics?.paths || [];

  return (
    <section id="desktop-diagnostics" className="scroll-mt-6 rounded-[18px] border border-[rgba(28,28,30,0.08)] bg-white p-[16px] shadow-[0_8px_24px_rgba(28,28,30,0.035)]">
      <div className="flex flex-col gap-[12px] lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-[11px]">
          <span className={`flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[12px] ${statusTone.iconBg}`}>
            <MonitorCheck size={19} className={statusTone.iconText} />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-[8px]">
              <h2 className="text-[17px] font-bold text-[#1A1A1A]">桌面环境诊断</h2>
              <span className={`rounded-full px-[9px] py-[4px] text-[12px] font-bold ${statusTone.badge}`}>
                {statusTone.label}
              </span>
            </div>
            <p className="mt-[5px] max-w-[760px] text-[13px] leading-[1.7] text-[#6B6B6B]">
              {diagnostics?.summary || "正在读取本机运行环境、桌面壳状态和关键依赖。"}
            </p>
            <p className="mt-[3px] text-[12px] leading-[1.6] text-[#8A8178]">
              覆盖 Python、Node.js、npm、项目目录、skills 和 content-runtime。
            </p>
            <div className="mt-[8px] flex flex-wrap gap-[8px] text-[12px] text-[#6B6B6B]">
              <span className="rounded-full bg-[#FDF8F3] px-[8px] py-[4px]">
                {diagnostics?.runtime.isDesktop ? "桌面壳运行" : "浏览器/开发模式"}
              </span>
              <span className="rounded-full bg-[#FDF8F3] px-[8px] py-[4px]">
                项目：{diagnostics?.project.name || "-"}
              </span>
              <span className="rounded-full bg-[#FDF8F3] px-[8px] py-[4px]">
                来源：{projectSourceLabel(diagnostics?.runtime.projectSource)}
              </span>
              <span className="rounded-full bg-[#FDF8F3] px-[8px] py-[4px]">
                Server：{diagnostics?.runtime.serverMode || "未检测"}
              </span>
              <span className="rounded-full bg-[#FDF8F3] px-[8px] py-[4px]">
                单实例：{diagnostics?.runtime.singleInstance === "1" ? "已启用" : "未启用"}
              </span>
              <span className="rounded-full bg-[#FDF8F3] px-[8px] py-[4px]">
                服务恢复：{diagnostics?.runtime.serviceRestartCount || "0"} 次
              </span>
              <span className="rounded-full bg-[#FDF8F3] px-[8px] py-[4px]">
                Watchdog：{diagnostics?.runtime.serviceWatchdogEnabled === "1" ? "已启用" : "未启用"}
              </span>
              <span className="rounded-full bg-[#FDF8F3] px-[8px] py-[4px]">
                无响应恢复：{diagnostics?.runtime.serviceWatchdogRestartCount || "0"} 次
              </span>
              <span className="rounded-full bg-[#FDF8F3] px-[8px] py-[4px]">
                探测：{diagnostics?.runtime.serviceWatchdogIntervalMs || "-"}ms / {diagnostics?.runtime.serviceWatchdogTimeoutMs || "-"}ms
              </span>
              <span className="rounded-full bg-[#FDF8F3] px-[8px] py-[4px]">
                Python：{diagnostics?.runtime.pythonSource || "系统"}
              </span>
              <span className="rounded-full bg-[#FDF8F3] px-[8px] py-[4px]">
                Node：{diagnostics?.runtime.nodeBinary ? "Electron" : "系统"}
              </span>
              <span className="rounded-full bg-[#FDF8F3] px-[8px] py-[4px]">
                Electron：{diagnostics?.runtime.electronVersion || "未检测"}
              </span>
              <span className="rounded-full bg-[#FDF8F3] px-[8px] py-[4px]">
                {diagnostics?.checkedAt ? `检查 ${formatTime(diagnostics.checkedAt)}` : "等待检查"}
              </span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap gap-[8px]">
          <button
            type="button"
            onClick={onExport}
            disabled={exporting}
            className="inline-flex h-[38px] items-center justify-center gap-[7px] rounded-full border border-[rgba(28,28,30,0.1)] bg-white px-[13px] text-[13px] font-semibold text-[#1A1A1A] transition hover:border-[#E85D4C] hover:text-[#E85D4C] disabled:cursor-not-allowed disabled:text-[#9A9A9A]"
          >
            {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
            导出诊断包
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex h-[38px] items-center justify-center gap-[7px] rounded-full border border-[rgba(28,28,30,0.1)] bg-white px-[13px] text-[13px] font-semibold text-[#1A1A1A] transition hover:border-[#E85D4C] hover:text-[#E85D4C] disabled:cursor-not-allowed disabled:text-[#9A9A9A]"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            重新检查
          </button>
        </div>
      </div>

      <div className="mt-[14px] grid grid-cols-1 gap-[10px] xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)_260px]">
        <DiagnosticGroup icon={Terminal} title="运行依赖" items={toolItems} />
        <DiagnosticGroup icon={FolderCheck} title="本地目录" items={pathItems} />
        <div className="rounded-[14px] bg-[#FDF8F3] p-[13px]">
          <div className="mb-[9px] flex items-center gap-[7px]">
            <Cpu size={15} className="text-[#E85D4C]" />
            <h3 className="text-[13px] font-bold text-[#1A1A1A]">制作可用性</h3>
          </div>
          <DiagnosticRow
            item={{
              id: "llm",
              label: "LLM",
              status: diagnostics?.llm.status || "warn",
              version: diagnostics?.llm.provider,
              detail: diagnostics?.llm.keySource || "未检查",
            }}
          />
          <p className="mt-[8px] rounded-[10px] bg-white px-[10px] py-[8px] text-[12px] leading-[1.55] text-[#6B6B6B]">
            当前项目目录：<span className="font-mono text-[#1A1A1A]">{diagnostics?.project.path || "-"}</span>
          </p>
          <p className="mt-[6px] rounded-[10px] bg-white px-[10px] py-[8px] text-[12px] leading-[1.55] text-[#6B6B6B]">
            桌面版可通过菜单「Echo Founder / 选择项目目录」切换数据目录，切换后本地服务会自动重启。
          </p>
          <div className="mt-[10px] space-y-[6px]">
            {(diagnostics?.recommendedActions || ["等待诊断结果"]).map((item) => (
              <p key={item} className="break-words rounded-[10px] bg-white px-[10px] py-[8px] text-[12px] leading-[1.55] text-[#6B6B6B] [overflow-wrap:anywhere]">
                {item}
              </p>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function DesktopReleaseReadinessPanel({
  readiness,
  loading,
  onRefresh,
}: {
  readiness: DesktopReleaseReadiness | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const tone = releaseReadinessTone(readiness?.status || "missing_reports");
  const gates = readiness?.gates || [];
  const blockers = readiness?.externalBlockers || [];
  const actions = readiness?.recommendedActions || ["等待交付状态报告"];
  const assessment = readiness?.reports.releaseAssessment;
  const releaseGate = readiness?.reports.releaseGate;
  const packagedSoak = readiness?.reports.packagedSoak;

  return (
    <section className="rounded-[18px] border border-[rgba(28,28,30,0.08)] bg-white p-[16px] shadow-[0_8px_24px_rgba(28,28,30,0.035)]">
      <div className="flex flex-col gap-[12px] lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-[11px]">
          <span className={`flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[12px] ${tone.iconBg}`}>
            <ShieldCheck size={19} className={tone.iconText} />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-[8px]">
              <h2 className="text-[17px] font-bold text-[#1A1A1A]">安装包检查记录</h2>
              <span className={`rounded-full px-[9px] py-[4px] text-[12px] font-bold ${tone.badge}`}>{tone.label}</span>
            </div>
            <p className="mt-[5px] max-w-[760px] text-[13px] leading-[1.7] text-[#6B6B6B]">
              {readiness?.summary || "正在读取桌面发布门禁、长稳测试、签名、公证和 Gatekeeper 报告。"}
            </p>
            <div className="mt-[8px] flex flex-wrap gap-[8px] text-[12px] text-[#6B6B6B]">
              <span className={`rounded-full px-[8px] py-[4px] ${readiness?.internalReady ? "bg-[#EAF8EF] text-[#16803C]" : "bg-[#FFF3DA] text-[#A35E00]"}`}>
                内测交付：{readiness?.internalReady ? "可用" : "待确认"}
              </span>
              <span className={`rounded-full px-[8px] py-[4px] ${readiness?.externalReady ? "bg-[#EAF8EF] text-[#16803C]" : "bg-[#FFF2EF] text-[#E85D4C]"}`}>
                外部分发：{readiness?.externalReady ? "可发布" : "未就绪"}
              </span>
              <span className="rounded-full bg-[#FDF8F3] px-[8px] py-[4px]">
                报告中的 App 版本：{assessment?.app.exists ? `${assessment.app.version || "未记录"}` : "未确认"}
              </span>
              <span className="rounded-full bg-[#FDF8F3] px-[8px] py-[4px]">
                签名：{assessment?.signing.signatureKind || "未检查"}
              </span>
              <span className="rounded-full bg-[#FDF8F3] px-[8px] py-[4px]">
                门禁：{releaseGate ? `${releaseGate.mode || "-"} / ${releaseGate.status}` : "无报告"}
              </span>
              <span className="rounded-full bg-[#FDF8F3] px-[8px] py-[4px]">
                长稳：{packagedSoak ? `${packagedSoak.iterations ?? 0} 轮` : "无报告"}
              </span>
              <span className="rounded-full bg-[#FDF8F3] px-[8px] py-[4px]">
                {readiness?.checkedAt ? `状态读取于 ${formatReportTime(readiness.checkedAt)}` : "等待检查"}
              </span>
            </div>
            <p className="mt-2 text-[13px] leading-6 text-[#6B6B6B]">安装包报告生成于：{assessment?.checkedAt ? formatReportTime(assessment.checkedAt) : '未记录'}；门禁报告：{releaseGate?.checkedAt ? formatReportTime(releaseGate.checkedAt) : '未记录'}；长稳报告：{packagedSoak?.checkedAt ? formatReportTime(packagedSoak.checkedAt) : '未记录'}。</p>
          </div>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex h-[38px] shrink-0 items-center justify-center gap-[7px] rounded-full border border-[rgba(28,28,30,0.1)] bg-white px-[13px] text-[13px] font-semibold text-[#1A1A1A] transition hover:border-[#E85D4C] hover:text-[#E85D4C] disabled:cursor-not-allowed disabled:text-[#9A9A9A]"
        >
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          刷新状态
        </button>
      </div>

      <div className="mt-[14px] grid grid-cols-1 gap-[10px] xl:grid-cols-[minmax(0,1fr)_minmax(260px,0.42fr)]">
        <div className="rounded-[14px] bg-[#FDF8F3] p-[13px]">
          <div className="mb-[9px] flex items-center gap-[7px]">
            <MonitorCheck size={15} className="text-[#E85D4C]" />
            <h3 className="text-[13px] font-bold text-[#1A1A1A]">交付门禁</h3>
          </div>
          <div className="grid grid-cols-1 gap-[7px] md:grid-cols-2">
            {gates.length > 0 ? gates.map((item) => <ReleaseGateRow key={item.id} item={item} />) : (
              <p className="rounded-[10px] bg-white px-[10px] py-[8px] text-[12px] text-[#6B6B6B]">等待发布门禁报告</p>
            )}
          </div>
        </div>

        <div className="rounded-[14px] bg-[#FDF8F3] p-[13px]">
          <div className="mb-[9px] flex items-center gap-[7px]">
            <AlertCircle size={15} className="text-[#E85D4C]" />
            <h3 className="text-[13px] font-bold text-[#1A1A1A]">外部分发阻断</h3>
          </div>
          <div className="space-y-[6px]">
            {(blockers.length ? blockers : ["当前没有外部分发阻断项"]).slice(0, 6).map((item) => (
              <p key={item} className="break-words rounded-[10px] bg-white px-[10px] py-[8px] text-[12px] leading-[1.55] text-[#6B6B6B] [overflow-wrap:anywhere]">
                {item}
              </p>
            ))}
          </div>
          <div className="mt-[10px] space-y-[6px]">
            {actions.slice(0, 4).map((item) => (
              <p key={item} className="break-words rounded-[10px] bg-white px-[10px] py-[8px] text-[12px] leading-[1.55] text-[#6B6B6B] [overflow-wrap:anywhere]">
                {item}
              </p>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function ReleaseGateRow({ item }: { item: DesktopReleaseGate }) {
  const tone = releaseGateTone(item.status);
  return (
    <div className="min-w-0 rounded-[10px] bg-white px-[10px] py-[8px]">
      <div className="flex items-center justify-between gap-[8px]">
        <span className="truncate text-[12px] font-bold text-[#1A1A1A]" title={item.label}>{item.label}</span>
        <span className={`shrink-0 rounded-full px-[7px] py-[3px] text-[10px] font-bold ${tone.badge}`}>{tone.label}</span>
      </div>
      <p className="mt-[5px] truncate text-[11px] text-[#6B6B6B]" title={item.detail || "-"}>{item.detail || "-"}</p>
    </div>
  );
}

function DiagnosticGroup({
  icon: Icon,
  title,
  items,
}: {
  icon: typeof Terminal;
  title: string;
  items: DiagnosticItem[];
}) {
  return (
    <div className="rounded-[14px] bg-[#FDF8F3] p-[13px]">
      <div className="mb-[9px] flex items-center gap-[7px]">
        <Icon size={15} className="text-[#E85D4C]" />
        <h3 className="text-[13px] font-bold text-[#1A1A1A]">{title}</h3>
      </div>
      <div className="grid grid-cols-1 gap-[7px] sm:grid-cols-2">
        {items.length > 0 ? items.map((item) => <DiagnosticRow key={item.id} item={item} />) : (
          <p className="rounded-[10px] bg-white px-[10px] py-[8px] text-[12px] text-[#6B6B6B]">等待诊断结果</p>
        )}
      </div>
    </div>
  );
}

function DiagnosticRow({ item }: { item: DiagnosticItem }) {
  const tone = diagnosticTone(item.status);
  return (
    <div className="min-w-0 rounded-[10px] bg-white px-[10px] py-[8px]">
      <div className="flex items-center justify-between gap-[8px]">
        <span className="truncate text-[12px] font-bold text-[#1A1A1A]" title={item.label}>{item.label}</span>
        <span className={`shrink-0 rounded-full px-[7px] py-[3px] text-[10px] font-bold ${tone.badge}`}>{tone.label}</span>
      </div>
      <p className="mt-[5px] truncate font-mono text-[11px] text-[#6B6B6B]" title={item.version || item.detail || "-"}>{item.version || item.detail || "-"}</p>
      {item.version && item.detail && (
        <p className="mt-[4px] truncate text-[11px] text-[#9A9A9A]" title={item.detail}>{item.detail}</p>
      )}
    </div>
  );
}

function diagnosticTone(status: DiagnosticStatus) {
  if (status === "pass") {
    return {
      label: "通过",
      badge: "bg-[#EAF8EF] text-[#16803C]",
      iconBg: "bg-[#EAF8EF]",
      iconText: "text-[#16803C]",
    };
  }
  if (status === "warn") {
    return {
      label: "提醒",
      badge: "bg-[#FFF3DA] text-[#A35E00]",
      iconBg: "bg-[#FFF3DA]",
      iconText: "text-[#A35E00]",
    };
  }
  return {
    label: "阻断",
    badge: "bg-[#FFF2EF] text-[#E85D4C]",
    iconBg: "bg-[#FFF2EF]",
    iconText: "text-[#E85D4C]",
  };
}

function releaseGateTone(status: DesktopReleaseGateStatus) {
  if (status === "pass") return diagnosticTone("pass");
  if (status === "warn" || status === "missing") return diagnosticTone("warn");
  return diagnosticTone("fail");
}

function releaseReadinessTone(status: DesktopReleaseReadiness["status"]) {
  if (status === "external_ready") {
    return {
      label: "正式可发布",
      badge: "bg-[#EAF8EF] text-[#16803C]",
      iconBg: "bg-[#EAF8EF]",
      iconText: "text-[#16803C]",
    };
  }
  if (status === "internal_ready_external_blocked") {
    return {
      label: "内测可用",
      badge: "bg-[#FFF3DA] text-[#A35E00]",
      iconBg: "bg-[#FFF3DA]",
      iconText: "text-[#A35E00]",
    };
  }
  if (status === "missing_reports") {
    return {
      label: "待生成报告",
      badge: "bg-[#F7F7F7] text-[#6B6B6B]",
      iconBg: "bg-[#F7F7F7]",
      iconText: "text-[#6B6B6B]",
    };
  }
  return {
    label: "需要处理",
    badge: "bg-[#FFF2EF] text-[#E85D4C]",
    iconBg: "bg-[#FFF2EF]",
    iconText: "text-[#E85D4C]",
  };
}

function projectSourceLabel(source?: string) {
  const map: Record<string, string> = {
    env: "启动参数",
    "env-default": "默认启动参数",
    saved: "上次选择",
    default: "默认目录",
  };
  return map[source || ""] || "未识别";
}

function ParamControl({
  id,
  label,
  value,
  min,
  max,
  step,
  helper,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  helper: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="rounded-[13px] bg-white p-[12px]">
      <div className="mb-[8px] flex items-center justify-between gap-[10px]">
        <Label htmlFor={`${id}-number`} className="text-[13px] font-bold text-[#1A1A1A]">{label}</Label>
        <Input
          id={`${id}-number`}
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-describedby={`${id}-help`}
          className="h-[32px] w-[100px] rounded-[10px] border border-[rgba(28,28,30,0.1)] px-[9px] text-[13px] focus-visible:ring-0"
        />
      </div>
      <input
        id={`${id}-range`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={`${label}调整滑块`}
        aria-describedby={`${id}-help`}
        className="h-[5px] w-full accent-[#E85D4C]"
      />
      <p id={`${id}-help`} className="mt-[7px] text-[12px] leading-[1.5] text-[#6B6B6B]">{helper}</p>
    </div>
  );
}

function formatReportTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未记录有效时间";
  return date.toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
