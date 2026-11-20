# AkiraMinaFit

A full-stack Persian RTL fitness coaching MVP packaged as a Vite+ monorepo and installable PWA.

## Included

- React, Tailwind CSS, shadcn-style components and Recharts
- Hono API on Node.js
- Better Auth with coach/student roles
- Drizzle ORM and PostgreSQL through `pg`
- S3-compatible image/video uploads with local MinIO
- Workout plan builder, weekday scheduling and immutable exercise snapshots
- Daily student workout Todo, actual completion records and offline mutation queue
- User-controlled offline downloads for workout images and videos
- Body report history and progress charts

## Quick start

Requires Node.js 22.12+ and Docker.

```bash
npm install
cp .env.example .env
docker compose up -d
npm run db:push
# Set ADMIN_NAME, ADMIN_EMAIL and ADMIN_PASSWORD in .env first.
npm run db:seed
npm run dev
```

Compose builds MinIO and its `mc` client from pinned official source releases because the upstream
container images are no longer publicly available. The first run downloads the Go dependencies and
compiles both binaries; subsequent runs reuse the local images. Use `docker compose up -d --build`
after changing the Dockerfile. Bucket initialization waits until MinIO is healthy.

Web: `http://localhost:5173`  
API: `http://localhost:3000`  
MinIO console: `http://localhost:9001`

## Production start

Set the production domain in `.env`, including `NODE_ENV=production`, `WEB_ORIGIN` and
`BETTER_AUTH_URL`. Set `VITE_API_URL=` to serve both the web app and API from the same domain. Then
run:

```bash
npm run start
```

The command builds the web app, replaces `apps/api/public` with its output, builds the API and
starts it. Database migrations and Docker services are intentionally managed separately.

## Primary coach seed

Set `ADMIN_NAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` in `.env`, then run `npm run db:seed`. The
command creates or updates that account with the `coach` role. It does not create students,
exercises, plans, workouts, or reports, and it never prints the password.

## MrGym exercise catalog

The exercise library includes an archive view with restore and permanent-delete actions. Permanent
deletion removes the exercise and its media, and is blocked when a workout plan references the
exercise so existing plans and training history remain intact.

The independent Vite+ workspace [`apps/initial-data`](apps/initial-data/README.md) downloads and
imports the public exercise catalog, including the main `mgx-player` video and standalone front/back
muscle SVGs. It owns its source, dependencies, tests, configuration and local bundles. Configure its
separate environment file before importing into an existing coach's library:

```bash
npx playwright install chromium
cp apps/initial-data/.env.example apps/initial-data/.env
vp run initial-data:sync
```

Use `vp run initial-data:scrape` to prepare a portable bundle, then `vp run initial-data:import` to
upload files and import data on another machine. Both commands resume safely when rerun. See the
[Persian guide](apps/initial-data/README.md) for coach selection, sample runs, checksums, partial
failures and dry runs.

## Verification

```bash
npm run verify:structure
npm run typecheck
npm run build
```

Run the archive API tests with `vp run @akiraminafit/api#test`. Set `EXERCISE_TEST_DATABASE_URL` to
a disposable database ending in `_test` with the project schema applied. Database tests are skipped
when this variable is absent.

For production, use a private media bucket, signed read URLs, video scanning/transcoding, HTTPS,
rate limiting and managed backups.

For offline media downloads, set `MINIO_API_CORS_ALLOW_ORIGIN` to the web application's origin (for
example, `https://akiraminafit.ir`) and retain `GET` and `HEAD` access in the bucket CORS policy.
