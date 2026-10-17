import OpenAI from 'openai';
import { ParseReminderResult, RecurrenceRule } from '../types/index.js';
import { config } from '../utils/config.js';
import { createAiClient } from './client.js';

export const SYSTEM_PROMPT = `Você é um assistente especialista em extrair lembretes de mensagens de texto em Português ou Inglês.
Dada uma mensagem do usuário e o timestamp atual em milissegundos UTC (e/ou data ISO atual), identifique se o usuário deseja agendar um lembrete.

Responda ESTRITAMENTE em formato JSON sem marcadores de markdown adicionais com a seguinte estrutura:
{
  "isReminderRequest": boolean,
  "message": string, // O texto do lembrete (ex: "comprar leite")
  "trigger_at": number, // Timestamp Unix UTC em milissegundos do primeiro disparo
  "recurrence": object | null, // Regra de recorrência se houver, ex: {"type": "daily"} ou {"type": "weekly", "daysOfWeek": [1]} ou {"type": "monthly", "dayOfMonth": 15} ou {"type": "interval", "intervalMs": 3600000}
  "confidence": number // Valor numérico entre 0.0 e 1.0
}

Regras:
- "daqui a X minutos/horas/dias": adicione o offset ao tempo atual.
- "amanhã às HH:MM": calcule o timestamp do próximo dia no horário especificado.
- "dia DD deste mês": calcule o timestamp do dia DD do mês atual.
- Recorrências:
  - "todo dia" / "todos os dias" / "diariamente": {"type": "daily"}
  - "toda segunda" / "todas as segundas": {"type": "weekly", "daysOfWeek": [1]}
  - "todo mês" / "mensalmente": {"type": "monthly", "dayOfMonth": <dia>}
  - "a cada X horas/minutos": {"type": "interval", "intervalMs": <ms>}
`;

/**
 * Parses user message using LLM (if configured) or fallback rule-based parser.
 */
