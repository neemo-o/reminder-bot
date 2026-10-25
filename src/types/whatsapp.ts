/**
 * Informações de mídia de áudio extraídas de uma mensagem do WhatsApp.
 * Preenchido pelo cliente quando a mensagem é de áudio/voz e o media é baixado.
 */
export interface AudioMedia {
  /** Buffer com os dados de áudio brutos (OGG Opus do WhatsApp ou outro formato). */
  buffer: Buffer;
  /** MIME type reportado pelo WhatsApp (ex: audio/ogg; codecs=opus). */
  mimeType: string;
  /** Nome do arquivo sugerido (ex: audio.ogg). */
  fileName: string;
  /** Duração em segundos, quando disponível. */
  seconds?: number;
}

export interface IncomingMessage {
  id: string;
  fromJid: string; // remoteJid e.g. "5511999999999@s.whatsapp.net"
  senderPhone: string; // extracted phone number e.g. "5511999999999"
  isGroup: boolean;
  participant?: string;
  senderPn?: string;
  text: string;
  timestamp: number;
  /** Tipo de mídia detectado: 'audio', 'voice', 'image', 'video', 'document' ou null. */
  mediaType: string | null;
  /** Dados de áudio baixados, preenchido apenas quando mediaType é 'audio' ou 'voice'. */
  audio: AudioMedia | null;
}
