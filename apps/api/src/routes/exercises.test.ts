import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';

// Run against a disposable PostgreSQL database with the project schema applied.
void test(
  'exercise archive and permanent deletion API',
  {
    skip: !process.env.EXERCISE_TEST_DATABASE_URL,
  },
  async (t) => {
    const connection = process.env.EXERCISE_TEST_DATABASE_URL!;
    assert.match(
      new URL(connection).pathname,
      /_test$/,
      'Use a disposable database ending in _test.',
    );
    const directory = await mkdtemp(path.join(os.tmpdir(), 'exercise-archive-test-'));
    const emptyEnv = path.join(directory, '.env');
    await writeFile(emptyEnv, '');
    process.env.ENV_FILE = emptyEnv;
    process.env.DATABASE_URL = connection;
    process.env.ADMIN_NAME = 'Test Coach';
    process.env.ADMIN_EMAIL = 'archive-test@example.com';
    process.env.ADMIN_PASSWORD = 'archive-test-password';
    const {
      db,
      pool,
      users,
      exercises,
      exerciseMedia,
      workoutPlans,
      workoutPlanDays,
      workoutPlanExercises,
    } = await import('@akiraminafit/db');
    const { exercisesRoutes } = await import('./exercises.js');
    const { s3 } = await import('../lib/storage.js');
    const coachId = `coach-${randomUUID()}`;
    const otherCoachId = `coach-${randomUUID()}`;
    const studentId = `student-${randomUUID()}`;
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      const identity = c.req.header('x-test-user');
      const id = identity === 'other' ? otherCoachId : identity === 'student' ? studentId : coachId;
      c.set('user', {
        id,
        name: 'Test',
        email: `${id}@example.com`,
        role: identity === 'student' ? 'student' : 'coach',
      });
      await next();
    });
    app.route('/exercises', exercisesRoutes);
    const request = (suffix = '', method = 'GET', identity = 'coach') =>
      app.request(`/exercises${suffix}`, { method, headers: { 'x-test-user': identity } });
    const deletedKeys: string[] = [];
    let storageFailure: 'network' | 'partial' | undefined;
    t.mock.method(s3, 'send', async (command: unknown) => {
      assert.ok(command instanceof DeleteObjectsCommand);
      if (storageFailure === 'network') throw new Error('Simulated storage outage');
      if (storageFailure === 'partial') return { Errors: [{ Code: 'AccessDenied', Key: 'test' }] };
      deletedKeys.push(...(command.input.Delete?.Objects?.map((item) => item.Key!) ?? []));
      return { $metadata: {} };
    });
    const makeExercise = async (isArchived: boolean, owner = coachId) => {
      const id = randomUUID();
      await db
        .insert(exercises)
        .values({ id, coachId: owner, title: 'حرکت آزمایشی', muscleGroup: 'سینه', isArchived });
      await db.insert(exerciseMedia).values({
        exerciseId: id,
        mediaType: 'video',
        storageKey: `${owner}/exercise/${id}/main.mp4`,
        url: 'https://example.com/main.mp4',
        mimeType: 'video/mp4',
        fileSize: 11,
      });
      return id;
    };
    try {
      await db.insert(users).values([
        { id: coachId, name: 'Coach', email: `${coachId}@example.com`, role: 'coach' },
        { id: otherCoachId, name: 'Other', email: `${otherCoachId}@example.com`, role: 'coach' },
        { id: studentId, name: 'Student', email: `${studentId}@example.com`, role: 'student' },
      ]);
      const active = await makeExercise(false);
      const archived = await makeExercise(true);
      const foreign = await makeExercise(true, otherCoachId);

      await t.test(
        'lists active and archived exercises separately and enforces ownership and permissions',
        async () => {
          const listed = await request();
          assert.equal(listed.status, 200);
          assert.deepEqual(
            (await listed.json()).data.map((item: { id: string }) => item.id),
            [active],
          );
          const archive = await request('?archived=true');
          assert.equal(archive.status, 200);
          const data = (await archive.json()).data;
          assert.deepEqual(
            data.map((item: { id: string }) => item.id),
            [archived],
          );
          assert.equal(data[0].media.length, 1);
          assert.equal((await request('?archived=invalid')).status, 400);
          assert.equal((await request('?archived=true', 'GET', 'student')).status, 403);
          assert.equal((await request(`/${foreign}/restore`, 'POST')).status, 404);
          assert.equal((await request(`/${foreign}/permanent`, 'DELETE')).status, 404);
          assert.equal((await request(`/${foreign}`, 'DELETE')).status, 404);
          assert.equal((await request(`/${archived}/restore`, 'POST', 'student')).status, 403);
          assert.equal(deletedKeys.length, 0);
        },
      );

      await t.test(
        'restores an archived exercise with its media and supports repeated restore requests',
        async () => {
          assert.equal((await request(`/${archived}/restore`, 'POST')).status, 200);
          assert.equal((await request(`/${archived}/restore`, 'POST')).status, 200);
          const [record] = await db.select().from(exercises).where(eq(exercises.id, archived));
          assert.equal(record?.isArchived, false);
          assert.equal(
            (await db.select().from(exerciseMedia).where(eq(exerciseMedia.exerciseId, archived)))
              .length,
            1,
          );
          assert.equal((await (await request('?archived=true')).json()).data.length, 0);
        },
      );

      await t.test(
        'requires archiving before permanent deletion and preserves media during archive',
        async () => {
          assert.equal((await request(`/${active}/permanent`, 'DELETE')).status, 409);
          assert.equal((await request(`/${active}`, 'DELETE')).status, 204);
          const [record] = await db.select().from(exercises).where(eq(exercises.id, active));
          assert.equal(record?.isArchived, true);
          assert.equal(
            (await db.select().from(exerciseMedia).where(eq(exerciseMedia.exerciseId, active)))
              .length,
            1,
          );
          assert.equal(deletedKeys.length, 0);
        },
      );

      await t.test(
        'permanently deletes an unused archived exercise and its database and storage media',
        async () => {
          assert.equal((await request(`/${active}/permanent`, 'DELETE')).status, 204);
          assert.equal(
            (await db.select().from(exercises).where(eq(exercises.id, active))).length,
            0,
          );
          assert.equal(
            (await db.select().from(exerciseMedia).where(eq(exerciseMedia.exerciseId, active)))
              .length,
            0,
          );
          assert.deepEqual(deletedKeys, [`${coachId}/exercise/${active}/main.mp4`]);
          assert.equal((await request(`/${active}/permanent`, 'DELETE')).status, 404);
          assert.equal((await request(`/${active}/restore`, 'POST')).status, 404);
        },
      );

      await t.test(
        'blocks deletion of exercises used by a plan without deleting any files',
        async () => {
          const used = await makeExercise(true);
          const [plan] = await db
            .insert(workoutPlans)
            .values({
              coachId,
              studentId,
              title: 'Test Plan',
              startDate: new Date('2026-11-20T00:00:00Z'),
            })
            .returning();
          const [day] = await db
            .insert(workoutPlanDays)
            .values({ workoutPlanId: plan!.id, title: 'Day', dayNumber: 1 })
            .returning();
          await db.insert(workoutPlanExercises).values({
            workoutPlanDayId: day!.id,
            exerciseId: used,
            exerciseTitleSnapshot: 'Snapshot',
            sets: 3,
            reps: '10',
          });
          const before = deletedKeys.length;
          const response = await request(`/${used}/permanent`, 'DELETE');
          assert.equal(response.status, 409);
          assert.match((await response.json()).message, /برنامه/);
          assert.equal(deletedKeys.length, before);
          assert.equal(
            (
              await db
                .select()
                .from(workoutPlanExercises)
                .where(eq(workoutPlanExercises.exerciseId, used))
            ).length,
            1,
          );
          assert.equal((await request(`/${used}/restore`, 'POST')).status, 200);
        },
      );

      await t.test('rolls back database deletion on storage errors and allows retry', async () => {
        for (const failure of ['network', 'partial'] as const) {
          const id = await makeExercise(true);
          storageFailure = failure;
          assert.equal((await request(`/${id}/permanent`, 'DELETE')).status, 502);
          assert.equal((await db.select().from(exercises).where(eq(exercises.id, id))).length, 1);
          assert.equal(
            (await db.select().from(exerciseMedia).where(eq(exerciseMedia.exerciseId, id))).length,
            1,
          );
          storageFailure = undefined;
          assert.equal((await request(`/${id}/permanent`, 'DELETE')).status, 204);
        }
      });
    } finally {
      await db.delete(workoutPlans).where(eq(workoutPlans.coachId, coachId));
      await db.delete(users).where(inArray(users.id, [coachId, otherCoachId, studentId]));
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
