import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys';
import { mkdirSync } from 'fs';
import pino from 'pino';
import { config } from '../utils/config.js';
import { isPhoneAllowed, normalizePhone } from '../utils/phone.js';
import type { IncomingMessage } from '../types/index.js';

const waLogger = pino({ level: 'silent' });
const SESSION_DIR = './session';

/**
 * Anything that can deliver a text message to a JID.
 * Returns false when the send was blocked (e.g. TEST_PHONE_NUMBER filter),
 * otherwise returns the WhatsApp message id for idempotency tracking.
 */
export interface BotSender {
  sendMessage(jid: string, text: string, messageId?: string): Promise<string | false>;
}

export interface WhatsAppClient extends BotSender {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Callbacks opcionais para expor o estado da sessão a um painel web. */
export interface WhatsAppClientCallbacks {
  onMessage: (msg: IncomingMessage) => void;
  /** Chamado sempre que o Baileys emite o código de emparelhamento (QR). */
  onQr?: (qr: string) => void;
  /** Chamado quando a conexão é aberta (sessão autenticada). */
  onConnected?: (phone: string | null) => void;
  /** Chamado quando a conexão é encerrada. */
  onDisconnected?: () => void;
}

function extractText(message: proto.IMessage): string {
  const conversation = message.conversation as string | null | undefined;
  if (conversation) return conversation;
  const extended = message.extendedTextMessage?.text as string | null | undefined;
  return extended ?? '';
}

/**
 * Creates a Baileys-backed WhatsApp client.
 * Reconnects automatically on connection loss (unless logged out).
 * Only DM text messages are surfaced through onMessage; groups are still
 * delivered as IncomingMessage with isGroup=true so the processor can drop them.
 */
export function createWhatsAppClient(cb: WhatsAppClientCallbacks): WhatsAppClient {
  let sock: WASocket | null = null;
  let running = false;

  async function connect(): Promise<void> {
    mkdirSync(SESSION_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, waLogger),
      },
      logger: waLogger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        // O QR é exposto ao painel web via callback; não imprime mais no console.
        cb.onQr?.(qr);
      }
      if (connection === 'open') {
        const userId = (sock?.user as { id?: string } | null | undefined)?.id;
        const phone = userId && userId.endsWith('@s.whatsapp.net')
          ? normalizePhone(userId.replace('@s.whatsapp.net', ''))
          : userId ?? null;
        console.log('✅ WhatsApp conectado.');
        cb.onConnected?.(phone);
      }
      if (connection === 'close') {
        const statusCode = (
          lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          console.error('❌ Sessão deslogada. Apague a pasta ./session e pareie novamente.');
          running = false;
          cb.onDisconnected?.();
          return;
        }
        if (running) {
          console.log('Conexão fechada. Reconectando em 3s...', lastDisconnect?.error?.message ?? '');
          cb.onDisconnected?.();
          setTimeout(() => {
            void connect();
          }, 3000);
        }
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (!m.message || m.key.fromMe) continue;
        const fromJid = m.key.remoteJid ?? '';
        if (!fromJid) continue;
        const tsRaw = m.messageTimestamp;
        const timestamp = typeof tsRaw === 'number' && tsRaw > 0 ? tsRaw : Date.now();
        const senderPn = (m.key as any).senderPn || (m.key as any).participantPn;
        cb.onMessage({
          id: m.key.id ?? '',
          fromJid,
          senderPhone: normalizePhone(senderPn || fromJid),
          isGroup: fromJid.endsWith('@g.us') || !!m.key.participant,
          participant: m.key.participant ?? undefined,
          senderPn,
          text: extractText(m.message),
          timestamp,
        });
      }
    });
  }

  async function sendMessage(jid: string, text: string, requestedMessageId?: string): Promise<string | false> {
    // If destination is LID or passes phone filter, allow
    const isLid = jid.endsWith('@lid');
    if (!isLid && !isPhoneAllowed(jid, config.testPhoneNumber)) {
      console.warn(`[wa] envio bloqueado pelo filtro TEST_PHONE_NUMBER: ${jid}`);
      return false;
    }
    if (!sock) throw new Error('WhatsApp não conectado');
    const res = await sock.sendMessage(
      jid,
      { text },
      requestedMessageId ? { messageId: requestedMessageId } : undefined
    );
    const messageId = res?.key?.id ?? null;
    return messageId || false;
  }

  return {
    sendMessage,
    start: async () => {
      running = true;
      await connect();
    },
    stop: async () => {
      running = false;
      sock?.end(undefined);
      sock = null;
    },
  };
}
