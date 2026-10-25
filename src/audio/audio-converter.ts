import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, unlinkSync, readFileSync, existsSync, mkdirSync } from 'node:fs';

const execFileAsync = promisify(execFile);

/**
 * Caminho para o binário do ffmpeg.
 * Respeita a env FFMPEG_PATH; caso contrário tenta o caminho padrão do Hermes.
 */
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

/**
 * Extensões de áudio aceitas pelo WhatsApp que o ffmpeg consegue decodificar.
 */
const SUPPORTED_INPUT_EXT = new Set(['.ogg', '.opus', '.mp3', '.wav', '.m4a', '.aac', '.amr']);

/**
 * Converte um buffer de áudio (qualquer formato suportado pelo ffmpeg) para
 * Float32Array mono 16kHz — formato ideal para o Whisper (@xenova/transformers).
 *
 * O Whisper não aceita buffers WAV brutos (Uint8Array); espera um Float32Array/
 * Float64Array com as amostras de áudio já decodificadas. Por isso, o ffmpeg
 * é instruído a outputar raw PCM float 32-bit little-endian (pcm_f32le), que
 * é interpretado diretamente como Float32Array pelo Node.js.
 *
 * @param inputBuffer Buffer com os dados de áudio brutos.
 * @param inputMimeType MIME type do áudio (usado apenas para inferir extensão).
 * @returns Float32Array com as amostras de áudio (mono, 16kHz, range [-1, 1]).
 * @throws Se o formato não for suportado ou a conversão falhar.
 */
export async function convertToFloat32Array(
  inputBuffer: Buffer,
  inputMimeType: string,
): Promise<Float32Array> {
  const ext = mimeToExt(inputMimeType);
  if (!SUPPORTED_INPUT_EXT.has(ext)) {
    throw new Error(
      `Formato de áudio não suportado para conversão: ${inputMimeType} (ext: ${ext})`,
    );
  }

  // Arquivos temporários para entrada e saída
  const tmpDir = tmpdir();
  const inFile = join(tmpDir, `reminder-audio-${Date.now()}${ext}`);
  const outFile = join(tmpDir, `reminder-audio-${Date.now()}.f32`);

  try {
    writeFileSync(inFile, inputBuffer);

    // ffmpeg: -i input -ar 16000 -ac 1 -c:a pcm_f32le output.f32
    // pcm_f32le = float 32-bit little-endian, diretamente compatível com Float32Array
    await execFileAsync(FFMPEG_PATH, [
      '-i', inFile,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_f32le',
      '-f', 'f32le',
      '-y',
      outFile,
    ], {
      maxBuffer: 50 * 1024 * 1024, // 50MB
    });

    if (!existsSync(outFile)) {
      throw new Error('ffmpeg não gerou o arquivo de saída f32le');
    }

    const buffer = readFileSync(outFile);
    // pcm_f32le é little-endian; Float32Array no Node (x86/x64) é little-endian nativo.
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  } finally {
    unlinkSyncSafe(inFile);
    unlinkSyncSafe(outFile);
  }
}

/**
 * Converte um buffer de áudio para WAV mono 16kHz 16-bit PCM.
 * Mantido para compatibilidade / uso externo.
 */
export async function convertToWav(
  inputBuffer: Buffer,
  inputMimeType: string,
): Promise<Buffer> {
  const ext = mimeToExt(inputMimeType);
  if (!SUPPORTED_INPUT_EXT.has(ext)) {
    throw new Error(
      `Formato de áudio não suportado para conversão: ${inputMimeType} (ext: ${ext})`,
    );
  }

  const tmpDir = tmpdir();
  const inFile = join(tmpDir, `reminder-audio-${Date.now()}${ext}`);
  const outFile = join(tmpDir, `reminder-audio-${Date.now()}.wav`);

  try {
    writeFileSync(inFile, inputBuffer);

    await execFileAsync(FFMPEG_PATH, [
      '-i', inFile,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      '-y',
      outFile,
    ], {
      maxBuffer: 50 * 1024 * 1024,
    });

    if (!existsSync(outFile)) {
      throw new Error('ffmpeg não gerou o arquivo de saída WAV');
    }

    return readFileSync(outFile);
  } finally {
    unlinkSyncSafe(inFile);
    unlinkSyncSafe(outFile);
  }
}

function unlinkSyncSafe(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Ignora se já foi removido ou não existe.
  }
}

/**
 * Infere a extensão de arquivo a partir do MIME type.
 */
function mimeToExt(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes('ogg') || lower.includes('opus')) return '.ogg';
  if (lower.includes('mp3') || lower.includes('mpeg')) return '.mp3';
  if (lower.includes('wav') || lower.includes('x-wav')) return '.wav';
  if (lower.includes('m4a') || lower.includes('mp4')) return '.m4a';
  if (lower.includes('aac')) return '.aac';
  if (lower.includes('amr')) return '.amr';
  // Default: tenta .ogg (formato padrão de voz do WhatsApp)
  return '.ogg';
}

/**
 * Garante que o ffmpeg esteja disponível no PATH ou na FFMPEG_PATH.
 * Lança erro com mensagem clara caso contrário.
 */
export async function ensureFfmpegAvailable(): Promise<void> {
  try {
    await execFileAsync(FFMPEG_PATH, ['-version'], { maxBuffer: 10 * 1024 * 1024 });
  } catch (err: any) {
    throw new Error(
      `ffmpeg não encontrado ou não executável (caminho: ${FFMPEG_PATH}). ` +
      `Defina a variável de ambiente FFMPEG_PATH ou instale o ffmpeg. Erro: ${err?.message ?? err}`,
    );
  }
}
