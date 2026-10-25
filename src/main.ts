import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { config } from './utils/config.js';
import { initDb } from './db/init.js';
import { UserRepo } from './db/userRepo.js';
import { ReminderRepo } from './db/reminderRepo.js';
import { createWhatsAppClient } from './whatsapp/client.js';
import { createWebDashboard } from './web/dashboard.js';
import { MessageProcessor } from './reminder/processor.js';
import { ReminderScheduler } from './reminder/scheduler.js';
import { WhisperTranscriber, FakeTranscriber } from './audio/transcriber.js';
import { ensureFfmpegAvailable } from './audio/audio-converter.js';

const logger = pino({ level: config.logLevel, transport: { target: 'pino-pretty' } });

async function main(): Promise<void> {
  logger.info('Iniciando WhatsApp Reminder Bot...');
  logger.info(`Modelo NIM: ${config.nvidiaModel}`);

  const maskedPhone = config.testPhoneNumber
    ? `${'*'.repeat(Math.max(0, config.testPhoneNumber.length - 4))}${config.testPhoneNumber.slice(-4)}`
    : '';
  logger.info(
    config.testPhoneNumber
      ? `Filtro TEST_PHONE_NUMBER: ATIVO (${config.testPhoneNumber})`
      : 'Filtro TEST_PHONE_NUMBER: desativado (aceita qualquer número)'
  );

  // Verificação de disponibilidade da IA no startup
  logger.info('Verificando disponibilidade da IA (NVIDIA NIM)...');
  try {
    const { createAiClient } = await import('./ai/client.js');
    const aiClient = createAiClient();
    const testRes = await aiClient.chat.completions.create({
      model: config.nvidiaModel,
      messages: [{ role: 'user', content: 'responda "ok"' }],
      max_tokens: 5,
    });
    const reply = testRes.choices[0]?.message?.content?.trim() || '';
    logger.info(`✅ IA disponível e respondendo! (resposta: "${reply}")`);
  } catch (err: any) {
    logger.warn(`⚠️ IA indisponível ou com erro: ${err?.message || err}. O bot continuará com o parser determinístico de fallback.`);
  }

  const db = initDb(config.databasePath);
  const userRepo = new UserRepo(db);
  const reminderRepo = new ReminderRepo(db);

  // Verifica disponibilidade do ffmpeg para conversão de áudio
  try {
    await ensureFfmpegAvailable();
    logger.info(`✅ ffmpeg disponível: ${config.ffmpegPath}`);
  } catch (err: any) {
    logger.warn(
      `⚠️ ffmpeg não encontrado (${config.ffmpegPath}). Áudios não poderão ser convertidos para transcrição. Erro: ${err?.message ?? err}`,
    );
  }

  // Transcritor local de áudio (Whisper via @xenova/transformers)
  let audioTranscriber: WhisperTranscriber | FakeTranscriber | undefined;
  if (config.audioTranscriptionEnabled) {
    try {
      audioTranscriber = new WhisperTranscriber({
        modelName: config.whisperModel,
        language: config.whisperLanguage,
      });
      const ok = await audioTranscriber.isAvailable();
      if (ok) {
        logger.info(`✅ Transcritor Whisper inicializado (modelo: ${config.whisperModel})`);
      } else {
        logger.warn('⚠️ WhisperTranscriber não pôde ser inicializado. Áudios não serão transcritos.');
        audioTranscriber = undefined;
      }
    } catch (err: any) {
      logger.warn(
        `⚠️ Falha ao inicializar WhisperTranscriber: ${err?.message ?? err}. Áudios não serão transcritos.`,
      );
      audioTranscriber = undefined;
    }
  } else {
    logger.info('Transcrição de áudio desabilitada via AUDIO_TRANSCRIPTION_ENABLED=false');
  }

  // Servidor web do painel local (métricas + sessão WhatsApp).
  const dashboard = createWebDashboard({ db, port: 3333 });
  await dashboard.start();
  logger.info(`Painel de controle: ${dashboard.url()}`);

  let processor: MessageProcessor | null = null;
  const wa = createWhatsAppClient({
    onMessage: (msg) => {
      void processor?.handleIncoming(msg);
    },
    onQr: (qr) => {
      dashboard.setQr(qr);
    },
    onConnected: (phone) => {
      dashboard.setConnected(phone);
    },
    onDisconnected: () => {
      dashboard.setDisconnected();
    },
  });

  processor = new MessageProcessor({
    userRepo,
    reminderRepo,
    sender: wa,
    testPhoneNumber: config.testPhoneNumber,
    getTestPhoneNumber: () => config.testPhoneNumber,
    audioTranscriber,
  });

  const scheduler = new ReminderScheduler({ reminderRepo, sender: wa });

  await wa.start();
  scheduler.start();
  logger.info('Bot em execução. Pressione Ctrl+C para encerrar.');

  const shutdown = (signal: string): void => {
    logger.info(`Recebido ${signal}. Encerrando...`);
    scheduler.stop();
    dashboard.stop();
    void wa.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const invokedAsMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsMain) {
  main().catch((err) => {
    logger.fatal(err, 'Erro fatal');
    process.exit(1);
  });
}
