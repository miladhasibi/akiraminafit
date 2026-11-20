import { exerciseInputSchema } from '@akiraminafit/contracts';
import { db, exerciseMedia, exercises, workoutPlanExercises } from '@akiraminafit/db';
import { DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { env } from '../env.js';
import { s3 } from '../lib/storage.js';
import { requirePermission } from '../middleware/auth.js';
import type { AppEnv } from '../types.js';

export const exercisesRoutes = new Hono<AppEnv>()
  .get(
    '/',
    requirePermission({ exercises: ['list'] }),
    zValidator(
      'query',
      z.object({
        archived: z.enum(['true', 'false']).default('false'),
      }),
    ),
    async (c) => {
      const coach = c.get('user');
      const archived = c.req.valid('query').archived === 'true';
      const rows = await db
        .select()
        .from(exercises)
        .where(and(eq(exercises.coachId, coach.id), eq(exercises.isArchived, archived)))
        .orderBy(desc(exercises.createdAt));

      const media = rows.length
        ? await db
            .select()
            .from(exerciseMedia)
            .where(
              inArray(
                exerciseMedia.exerciseId,
                rows.map((row) => row.id),
              ),
            )
            .orderBy(asc(exerciseMedia.sortOrder))
        : [];

      return c.json({
        data: rows.map((exercise) => ({
          ...exercise,
          media: media.filter((item) => item.exerciseId === exercise.id),
        })),
      });
    },
  )
  .post(
    '/',
    requirePermission({ exercises: ['create'] }),
    zValidator('json', exerciseInputSchema),
    async (c) => {
      const coach = c.get('user');
      const input = c.req.valid('json');
      const [created] = await db
        .insert(exercises)
        .values({ coachId: coach.id, ...input })
        .returning();
      return c.json({ data: created }, 201);
    },
  )
  .patch(
    '/:id',
    requirePermission({ exercises: ['update'] }),
    zValidator('json', exerciseInputSchema.partial()),
    async (c) => {
      const coach = c.get('user');
      const [updated] = await db
        .update(exercises)
        .set({ ...c.req.valid('json'), updatedAt: new Date() })
        .where(and(eq(exercises.id, c.req.param('id')), eq(exercises.coachId, coach.id)))
        .returning();

      if (!updated) return c.json({ message: 'حرکت پیدا نشد.' }, 404);
      return c.json({ data: updated });
    },
  )
  .post('/:id/restore', requirePermission({ exercises: ['update'] }), async (c) => {
    const coach = c.get('user');
    const [restored] = await db
      .update(exercises)
      .set({ isArchived: false, updatedAt: new Date() })
      .where(and(eq(exercises.id, c.req.param('id')), eq(exercises.coachId, coach.id)))
      .returning();
    if (!restored) return c.json({ message: 'حرکت پیدا نشد.' }, 404);
    return c.json({ data: restored });
  })
  .delete(
    '/:id/permanent',
    requirePermission({ exercises: ['delete'], media: ['delete'] }),
    async (c) => {
      const coach = c.get('user');
      const id = c.req.param('id');
      try {
        return await db.transaction(async (tx) => {
          const [exercise] = await tx
            .select()
            .from(exercises)
            .where(and(eq(exercises.id, id), eq(exercises.coachId, coach.id)))
            .for('update');
          if (!exercise) return c.json({ message: 'حرکت پیدا نشد.' }, 404);
          if (!exercise.isArchived)
            return c.json({ message: 'برای حذف دائمی، ابتدا حرکت را به آرشیو منتقل کن.' }, 409);
          const [usage] = await tx
            .select({ id: workoutPlanExercises.id })
            .from(workoutPlanExercises)
            .where(eq(workoutPlanExercises.exerciseId, id))
            .limit(1);
          if (usage)
            return c.json(
              {
                message:
                  'این حرکت در یک برنامهٔ تمرینی استفاده شده و قابل حذف دائمی نیست. می‌توانی آن را در آرشیو نگه داری یا بازگردانی کنی.',
              },
              409,
            );
          const media = await tx
            .select({ storageKey: exerciseMedia.storageKey })
            .from(exerciseMedia)
            .where(eq(exerciseMedia.exerciseId, id));
          // Check foreign-key restrictions before touching files; the row lock blocks new references.
          await tx.delete(exercises).where(eq(exercises.id, id));
          const keys = [...new Set(media.map((item) => item.storageKey))].filter((key) =>
            key.startsWith(`${coach.id}/exercise/${id}/`),
          );
          try {
            for (let index = 0; index < keys.length; index += 1000) {
              const result = await s3.send(
                new DeleteObjectsCommand({
                  Bucket: env.S3_BUCKET,
                  Delete: {
                    Objects: keys.slice(index, index + 1000).map((Key) => ({ Key })),
                    Quiet: true,
                  },
                }),
              );
              if (result.Errors?.length) throw new Error('Media deletion failed.');
            }
          } catch {
            // Keep the archived record on failure so permanent deletion can be retried.
            throw new HTTPException(502, {
              message: 'حذف فایل‌های حرکت کامل نشد. برای تکمیل حذف دائمی دوباره تلاش کن.',
            });
          }
          return c.body(null, 204);
        });
      } catch (error) {
        if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
        const code =
          (error as { code?: string; cause?: { code?: string } }).cause?.code ??
          (error as { code?: string }).code;
        if (code === '23503')
          return c.json(
            { message: 'این حرکت در یک برنامهٔ تمرینی استفاده شده و قابل حذف دائمی نیست.' },
            409,
          );
        throw error;
      }
    },
  )
  .delete('/:id', requirePermission({ exercises: ['delete'] }), async (c) => {
    const coach = c.get('user');
    const [archived] = await db
      .update(exercises)
      .set({ isArchived: true, updatedAt: new Date() })
      .where(and(eq(exercises.id, c.req.param('id')), eq(exercises.coachId, coach.id)))
      .returning({ id: exercises.id });

    if (!archived) return c.json({ message: 'حرکت پیدا نشد.' }, 404);
    return c.body(null, 204);
  });
