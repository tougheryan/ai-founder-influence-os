'use client';

import { useEffect } from 'react';
import { useConfigStore } from '@/store/pipelineStore';

export function ConfigHydrator() {
  const { setConfig } = useConfigStore();

  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json())
      .then((data) => {
        if (data.config) {
          setConfig(data.config);
        }
      })
      .catch(() => {
        // ignore
      });
  }, [setConfig]);

  return null;
}
