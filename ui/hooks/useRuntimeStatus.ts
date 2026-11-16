'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePipelineStore } from '@/store/pipelineStore';

export interface RuntimeFile {
  name: string;
  path: string;
  modifiedAt: string;
}

export interface RuntimeStatus {
	  latest?: {
	    current_step: string | null;
	    current_slug?: string | null;
	    active_run_id?: string | null;
	    latest_files: Record<string, string | null>;
	    scoped_latest_files?: Record<string, string | null>;
	    global_latest_files?: Record<string, string | null>;
	  };
	  sessionState?: Record<string, unknown>;
	  pipelineFiles?: RuntimeFile[];
	  project?: string | Record<string, unknown>;
}

export function useRuntimeStatus() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const hydrateFromStatus = usePipelineStore((s) => s.hydrateFromStatus);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      if (!data.error) {
        setStatus(data);
        hydrateFromStatus(data);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [hydrateFromStatus]);

	  useEffect(() => {
	    void Promise.resolve().then(refresh);
	  }, [refresh]);

  return { status, loading, refresh };
}
