import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { config } from './config.js';

export const SETTINGS_PATH = 'settings.json';

export interface EditableConfig {
  testPhoneNumber: string;
  databasePath: string;
  logLevel: string;
  nvidiaBaseUrl: string;
  nvidiaModel: string;
}

/** Chaves que exigem reinicialização do bot para surtir efeito. */
export const REQUIRES_RESTART: Array<keyof EditableConfig> = [
  'databasePath',
  'nvidiaBaseUrl',
  'nvidiaModel',
];

const DEFAULTS: EditableConfig = {
  testPhoneNumber: '',
  databasePath: 'reminder_bot.db',
  logLevel: 'info',
  nvidiaBaseUrl: 'https://integrate.api.nvidia.com/v1',
  nvidiaModel: 'nvidia/nemotron-mini-4b-instruct',
};

const LOG_LEVELS: Array<EditableConfig['logLevel']> = [
  'debug',
  'info',
  'warn',
  'error',
];

export function loadSettings(): EditableConfig {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const raw = readFileSync(SETTINGS_PATH, 'utf8');
      const parsed = JSON.parse(raw) as Partial<EditableConfig>;
      return { ...DEFAULTS, ...parsed };
    }
  } catch {
    // settings.json ausente ou corrompido -> usa defaults
  }
  return { ...DEFAULTS };
}

export function saveSettings(partial: Partial<EditableConfig>): EditableConfig {
  const current = loadSettings();
  const next: EditableConfig = { ...current, ...partial };
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** Grava as configurações editáveis e aplica em tempo real as que não
 *  requerem reiniçição (testPhoneNumber, logLevel). Retorna a lista de
 *  chaves que ainda precisam de reiniçição. */
export function applySettings(
  partial: Partial<EditableConfig>
): { saved: EditableConfig; requiresRestart: Array<keyof EditableConfig> } {
  const saved = saveSettings(partial);

  const requiresRestart: Array<keyof EditableConfig> = [];
  for (const key of Object.keys(partial) as Array<keyof EditableConfig>) {
    if (REQUIRES_RESTART.includes(key)) {
      requiresRestart.push(key);
      continue;
    }
    // Aplica em tempo real no objeto config exportado.
    (config as unknown as Record<string, unknown>)[key] = saved[key];
  }

  return { saved, requiresRestart };
}

export { LOG_LEVELS };
