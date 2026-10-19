import { describe, it, expect } from 'vitest';
import { validateRecurrence } from '../reminder/recurrence.validate.js';

describe('validateRecurrence - validação de regras de recorrência', () => {
  it('aceita daily válido', () => {
    expect(validateRecurrence({ type: 'daily' })).toEqual({ type: 'daily' });
  });

  it('aceita weekly com dias válidos', () => {
    expect(validateRecurrence({ type: 'weekly', daysOfWeek: [1, 3] })).toEqual({
      type: 'weekly',
      daysOfWeek: [1, 3],
    });
  });

  it('aceita monthly com dia válido (1 e 31)', () => {
    expect(validateRecurrence({ type: 'monthly', dayOfMonth: 1 })).toEqual({
      type: 'monthly',
      dayOfMonth: 1,
    });
    expect(validateRecurrence({ type: 'monthly', dayOfMonth: 31 })).toEqual({
      type: 'monthly',
      dayOfMonth: 31,
    });
  });

  it('aceita interval com ms positivo', () => {
    expect(validateRecurrence({ type: 'interval', intervalMs: 3600000 })).toEqual({
      type: 'interval',
      intervalMs: 3600000,
    });
  });

  it('rejeita weekly sem dias (array vazio)', () => {
    expect(validateRecurrence({ type: 'weekly', daysOfWeek: [] })).toBeNull();
  });

  it('rejeita weekly com dia inválido (9)', () => {
    expect(validateRecurrence({ type: 'weekly', daysOfWeek: [9] })).toBeNull();
  });

  it('rejeita weekly com dia negativo (-1)', () => {
    expect(validateRecurrence({ type: 'weekly', daysOfWeek: [-1] })).toBeNull();
  });

  it('rejeita monthly com dia 0', () => {
    expect(validateRecurrence({ type: 'monthly', dayOfMonth: 0 })).toBeNull();
  });

  it('rejeita monthly com dia 32', () => {
    expect(validateRecurrence({ type: 'monthly', dayOfMonth: 32 })).toBeNull();
  });

  it('rejeita interval com 0', () => {
    expect(validateRecurrence({ type: 'interval', intervalMs: 0 })).toBeNull();
  });

  it('rejeita interval com negativo', () => {
    expect(validateRecurrence({ type: 'interval', intervalMs: -1000 })).toBeNull();
  });

  it('rejeita tipo desconhecido', () => {
    expect(validateRecurrence({ type: 'unknown' as any })).toBeNull();
  });

  it('rejeita null', () => {
    expect(validateRecurrence(null)).toBeNull();
  });

  it('rejeita undefined', () => {
    expect(validateRecurrence(undefined)).toBeNull();
  });

  it('rejeita objeto sem type', () => {
    expect(validateRecurrence({ daysOfWeek: [1] } as any)).toBeNull();
  });
});
