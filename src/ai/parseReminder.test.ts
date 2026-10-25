import { describe, it, expect } from 'vitest';
import { parseReminderDeterministic, extractTime } from './parseReminder.js';

const HOUR = 3600 * 1000;
// Sexta-feira, 16/10/2026, 10:00 (hora local)
const NOW = new Date(2026, 9, 16, 10, 0, 0, 0).getTime();

const local = (y: number, mo: number, d: number, h: number, mi: number): number =>
  new Date(y, mo, d, h, mi, 0, 0).getTime();

describe('parseReminderDeterministic', () => {
  it('relativo: "daqui a 2 horas"', () => {
    const r = parseReminderDeterministic('Me lembre daqui a 2 horas para tomar meu remedio', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.trigger_at).toBe(NOW + 2 * HOUR);
    expect(r.message.toLowerCase()).toContain('remedio');
  });

  it('relativo: "daqui a 30 minutos"', () => {
    const r = parseReminderDeterministic('me lembre daqui a 30 minutos de ligar pro medico', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.trigger_at).toBe(NOW + 30 * 60 * 1000);
  });

  it('"amanhã 10h" (sem "às") dispara amanhã às 10:00', () => {
    const r = parseReminderDeterministic('lembre me de reunião amanhã 10h', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.trigger_at).toBe(local(2026, 9, 17, 10, 0));
  });

  it('"amanhã às 15h30" dispara amanhã às 15:30', () => {
    const r = parseReminderDeterministic('lembre me de reuniao amanhã às 15h30', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.trigger_at).toBe(local(2026, 9, 17, 15, 30));
  });

  it('"dia 21 desse mês" (frase exata do usuário) dispara dia 21 às 09:00', () => {
    const r = parseReminderDeterministic('Me lembre dia 21 desse mês, a ir no médico', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.trigger_at).toBe(local(2026, 9, 21, 9, 0));
  });

  it('"dia 5 desse mês" no passado vai para o mês seguinte', () => {
    const r = parseReminderDeterministic('me lembre dia 5 desse mês de pagar boleto', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.trigger_at).toBe(local(2026, 10, 5, 9, 0));
  });

  it('"todo dia às 8h" tem recorrência diária e primeiro disparo no próximo 08:00', () => {
    const r = parseReminderDeterministic('me avisa todo dia às 8h pra tomar café', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.recurrence).toEqual({ type: 'daily' });
    expect(r.trigger_at).toBe(local(2026, 9, 17, 8, 0));
  });

  it('"toda segunda às 19h" tem recorrência semanal e dispara na próxima segunda 19:00', () => {
    const r = parseReminderDeterministic('toda segunda às 19h academia', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.recurrence).toEqual({ type: 'weekly', daysOfWeek: [1] });
    // NOW é sexta 16/10 -> próxima segunda é 19/10
    expect(r.trigger_at).toBe(local(2026, 9, 19, 19, 0));
  });

  it('"a cada 2 horas" tem recorrência de intervalo', () => {
    const r = parseReminderDeterministic('a cada 2 horas beber água', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.recurrence).toEqual({ type: 'interval', intervalMs: 2 * HOUR });
    expect(r.trigger_at).toBe(NOW + 2 * HOUR);
  });

  it('"me lembra de tomar água às 14:30" dispara hoje às 14:30 (horário ainda futuro)', () => {
    const r = parseReminderDeterministic('me lembra de tomar água às 14:30', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.trigger_at).toBe(local(2026, 9, 16, 14, 30));
  });

  it('hora já passada hoje ("às 4h") vai para amanhã', () => {
    const r = parseReminderDeterministic('me lembre de dormir às 4h', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.trigger_at).toBe(local(2026, 9, 17, 4, 0));
  });

  it('"amanhã" sem hora usa padrão 09:00', () => {
    const r = parseReminderDeterministic('lembre me de comprar pão amanhã', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.trigger_at).toBe(local(2026, 9, 17, 9, 0));
  });

  it('mensagem sem intenção de lembrete não é aceita', () => {
    const r = parseReminderDeterministic('oi, tudo bem?', NOW);
    expect(r.isReminderRequest).toBe(false);
    expect(r.trigger_at).toBe(0);
  });

  it('string vazia não é lembrete', () => {
    const r = parseReminderDeterministic('', NOW);
    expect(r.isReminderRequest).toBe(false);
  });

  it('"compras 15 minutos" não vira lembrete (sem palavra de intenção)', () => {
    const r = parseReminderDeterministic('compras 15 minutos', NOW);
    expect(r.isReminderRequest).toBe(false);
  });

  it('frase sem palavra-chave mas com hora vira lembrete (áudio transcrito)', () => {
    const r = parseReminderDeterministic('tomar remédio às 14h', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.trigger_at).toBeGreaterThan(NOW);
  });

  it('frase com "daqui a X horas" sem palavra-chave vira lembrete', () => {
    const r = parseReminderDeterministic('beber água daqui a 30 minutos', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.trigger_at).toBe(NOW + 30 * 60 * 1000);
  });

  it('frase com amanhã sem palavra-chave vira lembrete', () => {
    const r = parseReminderDeterministic('reunião amanhã 10h', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.trigger_at).toBeGreaterThan(NOW);
  });

  it('"lembrar de comprar 2 pizzas amanhã" não confunde "2" com hora', () => {
    const r = parseReminderDeterministic('lembrar de comprar 2 pizzas amanhã', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.trigger_at).toBe(local(2026, 9, 17, 9, 0));
  });

  it('"próximo domingo" dispara no próximo domingo', () => {
    const r = parseReminderDeterministic('me lembre próximo domingo que eu tenho médico', NOW);
    expect(r.isReminderRequest).toBe(true);
    // NOW é sexta 16/10 -> próximo domingo é 18/10, mantém horário 10:00
    expect(r.trigger_at).toBe(local(2026, 9, 18, 10, 0));
  });

  it('"proximo domingo" (sem acento) também funciona', () => {
    const r = parseReminderDeterministic('me lembre proximo domingo', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.trigger_at).toBe(local(2026, 9, 18, 10, 0));
  });

  it('"no domingo" dispara no próximo domingo', () => {
    const r = parseReminderDeterministic('me lembre no domingo que tenho consulta', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.trigger_at).toBe(local(2026, 9, 18, 10, 0));
  });

  it('"domingo" isolado dispara no próximo domingo', () => {
    const r = parseReminderDeterministic('me lembre domingo', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.trigger_at).toBe(local(2026, 9, 18, 10, 0));
  });

  it('"próxima segunda" dispara na próxima segunda', () => {
    const r = parseReminderDeterministic('me lembre próxima segunda', NOW);
    expect(r.isReminderRequest).toBe(true);
    // NOW é sexta 16/10 -> próxima segunda é 19/10
    expect(r.trigger_at).toBe(local(2026, 9, 19, 10, 0));
  });

  it('"daqui a 2 semanas" dispara daqui a 14 dias', () => {
    const r = parseReminderDeterministic('me lembre daqui a 2 semanas', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.trigger_at).toBe(local(2026, 9, 30, 10, 0));
  });

  it('"daqui a 2 domingos" dispara em 2 domingos', () => {
    const r = parseReminderDeterministic('me lembre daqui a 2 domingos', NOW);
    expect(r.isReminderRequest).toBe(true);
    // Próximo domingo é 18/10, + 7 dias = 25/10
    expect(r.trigger_at).toBe(local(2026, 9, 25, 10, 0));
  });

  it('"próximo domingo às 15h" aplica o horário', () => {
    const r = parseReminderDeterministic('me lembre próximo domingo às 15h', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.trigger_at).toBe(local(2026, 9, 18, 15, 0));
  });

  it('"todo domingo" ainda é recorrência semanal (não vira dia único)', () => {
    const r = parseReminderDeterministic('me lembre todo domingo', NOW);
    expect(r.isReminderRequest).toBe(true);
    expect(r.recurrence).toEqual({ type: 'weekly', daysOfWeek: [0] });
  });
});

describe('extractTime', () => {
  it('aceita "às 14", "às 14h", "às 14h30", "às 14:30", "10h", "10:00"', () => {
    expect(extractTime('às 14')).toEqual({ h: 14, m: 0 });
    expect(extractTime('às 14h')).toEqual({ h: 14, m: 0 });
    expect(extractTime('às 14h30')).toEqual({ h: 14, m: 30 });
    expect(extractTime('às 14:30')).toEqual({ h: 14, m: 30 });
    expect(extractTime('amanhã 10h')).toEqual({ h: 10, m: 0 });
    expect(extractTime('as 10:00')).toEqual({ h: 10, m: 0 });
  });

  it('rejeita horas inválidas e números colados em palavras', () => {
    expect(extractTime('às 25h')).toBeNull();
    expect(extractTime('às 12:99')).toBeNull();
    expect(extractTime('compras 15 minutos')).toBeNull();
    expect(extractTime('sem hora aqui')).toBeNull();
  });
});
