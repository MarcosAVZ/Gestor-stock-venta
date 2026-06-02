import { describe, expect, test } from 'vitest';
import { VERSION } from '../src/index.js';

describe('@compras-whatsapp/shared', () => {
  test('VERSION is the MVP baseline', () => {
    // Smoke test: confirma que el path alias desde tests/ a ../src/ resuelve,
    // que el type stripping acepta la importación, y que el valor exportado
    // no fue modificado accidentalmente. Es un test barato pero detecta
    // regresiones en la configuración del workspace.
    expect(VERSION).toBe('0.1.0');
  });
});
