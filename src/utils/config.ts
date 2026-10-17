import dotenv from 'dotenv';
dotenv.config();

export interface Config {
  nvidiaApiKey: string;
  nvidiaBaseUrl: string;
  nvidiaModel: string;
  testPhoneNumber: string;
  databasePath: string;
  logLevel: string;
}

export const config: Config = {
  nvidiaApiKey: process.env.NVIDIA_API_KEY || '',
  nvidiaBaseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
  nvidiaModel: process.env.NVIDIA_MODEL || 'nvidia/nemotron-mini-4b-instruct',
  testPhoneNumber: process.env.TEST_PHONE_NUMBER || '',
  databasePath: process.env.DATABASE_PATH || 'reminder_bot.db',
  logLevel: process.env.LOG_LEVEL || 'info',
};