export async function parseReminder(
  text: string,
  nowMs: number = Date.now(),
  aiClient?: OpenAI
): Promise<ParseReminderResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      isReminderRequest: false,
      message: '',
      trigger_at: 0,
      recurrence: null,
      confidence: 0,
    };
  }

  // Attempt LLM parsing if client is provided or if API key is present
  const client = aiClient || (config.nvidiaApiKey && config.nvidiaApiKey !== 'dummy_key_for_test' ? createAiClient() : null);

  if (client) {
    try {
      const nowIso = new Date(nowMs).toISOString();
      const response = await client.chat.completions.create({
        model: config.nvidiaModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Timestamp atual (ms UTC): ${nowMs} (${nowIso}).\nMensagem: "${trimmed}"`,
          },
        ],
        temperature: 0.1,
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (content) {
        // Clean JSON formatting if wrapped in ```json ... ```
        const jsonStr = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        const parsed = JSON.parse(jsonStr);
        if (typeof parsed.isReminderRequest === 'boolean') {
          return {
            isReminderRequest: parsed.isReminderRequest,
            message: parsed.message || '',
            trigger_at: Number(parsed.trigger_at) || 0,
            recurrence: parsed.recurrence || null,
            confidence: Number(parsed.confidence) || 0.8,
          };
        }
      }
    } catch (err: any) {
      console.warn(`[ai] Falha ao consultar NVIDIA NIM (${err?.message || err}). Usando fallback determinístico.`);
    }
  }

  // Rule-based fallback parser
  return parseReminderDeterministic(trimmed, nowMs);
}

/**
 * Extracts an explicit time-of-day from text.
 * Accepts: "às 14", "às 14h", "às 14h30", "às 14:30", bare "10h", "10h30", "10:00".
 * The prefix must not be glued to another word ("compras 15" must NOT match).
 */
export function extractTime(lowerText: string): { h: number; m: number } | null {
  let m = lowerText.match(/(?:^|[^a-zà-ÿ])(?:às|as|at)\s*(\d{1,2})h(\d{2})?(?=\s|$)/i);
  if (m) return validateTime(parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0);
  m = lowerText.match(/(?:^|[^a-zà-ÿ])(?:às|as|at)\s*(\d{1,2})(?::(\d{2}))?(?=\s|$)/i);
  if (m) return validateTime(parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0);
  m = lowerText.match(/(?:^|[^a-zà-ÿ0-9])(\d{1,2})h(\d{2})?(?=\s|$)/i);
  if (m) return validateTime(parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0);
  m = lowerText.match(/(?:^|[^a-zà-ÿ0-9])(\d{1,2}):(\d{2})(?=\s|$)/i);
  if (m) return validateTime(parseInt(m[1], 10), parseInt(m[2], 10));
  return null;
}

function validateTime(h: number, m: number): { h: number; m: number } | null {
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

/**
 * Next occurrence of one of the target weekdays (0=Sun..6=Sat) at the given
 * time-of-day (or the current clock time when `time` is null), strictly after `fromMs`.
 */
function nextWeeklyOccurrence(
  fromMs: number,
  daysOfWeek: number[],
  time: { h: number; m: number } | null
): number {
  for (let i = 0; i <= 7; i++) {
    const cand = new Date(fromMs);
    cand.setDate(cand.getDate() + i);
    if (time) cand.setHours(time.h, time.m, 0, 0);
    if (cand.getTime() <= fromMs) continue;
    if (daysOfWeek.includes(cand.getDay())) return cand.getTime();
  }
  return fromMs + 7 * 24 * 3600 * 1000;
}

/**
 * Deterministic rule-based parser for Portuguese/English reminder text.
 */
export function parseReminderDeterministic(text: string, nowMs: number = Date.now()): ParseReminderResult {
  const lower = text.toLowerCase();

  // Check keywords for reminder intent
  const reminderKeywords = [
    'lembre', 'lembra', 'lembrar', 'agende', 'agendar', 'remind', 'me avise', 'avisar',
    'daqui a', 'amanhã', 'amanha', 'todo dia', 'toda segunda', 'toda terça',
    'toda quarta', 'toda quinta', 'toda sexta', 'todo sábado', 'todo sabado',
    'todo domingo', 'a cada'
  ];

  const hasKeyword = reminderKeywords.some((kw) => lower.includes(kw));
  if (!hasKeyword) {
    return {
      isReminderRequest: false,
      message: text,
      trigger_at: 0,
      recurrence: null,
      confidence: 0,
    };
  }

  let recurrence: RecurrenceRule | null = null;
  let triggerAt = nowMs;
  let offsetMs = 0;
  // Explicit time-of-day, if any ("às 14:30", "10h", ...)
  const time = extractTime(lower);

  // Extract recurrence rules
  if (lower.includes('todo dia') || lower.includes('todos os dias') || lower.includes('diariamente') || lower.includes('every day')) {
    recurrence = { type: 'daily' };
  } else if (lower.includes('toda segunda') || lower.includes('todas as segundas') || lower.includes('every monday')) {
    recurrence = { type: 'weekly', daysOfWeek: [1] };
  } else if (lower.includes('toda terça') || lower.includes('toda terca') || lower.includes('every tuesday')) {
    recurrence = { type: 'weekly', daysOfWeek: [2] };
  } else if (lower.includes('toda quarta') || lower.includes('every wednesday')) {
    recurrence = { type: 'weekly', daysOfWeek: [3] };
  } else if (lower.includes('toda quinta') || lower.includes('every thursday')) {
    recurrence = { type: 'weekly', daysOfWeek: [4] };
  } else if (lower.includes('toda sexta') || lower.includes('every friday')) {
    recurrence = { type: 'weekly', daysOfWeek: [5] };
  } else if (lower.includes('todo sábado') || lower.includes('todo sabado') || lower.includes('every saturday')) {
    recurrence = { type: 'weekly', daysOfWeek: [6] };
  } else if (lower.includes('todo domingo') || lower.includes('every sunday')) {
    recurrence = { type: 'weekly', daysOfWeek: [0] };
  } else if (lower.includes('todo mês') || lower.includes('todo mes') || lower.includes('todos os meses') || lower.includes('every month')) {
    const nowDate = new Date(nowMs);
    recurrence = { type: 'monthly', dayOfMonth: nowDate.getDate() };
  }

  // Interval recurrence "a cada X horas/minutos"
  const intervalMatch = lower.match(/a cada (\d+)\s*(hora|horas|h|minuto|minutos|min|m)/i);
  if (intervalMatch) {
    const amount = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2].toLowerCase();
    if (unit.startsWith('h')) {
      const intervalMs = amount * 3600 * 1000;
      recurrence = { type: 'interval', intervalMs };
      offsetMs = intervalMs;
    } else if (unit.startsWith('m')) {
      const intervalMs = amount * 60 * 1000;
      recurrence = { type: 'interval', intervalMs };
      offsetMs = intervalMs;
    }
  }

  // Relative offset: "daqui a X minutos/horas/dias" or "in X minutes/hours/days"
  const relativeMatch = lower.match(/(?:daqui a|em|in)\s*(\d+)\s*(minuto|minutos|min|m|hora|horas|h|dia|dias|d)/i);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    if (unit.startsWith('m')) {
      offsetMs = amount * 60 * 1000;
    } else if (unit.startsWith('h')) {
      offsetMs = amount * 3600 * 1000;
    } else if (unit.startsWith('d')) {
      offsetMs = amount * 24 * 3600 * 1000;
    }
    triggerAt = nowMs + offsetMs;
  }

  // Specific day: "amanhã" or "amanha"
  if (lower.includes('amanhã') || lower.includes('amanha') || lower.includes('tomorrow')) {
    const d = new Date(nowMs);
    d.setDate(d.getDate() + 1);

    if (time) {
      d.setHours(time.h, time.m, 0, 0);
    } else {
      // Default to 09:00 if no time specified
      d.setHours(9, 0, 0, 0);
    }
    triggerAt = d.getTime();
  }

  // Specific day of month: "dia DD deste mês" or "dia DD"
  const dayOfMonthMatch = lower.match(/dia (\d{1,2})(?:\s*deste m[êe]s)?/i);
  if (dayOfMonthMatch && !lower.includes('todo dia')) {
    const day = parseInt(dayOfMonthMatch[1], 10);
    const d = new Date(nowMs);
    d.setDate(day);

    if (time) {
      d.setHours(time.h, time.m, 0, 0);
    } else {
      d.setHours(9, 0, 0, 0);
    }
    // If date is in the past for this month, move to next month
    if (d.getTime() < nowMs) {
      d.setMonth(d.getMonth() + 1);
    }
    triggerAt = d.getTime();
    if (recurrence && recurrence.type === 'monthly') {
      recurrence.dayOfMonth = day;
    }
  }

  // Default trigger time if no time offset was parsed
  if (triggerAt === nowMs) {
    if (recurrence?.type === 'weekly' && recurrence.daysOfWeek && recurrence.daysOfWeek.length > 0) {
      // Next matching weekday, at the requested time (or current clock time)
      triggerAt = nextWeeklyOccurrence(nowMs, recurrence.daysOfWeek, time);
    } else if (time) {
      // Bare time-of-day ("às 14:30", "todo dia às 8h"): today if still future, else tomorrow
      const d = new Date(nowMs);
      d.setHours(time.h, time.m, 0, 0);
      if (d.getTime() <= nowMs) {
        d.setDate(d.getDate() + 1);
      }
      triggerAt = d.getTime();
    } else if (recurrence?.type === 'daily') {
      triggerAt = nowMs + 24 * 3600 * 1000;
    } else if (recurrence?.type === 'monthly') {
      const d = new Date(nowMs);
      d.setMonth(d.getMonth() + 1);
      triggerAt = d.getTime();
    } else if (recurrence?.type === 'interval') {
      triggerAt = nowMs + (recurrence.intervalMs ?? 3600 * 1000);
    } else {
      triggerAt = nowMs + 3600 * 1000; // default 1 hour
    }
  }

  // Extract subject message (e.g., strip "me lembre de", "lembre-me de", "agendar", timing keywords)
  let extractedMessage = text
    .replace(/^.*?(?:lembre[- ]me(?: de)?|me lembre(?: de)?|lembrar(?: de)?|agend(?:ar|e)|me avise(?: sobre)?)\s+/i, '')
    .trim();

  if (!extractedMessage || extractedMessage === text) {
    // If prefix wasn't matched, just use the text
    extractedMessage = text;
  }

  return {
    isReminderRequest: true,
    message: extractedMessage,
    trigger_at: triggerAt,
    recurrence,
    confidence: 0.9,
  };
}
