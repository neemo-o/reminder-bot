import dotenv from 'dotenv';
dotenv.config();

export interface Config {
  nvidiaApiKey: string;
  nvidiaBaseUrl: string;
  nvidiaModel: string;
  testPhoneNumber: string;
  databasePath: string;
  logLevel: string;
  /** Caminho do binário ffmpeg (para conversão de áudio). */
  ffmpegPath: string;
  /** Habilita/desabilita transcrição local de áudio. */
  audioTranscriptionEnabled: boolean;
  /** Modelo Whisper usado para transcrição local. */
  whisperModel: string;
  /** Idioma forçado na transcrição (ex: 'portuguese', 'english' ou undefined). */
  whisperLanguage: string | undefined;
}

export const config: Config = {
  nvidiaApiKey: process.env.NVIDIA_API_KEY || '',
  nvidiaBaseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
  nvidiaModel: process.env.NVIDIA_MODEL || 'nvidia/nemotron-mini-4b-instruct',
  testPhoneNumber: process.env.TEST_PHONE_NUMBER || '',
  databasePath: process.env.DATABASE_PATH || 'reminder_bot.db',
  logLevel: process.env.LOG_LEVEL || 'info',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  audioTranscriptionEnabled:
    process.env.AUDIO_TRANSCRIPTION_ENABLED !== 'false',
  whisperModel: process.env.WHISPER_MODEL || 'Xenova/whisper-small',
  whisperLanguage: process.env.WHISPER_LANGUAGE || undefined,
};
