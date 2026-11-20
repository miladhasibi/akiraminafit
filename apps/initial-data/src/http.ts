import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_FILE_SIZE, sourceUrl } from './bundle.js';

export class SourceClient {
  private lastRequest = 0;

  constructor(private interval = 1000) {}

  private async request(url: string) {
    await delay(Math.max(0, this.lastRequest + this.interval - Date.now()));
    this.lastRequest = Date.now();
    const response = await fetch(sourceUrl(url), {
      headers: { 'User-Agent': 'AkiraMinaFit-ExerciseCatalog/1.0', Accept: '*/*' },
      signal: AbortSignal.timeout(120_000),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel();
      throw new Error(
        `Unexpected redirect at ${url}; location: ${response.headers.get('location')}`,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`HTTP ${response.status}: ${url}`);
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = Number(retryAfter);
        const wait = retryAfter
          ? Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(retryAfter) - Date.now()
          : 0;
        Object.assign(error, { retryable: true, wait: Math.min(60_000, Math.max(0, wait || 0)) });
      }
      throw error;
    }
    return response;
  }

  private async retry<T>(run: () => Promise<T>) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        const info = error as { retryable?: boolean; wait?: number; message?: string };
        if (
          attempt >= 2 ||
          info.retryable === false ||
          (info.message?.startsWith('HTTP ') && !info.retryable)
        )
          throw error;
        await delay(Math.max(info.wait ?? 0, 1000 * 2 ** attempt));
      }
    }
  }

  text(url: string) {
    return this.retry(async () => {
      const response = await this.request(url);
      const value = await response.text();
      if (value.length > 10 * 1024 * 1024) throw new Error(`Page is unexpectedly large: ${url}`);
      return value;
    });
  }

  download(url: string, file: string, kind: 'video' | 'image') {
    return this.retry(async () => {
      const response = await this.request(url);
      const mimeType = response.headers.get('content-type')?.split(';')[0]?.toLowerCase();
      const allowed =
        kind === 'video' ? ['video/mp4', 'video/webm'] : ['image/jpeg', 'image/png', 'image/webp'];
      if (!mimeType || !allowed.includes(mimeType) || !response.body) {
        if (mimeType === 'text/html') {
          const html = await response.text();
          if (
            /request is being verified|one moment, please|verify you are human|captcha/i.test(html)
          ) {
            throw Object.assign(
              new Error(
                `The media host requires browser verification and returned HTML instead of ${kind}: ${url}. Retry from a connection where this source video is accessible.`,
              ),
              { retryable: false },
            );
          }
        }
        if (!response.bodyUsed) await response.body?.cancel();
        throw Object.assign(new Error(`Unexpected ${kind} Content-Type ${mimeType}: ${url}`), {
          retryable: false,
        });
      }
      const expectedSize = Number(response.headers.get('content-length'));
      if (expectedSize > MAX_FILE_SIZE) {
        await response.body.cancel();
        throw Object.assign(new Error(`Media exceeds 100 MiB: ${url}`), { retryable: false });
      }
      await mkdir(path.dirname(file), { recursive: true });
      let size = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          callback(size > MAX_FILE_SIZE ? new Error(`Media exceeds 100 MiB: ${url}`) : null, chunk);
        },
      });
      try {
        await pipeline(
          Readable.fromWeb(response.body as never),
          limit,
          createWriteStream(`${file}.part`),
        );
        if (!size || (expectedSize && expectedSize !== size))
          throw new Error(`Incomplete download: ${url}`);
        await rename(`${file}.part`, file);
        return mimeType;
      } finally {
        await rm(`${file}.part`, { force: true });
      }
    });
  }
}
