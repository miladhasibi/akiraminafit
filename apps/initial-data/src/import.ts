import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import type { exerciseMedia as exerciseMediaTable } from '@akiraminafit/db';
import {
  assetPath,
  catalogId,
  orderCatalogMedia,
  readManifest,
  verifyRecord,
  type CatalogRecord,
} from './bundle.js';

type ImportOptions = {
  directory: string;
  coachEmail?: string;
  dryRun: boolean;
  allowPartial: boolean;
};

export async function preflightBundle(directory: string, allowPartial = false) {
  const manifest = await readManifest(directory);
  if (!manifest.complete && !allowPartial)
    throw new Error(
      'Bundle is incomplete. Resume scraping first or explicitly use --allow-partial.',
    );
  if (!manifest.exercises.length) throw new Error('Bundle has no exercises.');
  // Verify the ENTIRE package before uploading files or writing any database rows.
  for (const record of manifest.exercises) await verifyRecord(directory, record);
  return manifest;
}

export function mediaStorageKey(
  coachId: string,
  record: CatalogRecord,
  asset: CatalogRecord['media'][number],
) {
  const exerciseId = catalogId(coachId, record.sourceUrl);
  // Content-addressed objects keep old database URLs valid until the new transaction commits.
  return `${coachId}/exercise/${exerciseId}/mrgym/${asset.sha256}${path.extname(asset.path)}`;
}

export async function importCatalog(options: ImportOptions) {
  const directory = path.resolve(options.directory);
  const manifest = await preflightBundle(directory, options.allowPartial);
  const assetCount = manifest.exercises.reduce((count, record) => count + record.media.length, 0);
  if (options.dryRun) {
    console.log(
      `Verified ${manifest.exercises.length} exercises and ${assetCount} files. No uploads or database writes.`,
    );
    return;
  }

  const envFile = process.env.ENV_FILE ?? fileURLToPath(new URL('../.env', import.meta.url));
  // Shared database code must load the app's configuration, never the API's root .env.
  process.env.ENV_FILE = envFile;
  dotenv.config({ path: envFile, quiet: true });
  // Import needs database/storage credentials and an existing coach, never an admin password.
  const env = z
    .object({
      S3_ENDPOINT: z.url().default('http://localhost:9000'),
      S3_REGION: z.string().default('us-east-1'),
      S3_ACCESS_KEY: z.string().min(1),
      S3_SECRET_KEY: z.string().min(1),
      S3_BUCKET: z.string().default('akiraminafit-media'),
      S3_PUBLIC_URL: z.url().default('http://localhost:9000/akiraminafit-media'),
      S3_FORCE_PATH_STYLE: z.string().default('true'),
      COACH_EMAIL: z.email(),
    })
    .parse({
      ...process.env,
      COACH_EMAIL: options.coachEmail ?? process.env.COACH_EMAIL ?? process.env.ADMIN_EMAIL,
    });
  const { db, pool, users, exercises, exerciseMedia } = await import('@akiraminafit/db');
  const { eq, and, sql } = await import('drizzle-orm');
  const s3 = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  });
  try {
    const [coach] = await db
      .select()
      .from(users)
      .where(eq(users.email, env.COACH_EMAIL.toLowerCase()))
      .limit(1);
    if (!coach || !coach.role?.split(',').includes('coach') || !coach.isActive) {
      throw new Error(
        `An active coach account is required for ${env.COACH_EMAIL}. Create it with npm run db:seed first.`,
      );
    }
    for (const [index, record] of manifest.exercises.entries()) {
      const id = catalogId(coach.id, record.sourceUrl);
      const media: (typeof exerciseMediaTable.$inferInsert)[] = [];
      const poster = record.media.find((asset) => asset.role === 'poster');
      const publicUrl = (key: string) =>
        `${env.S3_PUBLIC_URL.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
      // Normalize legacy bundles too: main video first, then its poster before muscle diagrams.
      for (const [sortOrder, asset] of orderCatalogMedia(record.media).entries()) {
        const key = mediaStorageKey(coach.id, record, asset);
        await s3.send(
          new PutObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: key,
            Body: createReadStream(await assetPath(directory, asset.path)),
            ContentType: asset.mimeType,
            ContentLength: asset.fileSize,
            CacheControl: 'public, max-age=31536000, immutable',
            Metadata: {
              owner: coach.id,
              entity: 'exercise',
              entityId: id,
              source: 'mrgym',
              sha256: asset.sha256,
            },
          }),
        );
        media.push({
          id: catalogId(coach.id, record.sourceUrl, asset.role),
          exerciseId: id,
          storageKey: key,
          url: publicUrl(key),
          mimeType: asset.mimeType,
          fileSize: asset.fileSize,
          mediaType: asset.mediaType,
          sortOrder,
          thumbnailUrl:
            asset.role === 'main-video' && poster
              ? publicUrl(mediaStorageKey(coach.id, record, poster))
              : null,
        });
      }
      // A single exercise and its media commit together, after every upload succeeds.
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
        const [existing] = await tx
          .select({ coachId: exercises.coachId })
          .from(exercises)
          .where(eq(exercises.id, id));
        if (existing && existing.coachId !== coach.id)
          throw new Error('Exercise ID belongs to another coach.');
        await tx
          .insert(exercises)
          .values({ id, coachId: coach.id, ...record.input })
          .onConflictDoUpdate({
            target: exercises.id,
            set: { ...record.input, updatedAt: new Date() },
          });
        for (const item of media) {
          await tx
            .insert(exerciseMedia)
            .values(item)
            .onConflictDoUpdate({
              target: exerciseMedia.id,
              set: {
                storageKey: item.storageKey,
                url: item.url,
                mimeType: item.mimeType,
                fileSize: item.fileSize,
                mediaType: item.mediaType,
                sortOrder: item.sortOrder,
                thumbnailUrl: item.thumbnailUrl,
              },
            });
        }
        // Only retired importer-owned media rows are removed; coach uploads are preserved.
        const current = await tx
          .select()
          .from(exerciseMedia)
          .where(eq(exerciseMedia.exerciseId, id));
        for (const item of current) {
          if (
            item.storageKey.startsWith(`${coach.id}/exercise/${id}/mrgym/`) &&
            !media.some((entry) => entry.id === item.id)
          ) {
            await tx
              .delete(exerciseMedia)
              .where(and(eq(exerciseMedia.id, item.id), eq(exerciseMedia.exerciseId, id)));
          }
        }
      });
      console.log(
        `[${index + 1}/${manifest.exercises.length}] Imported for ${coach.email}: ${record.input.title}`,
      );
    }
    console.log(
      `Imported ${manifest.exercises.length} exercises and ${assetCount} files into ${env.S3_BUCKET}.`,
    );
  } finally {
    s3.destroy();
    await pool.end();
  }
}
