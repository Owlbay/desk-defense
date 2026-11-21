/**
 * 指令日志编解码：JSON → gzip → base64。浏览器 / Workers / Node 18+ 都有 CompressionStream。
 * 只使用两端都有的 API（btoa / atob / TextEncoder / Compression/DecompressionStream）。
 */
import { LOG_MAX_RAW_BYTES, type LogEntry, type LogPayload } from './leaderboard';

export const hasCompression = (): boolean => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function readAll(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('too_large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function pipe(
  data: Uint8Array,
  ts: { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> },
  maxBytes: number,
): Promise<Uint8Array> {
  const writer = ts.writable.getWriter();
  // 不能先 await 写入再读（背压会卡死）：边写边读
  const written = writer.write(data).then(() => writer.close());
  written.catch(() => undefined);
  return readAll(ts.readable, maxBytes).then(async (out) => {
    await written;
    return out;
  });
}

export function gzip(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>, Number.MAX_SAFE_INTEGER);
}

/** 解压，超过 maxBytes 立即中止（防解压炸弹） */
export function gunzip(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  return pipe(data, new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>, maxBytes);
}

/** 编码日志：支持压缩时返回 {gz}，否则直接返回数组 */
export async function encodeLog(log: LogEntry[]): Promise<LogPayload> {
  if (!hasCompression()) return log;
  try {
    const raw = new TextEncoder().encode(JSON.stringify(log));
    return { gz: bytesToBase64(await gzip(raw)) };
  } catch {
    return log;
  }
}

export async function gzipJsonBase64(value: unknown): Promise<string> {
  return bytesToBase64(await gzip(new TextEncoder().encode(JSON.stringify(value))));
}

/** 解码日志载荷；返回 JSON 原文字节数用于上限判断。失败抛 Error('bad_log' | 'too_large') */
export async function decodeLogPayload(p: LogPayload, maxRawBytes = LOG_MAX_RAW_BYTES): Promise<{ log: unknown; rawBytes: number }> {
  if (Array.isArray(p)) {
    const rawBytes = new TextEncoder().encode(JSON.stringify(p)).byteLength;
    if (rawBytes > maxRawBytes) throw new Error('too_large');
    return { log: p, rawBytes };
  }
  let bytes: Uint8Array;
  try {
    bytes = await gunzip(base64ToBytes(p.gz), maxRawBytes);
  } catch (e) {
    throw new Error(e instanceof Error && e.message === 'too_large' ? 'too_large' : 'bad_log');
  }
  try {
    return { log: JSON.parse(new TextDecoder().decode(bytes)) as unknown, rawBytes: bytes.byteLength };
  } catch {
    throw new Error('bad_log');
  }
}
