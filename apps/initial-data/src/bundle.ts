import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exerciseInputSchema } from '@akiraminafit/contracts';
import { z } from 'zod';

export const SOURCE = 'https://mrgym.ir';
export const MAX_FILE_SIZE = 100 * 1024 * 1024;
export const DEFAULT_BUNDLE = 'data/mrgym';

export function sourceUrl(value: string, base = SOURCE) {
  const url = new URL(value, base);
  if (
    url.protocol !== 'https:' ||
    (url.hostname !== 'mrgym.ir' && !url.hostname.endsWith('.mrgym.ir'))
  ) {
    throw new Error(`Unexpected source URL: ${url.href}`);
  }
  url.hash = '';
  return url.href;
}

export function exerciseUrl(value: string) {
  const url = new URL(sourceUrl(value));
  if (url.origin !== SOURCE || !/^\/exercise\/[^/]+\/$/.test(url.pathname) || url.search) {
    throw new Error(`Not a MrGym exercise URL: ${value}`);
  }
  return url.href;
}

export function categoryUrl(value: string) {
  const input = value.trim();
  const url = new URL(
    sourceUrl(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(input) ? `/exercises/${input}/` : input),
  );
  if (
    url.origin !== SOURCE ||
    !/^\/exercises\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/i.test(url.pathname) ||
    url.search
  ) {
    throw new Error(`Not a MrGym category slug or URL: ${value}`);
  }
  return url.href;
}

const assetSchema = z.object({
  path: z.string().min(1),
  role: z.enum(['main-video', 'anatomy-front', 'anatomy-back', 'poster']),
  mediaType: z.enum(['image', 'video']),
  mimeType: z.enum([
    'video/mp4',
    'video/webm',
    'image/svg+xml',
    'image/jpeg',
    'image/png',
    'image/webp',
  ]),
  fileSize: z.number().int().positive().max(MAX_FILE_SIZE),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceUrl: z.url().optional(),
});

export const recordSchema = z
  .object({
    sourceUrl: z.url().refine((value) => {
      try {
        exerciseUrl(value);
        return true;
      } catch {
        return false;
      }
    }),
    slug: z.string().regex(/^[a-zA-Z0-9%_-]+$/),
    scrapedAt: z.iso.datetime(),
    englishTitle: z.string(),
    input: exerciseInputSchema,
    muscles: z.record(z.string(), z.unknown()),
    sections: z.array(z.object({ id: z.string(), title: z.string(), text: z.string() })),
    media: z.array(assetSchema).min(1),
  })
  .superRefine((record, context) => {
    if (record.media[0]?.role !== 'main-video' || record.media[0]?.mediaType !== 'video') {
      context.addIssue({
        code: 'custom',
        path: ['media'],
        message: 'The mgx-player video must be first.',
      });
    }
    const roles = record.media.map((asset) => asset.role);
    if (new Set(roles).size !== roles.length) {
      context.addIssue({ code: 'custom', path: ['media'], message: 'Duplicate media roles.' });
    }
    for (const asset of record.media) {
      if (asset.mediaType !== (asset.mimeType.startsWith('video/') ? 'video' : 'image')) {
        context.addIssue({
          code: 'custom',
          path: ['media'],
          message: 'Media type and MIME type disagree.',
        });
      }
    }
  });

export const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal('mrgym'),
    source: z.literal(SOURCE),
    generatedAt: z.iso.datetime(),
    complete: z.boolean(),
    discoveredCount: z.number().int().nonnegative(),
    selectedUrls: z.array(z.url()),
    exercises: z.array(recordSchema),
    failures: z.array(z.object({ url: z.string(), message: z.string() })),
  })
  .superRefine((manifest, context) => {
    const urls = manifest.exercises.map((record) => record.sourceUrl);
    if (
      new Set(urls).size !== urls.length ||
      new Set(manifest.selectedUrls).size !== manifest.selectedUrls.length
    ) {
      context.addIssue({ code: 'custom', message: 'Duplicate exercise URLs.' });
    }
    if (urls.some((url) => !manifest.selectedUrls.includes(url))) {
      context.addIssue({
        code: 'custom',
        message: 'Unexpected exercise outside the selected URLs.',
      });
    }
    if (
      manifest.complete &&
      (manifest.failures.length || urls.length !== manifest.selectedUrls.length)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'An incomplete bundle cannot be marked complete.',
      });
    }
  });

export type Asset = z.infer<typeof assetSchema>;

export function orderCatalogMedia(media: readonly Asset[]) {
  const priority = { 'main-video': 0, poster: 1, 'anatomy-front': 2, 'anatomy-back': 3 } as const;
  return [...media].sort((a, b) => priority[a.role] - priority[b.role]);
}

export type CatalogRecord = z.infer<typeof recordSchema>;
export type Manifest = z.infer<typeof manifestSchema>;

export async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.part`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${file}.part`, file);
}

export async function readManifest(directory: string) {
  return manifestSchema.parse(
    JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')),
  );
}

export async function hashFile(file: string) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    if (size > MAX_FILE_SIZE) throw new Error(`File exceeds 100 MiB: ${file}`);
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), fileSize: size };
}

export async function assetPath(directory: string, relative: string) {
  if (
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).includes('..') ||
    relative.includes('\\')
  ) {
    throw new Error(`Unsafe asset path: ${relative}`);
  }
  const root = await realpath(directory);
  const file = await realpath(path.resolve(root, relative));
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error(`Asset escapes bundle: ${relative}`);
  return file;
}

export async function verifyRecord(directory: string, record: CatalogRecord) {
  for (const asset of record.media) {
    const actual = await hashFile(await assetPath(directory, asset.path));
    if (actual.sha256 !== asset.sha256 || actual.fileSize !== asset.fileSize) {
      throw new Error(`Asset size/checksum mismatch: ${asset.path}`);
    }
  }
}

// Stable, coach-scoped IDs make repeated imports safe without a schema migration.
export function catalogId(coachId: string, url: string, role = 'exercise') {
  const bytes = createHash('sha256')
    .update(JSON.stringify(['mrgym', coachId, exerciseUrl(url), role]))
    .digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
