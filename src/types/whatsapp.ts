export interface IncomingMessage {
  id: string;
  fromJid: string; // remoteJid e.g. "5511999999999@s.whatsapp.net"
  senderPhone: string; // extracted phone number e.g. "5511999999999"
  isGroup: boolean;
  participant?: string;
  senderPn?: string;
  text: string;
  timestamp: number;
}
