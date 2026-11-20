import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catalogId, hashFile, SOURCE, writeJson, type Manifest } from './bundle.js';

// Opt-in: use a disposable database whose name ends with _test, with db:push applied.
void test(
  'imports twice without duplicates, preserves coach media, and commits only after successful uploads',
  {
    skip: !process.env.CATALOG_TEST_DATABASE_URL,
  },
  async () => {
    const connection = process.env.CATALOG_TEST_DATABASE_URL!;
    assert.match(
      new URL(connection).pathname,
      /_test$/,
      'Integration tests require a disposable database ending in _test.',
    );
    const directory = await mkdtemp(path.join(os.tmpdir(), 'mrgym-import-integration-'));
    const emptyEnv = path.join(directory, 'empty.env');
    await writeFile(emptyEnv, '');
    process.env.DATABASE_URL = connection;
    process.env.ENV_FILE = emptyEnv;
    const { db, pool, users, exercises, exerciseMedia } = await import('@akiraminafit/db');
    const { eq, inArray } = await import('drizzle-orm');
    const coachId = `catalog-test-${randomUUID()}`;
    const otherCoachId = `catalog-test-${randomUUID()}`;
    const email = `${coachId}@example.com`;
    const otherEmail = `${otherCoachId}@example.com`;
    const uploaded = new Map<string, { mimeType: string; size: number }>();
    let failUploads = false;
    const server = createServer(async (request, response) => {
      let size = 0;
      for await (const chunk of request) size += chunk.length;
      if (failUploads) {
        response.writeHead(403, { 'Content-Type': 'application/xml' });
        response.end(
          '<Error><Code>AccessDenied</Code><Message>Simulated upload failure</Message></Error>',
        );
        return;
      }
      uploaded.set(decodeURIComponent(new URL(request.url!, 'http://localhost').pathname), {
        mimeType: String(request.headers['content-type']),
        size,
      });
      response.writeHead(200, { ETag: '"catalog-test"' });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const relativeBundle = path.relative(root, directory);
    const runImport = (targetEmail = email) =>
      new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            cli,
            'import',
            '--bundle',
            relativeBundle,
            '--coach-email',
            targetEmail,
          ],
          {
            env: {
              ...process.env,
              ENV_FILE: emptyEnv,
              DATABASE_URL: connection,
              S3_ENDPOINT: endpoint,
              S3_REGION: 'us-east-1',
              S3_ACCESS_KEY: 'catalog-test',
              S3_SECRET_KEY: 'catalog-test',
              S3_BUCKET: 'catalog-test',
              S3_PUBLIC_URL: `${endpoint}/catalog-test`,
              S3_FORCE_PATH_STYLE: 'true',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          output += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, output }));
      });
    try {
      await db.insert(users).values([
        { id: coachId, name: 'Catalog Test', email, role: 'coach' },
        { id: otherCoachId, name: 'Other Coach Test', email: otherEmail, role: 'coach' },
      ]);
      await mkdir(path.join(directory, 'media'));
      const relative = 'media/main.mp4';
      await writeFile(path.join(directory, relative), 'test video bytes');
      const url = 'https://mrgym.ir/exercise/integration-test/';
      const manifest: Manifest = {
        schemaVersion: 1,
        provider: 'mrgym',
        source: SOURCE,
        generatedAt: new Date().toISOString(),
        complete: true,
        discoveredCount: 1,
        selectedUrls: [url],
        failures: [],
        exercises: [
          {
            sourceUrl: url,
            slug: 'integration-test',
            scrapedAt: new Date().toISOString(),
            englishTitle: 'Integration Test',
            input: {
              title: 'حرکت آزمایشی',
              description: 'توضیح',
              instructions: 'شروع',
              muscleGroup: 'سینه',
              equipment: 'دمبل',
              difficulty: 'beginner',
            },
            muscles: {},
            sections: [],
            media: [
              {
                path: relative,
                role: 'main-video',
                mediaType: 'video',
                mimeType: 'video/mp4',
                ...(await hashFile(path.join(directory, relative))),
              },
            ],
          },
        ],
      };
      for (const side of ['front', 'back'] as const) {
        const relativeSvg = `media/anatomy-${side}.svg`;
        await writeFile(
          path.join(directory, relativeSvg),
          `<svg xmlns="http://www.w3.org/2000/svg" aria-label="${side}" viewBox="0 0 10 10"><rect width="10" height="10" fill="#f0c14b"/></svg>`,
        );
        manifest.exercises[0]!.media.push({
          path: relativeSvg,
          role: `anatomy-${side}`,
          mediaType: 'image',
          mimeType: 'image/svg+xml',
          ...(await hashFile(path.join(directory, relativeSvg))),
        });
      }
      // Model an existing bundle where the poster follows the anatomy diagrams.
      const relativePoster = 'media/poster.webp';
      await writeFile(path.join(directory, relativePoster), 'test poster bytes');
      manifest.exercises[0]!.media.push({
        path: relativePoster,
        role: 'poster',
        mediaType: 'image',
        mimeType: 'image/webp',
        ...(await hashFile(path.join(directory, relativePoster))),
      });
      await writeJson(path.join(directory, 'manifest.json'), manifest);
      const first = await runImport();
      assert.equal(first.code, 0, first.output);
      const second = await runImport();
      assert.equal(second.code, 0, second.output);
      const id = catalogId(coachId, url);
      assert.equal(
        (await db.select().from(exercises).where(eq(exercises.coachId, coachId))).length,
        1,
      );
      let rows = await db.select().from(exerciseMedia).where(eq(exerciseMedia.exerciseId, id));
      assert.equal(rows.length, 4);
      const video = rows.find((item) => item.mediaType === 'video')!;
      const poster = rows.find((item) => item.id === catalogId(coachId, url, 'poster'))!;
      assert.equal(video.sortOrder, 0);
      assert.equal(poster.sortOrder, 1);
      assert.equal(video.thumbnailUrl, poster.url);
      assert.ok(
        rows
          .filter((item) => item.mimeType === 'image/svg+xml')
          .every((item) => item.sortOrder > poster.sortOrder),
      );
      const oldStorageKey = video.storageKey;
      assert.equal(uploaded.get(`/catalog-test/${oldStorageKey}`)?.mimeType, 'video/mp4');
      for (const image of rows.filter((item) => item.mediaType === 'image')) {
        assert.equal(uploaded.get(`/catalog-test/${image.storageKey}`)?.mimeType, image.mimeType);
      }
      await db.insert(exerciseMedia).values({
        id: randomUUID(),
        exerciseId: id,
        mediaType: 'image',
        storageKey: `${coachId}/exercise/${id}/manual.png`,
        url: `${endpoint}/manual.png`,
        mimeType: 'image/png',
        fileSize: 10,
      });
      await db.update(exercises).set({ isArchived: true }).where(eq(exercises.id, id));
      manifest.exercises[0]!.input.title = 'عنوان جدید';
      await writeFile(path.join(directory, relative), 'updated test video bytes');
      Object.assign(
        manifest.exercises[0]!.media[0]!,
        await hashFile(path.join(directory, relative)),
      );
      await writeJson(path.join(directory, 'manifest.json'), manifest);
      failUploads = true;
      const failed = await runImport();
      assert.notEqual(failed.code, 0);
      assert.equal(
        (await db.select().from(exercises).where(eq(exercises.id, id)))[0]!.title,
        'حرکت آزمایشی',
      );
      assert.equal(
        (await db.select().from(exerciseMedia).where(eq(exerciseMedia.exerciseId, id))).length,
        5,
      );
      failUploads = false;
      const updated = await runImport();
      assert.equal(updated.code, 0, updated.output);
      const [exercise] = await db.select().from(exercises).where(eq(exercises.id, id));
      assert.equal(exercise!.title, 'عنوان جدید');
      assert.equal(exercise!.isArchived, true);
      rows = await db.select().from(exerciseMedia).where(eq(exerciseMedia.exerciseId, id));
      assert.equal(rows.length, 5);
      assert.ok(rows.some((item) => item.storageKey.endsWith('/manual.png')));
      assert.ok(
        rows.some((item) => item.storageKey !== oldStorageKey && item.mimeType === 'video/mp4'),
      );
      assert.ok(uploaded.has(`/catalog-test/${oldStorageKey}`));
      const other = await runImport(otherEmail);
      assert.equal(other.code, 0, other.output);
      assert.equal(
        (await db.select().from(exercises).where(eq(exercises.coachId, otherCoachId))).length,
        1,
      );
      assert.notEqual(catalogId(coachId, url), catalogId(otherCoachId, url));
    } finally {
      await db.delete(users).where(inArray(users.id, [coachId, otherCoachId]));
      await pool.end();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);
