import { z } from 'zod';

export const RecurrenceRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('daily') }),

  z.object({
    type: z.literal('weekly'),
    daysOfWeek: z
      .array(z.number().int().min(0).max(6))
      .nonempty('weekly exige pelo menos um dia da semana')
      .max(7, 'dias da semana não podem se repetir'),
  }),

  z.object({
    type: z.literal('monthly'),
    dayOfMonth: z.number().int().min(1).max(31, 'dia do mês deve ser entre 1 e 31'),
  }),

  z.object({
    type: z.literal('interval'),
    intervalMs: z
      .number()
      .int()
      .positive('intervalo deve ser maior que zero')
      .max(365 * 24 * 3600 * 1000, 'intervalo muito grande'),
  }),
]);

export type ValidatedRecurrence = z.infer<typeof RecurrenceRuleSchema>;

/**
 * Valida uma regra de recorrência vinda do parser (LLM ou determinístico).
 * Retorna a regra normalizada ou null quando inválida — nunca lança.
 */
export function validateRecurrence(rule: unknown): ValidatedRecurrence | null {
  const result = RecurrenceRuleSchema.safeParse(rule);
  return result.success ? result.data : null;
}
