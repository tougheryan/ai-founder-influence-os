import { describe, expect, it } from 'vitest';
import { RuntimeBinaryResolutionError, runtimePythonBinary } from './runtime-binary';

describe('runtimePythonBinary', () => {
  it('uses the bundled absolute Python path in desktop mode', () => {
    expect(runtimePythonBinary({
      AIFIOS_DESKTOP: '1',
      AIFIOS_DESKTOP_PYTHON_BINARY: '/Applications/AIFIOS.app/Contents/Resources/python/bin/python3',
    })).toBe('/Applications/AIFIOS.app/Contents/Resources/python/bin/python3');
  });

  it('rejects a missing or relative Python path in desktop mode', () => {
    expect(() => runtimePythonBinary({ AIFIOS_DESKTOP: '1' })).toThrow(RuntimeBinaryResolutionError);
    expect(() => runtimePythonBinary({
      AIFIOS_DESKTOP: '1',
      AIFIOS_PYTHON: 'python3',
    })).toThrow(RuntimeBinaryResolutionError);
  });

  it('keeps the normal development fallback', () => {
    expect(runtimePythonBinary({})).toBe('python3');
    expect(runtimePythonBinary({ AIFIOS_PYTHON: '/opt/aifios/python3' })).toBe('/opt/aifios/python3');
    expect(runtimePythonBinary({ AIFIOS_PYTHON: 'python-custom' })).toBe('python3');
  });
});
