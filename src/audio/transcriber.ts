import { pipeline, env } from '@xenova/transformers';
import { convertToFloat32Array } from './audio-converter.js';
import type { AudioMedia } from '../types/index.js';

/**
 * Configuração do modelo Whisper usado para transcrição local.
 */
export interface WhisperTranscriberConfig {
  /** Nome ou caminho do modelo no Hugging Face (padrão: Xenova/whisper-small). */
  modelName?: string;
  /** Código de idioma para forçar na transcrição (ex: 'portuguese', 'english'). */
  language?: string;
  /** Diretório local de cache de modelos. */
  cacheDir?: string;
  /** Limite de chunks de áudio em segundos (Whisper processa em chunks de 30s). */
  chunkLengthS?: number;
}

/**
 * Resultado da transcrição.
 */
export interface TranscriptionResult {
  /** Texto transcrito. */
  text: string;
  /** Idioma detectado ou informado. */
  language: string;
}

/**
 * Interface de transcritor de áudio. Permite trocar a implementação
 * (ex: Whisper local, mock para testes, outro provedor local) sem alterar
 * o processador de mensagens.
 */
export interface Transcriber {
  /** Verifica se o transcritor está disponível (modelo carregado, dependências OK). */
  isAvailable(): Promise<boolean>;
  /** Transcreve um buffer de áudio. Lança erro se indisponível. */
  transcribe(audioBuffer: Buffer, mimeType?: string): Promise<TranscriptionResult>;
}

/**
 * Transcritor local baseado em Whisper (@xenova/transformers + ONNX Runtime).
 * Todo o processamento acontece localmente — nenhum áudio é enviado para
 * APIs externas.
 *
 * O modelo é baixado na primeira execução e cacheado em disco
 * (default: ~/.cache/huggingface/transformers ou cacheDir configurado).
 */
export class WhisperTranscriber implements Transcriber {
  private readonly modelName: string;
  private readonly language?: string;
  private readonly chunkLengthS: number;
  private asr: any = null;
  private initializing: Promise<void> | null = null;

  constructor(config: WhisperTranscriberConfig = {}) {
    this.modelName = config.modelName ?? 'Xenova/whisper-small';
    this.language = config.language;
    this.chunkLengthS = config.chunkLengthS ?? 30;

    // Força o uso do ambiente correto do @xenova/transformers
    env.allowLocalModels = true;
    if (config.cacheDir) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (env as any).localModelDir = config.cacheDir;
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.asr) return;
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.asr = await pipeline('automatic-speech-recognition', this.modelName, {
          // dtype: 'q8int' reduz uso de memória com pequena perda de precisão.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
      } catch (err: any) {
        this.initializing = null;
        this.asr = null;
        throw new Error(
          `Falha ao inicializar Whisper (modelo: ${this.modelName}): ${err?.message ?? err}`,
        );
      }
    })();

    return this.initializing;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.ensureInitialized();
      return this.asr !== null;
    } catch {
      return false;
    }
  }

  async transcribe(
    audioBuffer: Buffer,
    mimeType?: string,
  ): Promise<TranscriptionResult> {
    await this.ensureInitialized();
    if (!this.asr) {
      throw new Error('WhisperTranscriber não inicializado');
    }

    // O Whisper (@xenova/transformers) não aceita buffers WAV brutos (Uint8Array);
    // espera um Float32Array/Float64Array com amostras de áudio já decodificadas.
    // Usa ffmpeg para converter qualquer formato de entrada para Float32Array mono 16kHz.
    const samples = await convertToFloat32Array(audioBuffer, mimeType ?? 'audio/ogg; codecs=opus');

    const output = await this.asr(samples, {
      chunk_length_s: this.chunkLengthS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const text = typeof output === 'string' ? output : (output?.text ?? '');
    const language =
      output && typeof output === 'object' && 'language' in output
        ? (output as { language?: string }).language ?? this.language ?? 'unknown'
        : this.language ?? 'unknown';

    return { text: text.trim(), language };
  }
}

/**
 * Transcritor falso (mock) útil para testes e desenvolvimento. Retorna um
 * texto fixo ou ecoa um marcador, sem carregar modelo algum.
 */
export class FakeTranscriber implements Transcriber {
  private readonly fakeText: string;

  constructor(fakeText = '[transcrição de áudio simulada]') {
    this.fakeText = fakeText;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async transcribe(_audioBuffer: Buffer, _mimeType?: string): Promise<TranscriptionResult> {
    return { text: this.fakeText, language: 'unknown' };
  }
}

/**
 * Transcritor que passa o áudio através sem transcrever (útil quando já se
 * tem o texto). Útil para testes de integração do fluxo de áudio.
 */
export class EchoTranscriber implements Transcriber {
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async transcribe(
    audioBuffer: Buffer,
    _mimeType?: string,
  ): Promise<TranscriptionResult> {
    // Tenta interpretar o buffer como UTF-8 (para testes com áudio "texto")
    const text = audioBuffer.toString('utf8').trim() || '[áudio sem texto]';
    return { text, language: 'unknown' };
  }
}

export { AudioMedia };
