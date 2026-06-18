/**
 * Tests for VentaRepository interface.
 *
 * Verifies:
 * - VentaRepository interface compiles
 * - All methods are defined
 */

import { describe, expect, it } from 'vitest';
import type { VentaRepository } from '../../src/domain/repositories/VentaRepository.ts';

describe('VentaRepository interface', () => {
  it('VentaRepository can be implemented', () => {
    // Verify the interface compiles by implementing a mock
    const mockRepo: VentaRepository = {
      create: async () => ({} as never),
      findByUsuarioId: async () => [],
      findByProductoNombre: async () => [],
      sumIngresos: async () => null,
      sumGananciaTotal: async () => null,
    };
    expect(mockRepo.create).toBeDefined();
    expect(mockRepo.findByUsuarioId).toBeDefined();
    expect(mockRepo.findByProductoNombre).toBeDefined();
    expect(mockRepo.sumIngresos).toBeDefined();
    expect(mockRepo.sumGananciaTotal).toBeDefined();
  });
});
