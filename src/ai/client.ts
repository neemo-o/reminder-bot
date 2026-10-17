import OpenAI from 'openai';
import { config } from '../utils/config.js';

export function createAiClient(apiKey?: string, baseUrl?: string): OpenAI {
  return new OpenAI({
    baseURL: baseUrl || config.nvidiaBaseUrl,
    apiKey: apiKey || config.nvidiaApiKey,
    timeout: 10000, // 10s timeout
    maxRetries: 1,
  });
}
