import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { extractExercise, sitemapLocations } from './extract.js';
import {
  assetPath,
  catalogId,
  categoryUrl,
  exerciseUrl,
  hashFile,
  manifestSchema,
  SOURCE,
  writeJson,
  type Manifest,
} from './bundle.js';
import { preflightBundle, mediaStorageKey } from './import.js';
import { discoverCategoryExercises, discoverExercises, scrapeCatalog } from './scrape.js';
import { SourceClient } from './http.js';

let directory: string;
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'mrgym-catalog-test-'));
});
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

// An authored fixture models the CSS cascade and sibling gradient arrangement of the source.
const fixture = `<!doctype html><html><head><style>
:root { --target-stroke: rgb(255, 248, 225); }
.mgx-fill { fill: rgba(148,163,184,.12); stroke: gray; }
.is-primary .mgx-fill { fill: url(#primary-gradient); stroke: var(--target-stroke); stroke-width: 1.4; }
.is-secondary .mgx-fill { fill: rgb(251,146,60); }
.mgx-fig[data-side="back"] { display: none; }
</style></head><body>
<h1 class="mgx-title">حرکت آزمایشی</h1><div class="mgx-en">Test Exercise</div>
<div class="mgx-lvl" data-f="mid"></div>
<div class="mgx-tags"><a class="mgx-chip--pri">سینه</a></div>
<div class="mgx-gtile"><span class="mgx-gtile__k">تجهیزات مورد نیاز</span><span class="mgx-gtile__v">دمبل</span></div>
<div id="mgx-player" data-video="https://video.mrgym.ir/Exercise/main.mp4"><video poster="https://mrgym.ir/media/poster.webp" data-mrgym-src="https://video.mrgym.ir/wrong.mp4"></video></div>
<video src="https://video.mrgym.ir/unrelated.mp4"></video>
<section id="mgx-overview" class="mgx-section"><h2>معرفی</h2><p class="mgx-lead">توضیح آزمایشی</p></section>
<section id="mgx-howto" class="mgx-section"><h2>مراحل</h2><div class="mgx-step__body"><span>شروع</span> <span>مرحله اول</span></div></section>
<section id="mgx-focus" class="mgx-section" data-muscles='{&quot;chest&quot;:{&quot;fa&quot;:&quot;سینه&quot;,&quot;pri&quot;:1}}'>
<div class="mgx-anat"><svg width="0" height="0"><defs><linearGradient id="primary-gradient"><stop offset="0" stop-color="#ffe89a"/><stop offset="1" stop-color="#c98816"/></linearGradient></defs></svg>
${['front', 'back'].map((side) => `<figure class="mgx-fig" data-side="${side}"><svg viewBox="0 0 320 480"><g class="mgx-zone is-primary" data-slug="chest"><path class="mgx-fill" d="M10 10h50v50H10Z"/><g transform="translate(320,0) scale(-1,1)"><path class="mgx-fill" d="M10 10h50v50H10Z"/></g></g><g class="is-secondary"><path class="mgx-fill" d="M10 80h50v50H10Z"/></g></svg></figure>`).join('')}
</div></section><script>document.querySelector('h1').textContent='script executed';</script>
</body></html>`;

void test('extracts the player video, Persian fields and both CSS-colored SVG views', async () => {
  const result = await extractExercise(fixture);
  assert.equal(result.title, 'حرکت آزمایشی');
  assert.equal(result.englishTitle, 'Test Exercise');
  assert.equal(result.videoUrl, 'https://video.mrgym.ir/Exercise/main.mp4');
  assert.equal(result.equipment, 'دمبل');
  assert.equal(result.level, 'mid');
  assert.deepEqual(result.muscles, { chest: { fa: 'سینه', pri: 1 } });
  assert.deepEqual(result.steps, ['شروع مرحله اول']);
  assert.equal(result.diagrams.length, 2);
  const window = new Window();
  try {
    for (const diagram of result.diagrams) {
      const document = new window.DOMParser().parseFromString(diagram.svg, 'image/svg+xml');
      assert.equal(document.querySelector('parsererror'), null);
      const target = document.querySelector('[data-slug="chest"] path')!;
      const rendered = {
        fill: target.getAttribute('fill')!,
        stroke: target.getAttribute('stroke'),
        secondary: document.querySelector('svg > g:last-child path')?.getAttribute('fill'),
        gradient: Boolean(document.querySelector('svg > defs #primary-gradient')),
        transform: document.querySelector('[transform]')?.getAttribute('transform'),
        background: document.querySelector('svg > rect')?.getAttribute('fill'),
        hasCss: Boolean(document.querySelector('style, [class]')),
        width: document.querySelector('svg')?.getAttribute('width'),
      };
      assert.match(rendered.fill, /url\(["']?#primary-gradient["']?\)/);
      assert.equal(rendered.stroke, 'rgb(255, 248, 225)');
      assert.equal(rendered.secondary?.replace(/\s/g, ''), 'rgb(251,146,60)');
      assert.equal(rendered.gradient, true);
      assert.equal(rendered.transform, 'translate(320,0) scale(-1,1)');
      assert.equal(rendered.background, '#0e1116');
      assert.equal(rendered.hasCss, false);
      assert.equal(rendered.width, '640');
    }
  } finally {
    await window.happyDOM.close();
  }
});

void test('fails when the main player is missing instead of using an unrelated video', async () => {
  await assert.rejects(
    extractExercise(fixture.replace('id="mgx-player"', 'id="other-player"')),
    /No main video/,
  );
});

void test('preserves inherited SVG colors and local presentation attributes', async () => {
  const result = await extractExercise(
    fixture
      .replace(
        '</style>',
        '.mgx-anat { fill: #123456; stroke: #abcdef; stroke-width: 3; opacity: 0.5; }</style>',
      )
      .replaceAll(
        '<svg viewBox="0 0 320 480">',
        '<svg viewBox="0 0 320 480"><path data-local="true" fill="#654321" d="M0 0h5v5Z"/>',
      ),
  );
  const window = new Window();
  try {
    for (const diagram of result.diagrams) {
      const document = new window.DOMParser().parseFromString(diagram.svg, 'image/svg+xml');
      const svg = document.documentElement;
      assert.equal(svg.getAttribute('fill'), '#123456');
      assert.equal(svg.getAttribute('stroke'), '#abcdef');
      assert.equal(svg.getAttribute('stroke-width'), '3');
      assert.equal(svg.getAttribute('opacity'), null);
      assert.equal(svg.querySelector('[data-local]')?.getAttribute('fill'), '#654321');
    }
  } finally {
    await window.happyDOM.close();
  }
});

void test('parses untrusted HTML without executing scripts or loading embedded resources', async (t) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.end('unexpected embedded request');
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const html = fixture
    .replace(
      '<head>',
      `<head>
    <link rel="stylesheet" href="${origin}/style.css">
    <style>@import url("${origin}/import.css");</style>
    <script src="${origin}/script.js"></script>
  `,
    )
    .replace(
      '<body>',
      `<body>
    <img src="${origin}/image.png">
    <iframe src="${origin}/frame"></iframe>
    <iframe srcdoc="&lt;script&gt;parent.document.querySelector('h1').textContent='executed'&lt;/script&gt;"></iframe>
  `,
    );
  const result = await extractExercise(html);
  assert.equal(result.title, 'حرکت آزمایشی');
  assert.deepEqual(requests, []);
});

void test('reads only page locations from namespaced sitemaps, excluding image locations', async () => {
  const parsed = await sitemapLocations(
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><url><loc>https://mrgym.ir/exercise/test/</loc><image:image><image:loc>https://mrgym.ir/media/photo.webp</image:loc></image:image></url></urlset>`,
  );
  assert.deepEqual(parsed, { index: false, urls: ['https://mrgym.ir/exercise/test/'] });
  await assert.rejects(sitemapLocations('<html>error</html>'), /Not a sitemap/);
  await assert.rejects(sitemapLocations('<urlset><url></urlset>'), /Invalid sitemap XML/);
});

void test('discovers all exercise sitemaps and deduplicates their page locations', async (t) => {
  const client = new SourceClient(0);
  t.mock.method(client, 'text', async (url: string) =>
    url.endsWith('/sitemap_index.xml')
      ? '<sitemapindex><sitemap><loc>https://mrgym.ir/exercise-sitemap.xml</loc></sitemap><sitemap><loc>https://mrgym.ir/exercise-sitemap2.xml</loc></sitemap><sitemap><loc>https://mrgym.ir/post-sitemap.xml</loc></sitemap></sitemapindex>'
      : `<urlset><url><loc>https://mrgym.ir/exercise/shared/</loc></url><url><loc>https://mrgym.ir/exercise/${url.endsWith('sitemap2.xml') ? 'second' : 'first'}/</loc></url></urlset>`,
  );
  assert.deepEqual(
    await discoverExercises(client),
    ['first', 'second', 'shared'].map((slug) => `${SOURCE}/exercise/${slug}/`),
  );
});

void test('uses stable coach-scoped IDs and rejects unrelated source URLs', () => {
  const url = 'https://mrgym.ir/exercise/test/';
  assert.equal(catalogId('coach-a', url), catalogId('coach-a', url));
  assert.notEqual(catalogId('coach-a', url), catalogId('coach-b', url));
  assert.notEqual(catalogId('coach-a', url), catalogId('coach-a', url, 'main-video'));
  assert.throws(() => exerciseUrl('https://mrgym.ir/exercises/chest/'));
  assert.throws(() => exerciseUrl('https://evil.example/exercise/test/'));
  assert.throws(() => exerciseUrl('https://mrgym.ir/exercise/test/?tracking=1'));
});

void test('accepts category slugs or source category URLs and rejects unrelated URLs', () => {
  const expected = 'https://mrgym.ir/exercises/chest/';
  assert.equal(categoryUrl('chest'), expected);
  assert.equal(categoryUrl(expected), expected);
  assert.equal(categoryUrl('/exercises/chest/'), expected);
  assert.equal(categoryUrl('lower-back'), 'https://mrgym.ir/exercises/lower-back/');
  for (const invalid of [
    '',
    'https://evil.example/exercises/chest/',
    'https://mrgym.ir/exercise/test/',
    'https://mrgym.ir/exercises/',
    'https://mrgym.ir/exercises/chest/?page=2',
  ]) {
    assert.throws(() => categoryUrl(invalid));
  }
});

void test('combines categories without duplicate exercises or unrelated links', async (t) => {
  const client = new SourceClient(0);
  const requested: string[] = [];
  t.mock.method(client, 'text', async (url: string) => {
    requested.push(url);
    return `<a href="/exercise/shared/">Shared</a>
      <a href="https://mrgym.ir/exercise/shared/">Duplicate</a>
      <a href="/exercise/${url.includes('/chest/') ? 'chest-test' : 'back-test'}/">Exercise</a>
      <a href="/exercises/abs/">Other category</a>
      <a href="https://evil.example/exercise/external/">External</a>
      <a href="/exercise/tracking/?ref=category">Tracking URL</a>
      <a href="https://video.mrgym.ir/test.mp4">Video</a>`;
  });
  assert.deepEqual(
    await discoverCategoryExercises(client, ['chest', 'https://mrgym.ir/exercises/chest/', 'back']),
    ['back-test', 'chest-test', 'shared'].map((slug) => `${SOURCE}/exercise/${slug}/`),
  );
  assert.deepEqual(requested, [`${SOURCE}/exercises/chest/`, `${SOURCE}/exercises/back/`]);
  t.mock.method(client, 'text', async () => '<a href="/exercises/">No exercises</a>');
  await assert.rejects(discoverCategoryExercises(client, ['missing']), /No exercises/);
});

async function makeBundle(subdirectory: string) {
  const bundle = path.join(directory, subdirectory);
  await mkdir(path.join(bundle, 'media'), { recursive: true });
  const relative = 'media/main.mp4';
  await writeFile(path.join(bundle, relative), 'sample media bytes');
  const url = 'https://mrgym.ir/exercise/test/';
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
        slug: 'test',
        scrapedAt: new Date().toISOString(),
        englishTitle: 'Test',
        input: {
          title: 'حرکت نمونه',
          description: '',
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
            ...(await hashFile(path.join(bundle, relative))),
          },
        ],
      },
    ],
  };
  await writeJson(path.join(bundle, 'manifest.json'), manifest);
  return { bundle, manifest };
}

void test('preflight catches corruption before import and storage keys change with content', async () => {
  const { bundle, manifest } = await makeBundle('integrity');
  assert.equal((await preflightBundle(bundle)).exercises.length, 1);
  const record = manifest.exercises[0]!;
  const asset = record.media[0]!;
  const key = mediaStorageKey('coach-a', record, asset);
  assert.match(key, new RegExp(asset.sha256));
  assert.notEqual(key, mediaStorageKey('coach-a', record, { ...asset, sha256: '0'.repeat(64) }));
  await writeFile(path.join(bundle, asset.path), 'corrupted bytes');
  await assert.rejects(preflightBundle(bundle), /checksum mismatch/);
});

void test('incomplete bundles require explicit partial import and cannot claim completeness', async () => {
  const { bundle, manifest } = await makeBundle('partial');
  manifest.complete = false;
  manifest.failures.push({ url: 'https://mrgym.ir/exercise/failed/', message: 'HTTP 503' });
  await writeJson(path.join(bundle, 'manifest.json'), manifest);
  await assert.rejects(preflightBundle(bundle), /incomplete/);
  assert.equal((await preflightBundle(bundle, true)).exercises.length, 1);
  assert.equal(manifestSchema.safeParse({ ...manifest, complete: true }).success, false);
});

void test('rejects duplicate entries and paths or symlinks that escape the bundle', async () => {
  const { bundle, manifest } = await makeBundle('paths');
  assert.equal(
    manifestSchema.safeParse({
      ...manifest,
      exercises: [...manifest.exercises, ...manifest.exercises],
    }).success,
    false,
  );
  await assert.rejects(assetPath(bundle, '../outside.mp4'), /Unsafe asset path/);
  const outside = path.join(directory, 'outside.mp4');
  await writeFile(outside, 'outside');
  await symlink(outside, path.join(bundle, 'media', 'link.mp4'));
  await assert.rejects(assetPath(bundle, 'media/link.mp4'), /escapes bundle/);
});

void test('streams valid media to disk and never saves browser-verification HTML as video', async (t) => {
  const client = new SourceClient(0);
  const file = path.join(directory, 'download.mp4');
  const mocked = t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response('video bytes', {
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': '11' },
      }),
  );
  assert.equal(
    await client.download('https://video.mrgym.ir/test.mp4', file, 'video'),
    'video/mp4',
  );
  assert.equal(await readFile(file, 'utf8'), 'video bytes');
  mocked.mock.mockImplementation(
    async () =>
      new Response('<html>One moment, please... request is being verified</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
  );
  const failed = path.join(directory, 'must-not-exist.mp4');
  await assert.rejects(
    client.download('https://video.mrgym.ir/test.mp4', failed, 'video'),
    /requires browser verification/,
  );
  await assert.rejects(access(failed));
  await assert.rejects(access(`${failed}.part`));
});

void test('builds an importable bundle with video first and resumes without downloading verified records', async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\n');
    if (url.endsWith('/exercise/scrape-test/'))
      return new Response(fixture, { headers: { 'Content-Type': 'text/html' } });
    if (url.endsWith('/main.mp4'))
      return new Response('video bytes', {
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': '11' },
      });
    if (url.endsWith('/poster.webp'))
      return new Response('poster bytes', {
        headers: { 'Content-Type': 'image/webp', 'Content-Length': '12' },
      });
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  const bundle = path.join(directory, 'scrape-flow');
  const options = {
    directory: bundle,
    urls: ['https://mrgym.ir/exercise/scrape-test/'],
    interval: 0,
    refresh: false,
  };
  const first = await scrapeCatalog(options);
  assert.equal(first.complete, true);
  assert.deepEqual(
    first.exercises[0]!.media.map((asset) => asset.role),
    ['main-video', 'poster', 'anatomy-front', 'anatomy-back'],
  );
  assert.equal((await preflightBundle(bundle)).exercises[0]!.input.difficulty, 'intermediate');
  assert.equal(requests.length, 4);
  requests.length = 0;
  const resumed = await scrapeCatalog(options);
  assert.equal(resumed.complete, true);
  assert.deepEqual(requests, ['https://mrgym.ir/robots.txt']);
  await writeFile(path.join(bundle, first.exercises[0]!.media[0]!.path), 'damaged');
  requests.length = 0;
  await scrapeCatalog(options);
  assert.equal(requests.length, 4);
  await preflightBundle(bundle);
});

void test('limits category downloads and narrows an existing bundle when resuming', async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\n');
    if (url.endsWith('/exercises/chest/'))
      return new Response(
        ['alpha', 'beta', 'gamma', 'alpha']
          .map((slug) => `<a href="/exercise/${slug}/">${slug}</a>`)
          .join(''),
      );
    if (url.endsWith('/exercise/alpha/') || url.endsWith('/exercise/beta/'))
      return new Response(fixture);
    if (url.endsWith('/main.mp4'))
      return new Response('video bytes', { headers: { 'Content-Type': 'video/mp4' } });
    if (url.endsWith('/poster.webp'))
      return new Response('poster bytes', { headers: { 'Content-Type': 'image/webp' } });
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  const bundle = path.join(directory, 'category-limit');
  const options = {
    directory: bundle,
    urls: [],
    categories: ['chest'],
    limit: 2,
    interval: 0,
    refresh: false,
  };
  const first = await scrapeCatalog(options);
  assert.equal(first.complete, true);
  assert.equal(first.discoveredCount, 3);
  assert.deepEqual(
    first.selectedUrls,
    ['alpha', 'beta'].map((slug) => `${SOURCE}/exercise/${slug}/`),
  );
  assert.equal(first.exercises.length, 2);
  assert.deepEqual(
    requests.filter((url) => url.includes('/exercise/')),
    first.selectedUrls,
  );
  assert.equal(
    requests.some((url) => url.includes('sitemap')),
    false,
  );
  await preflightBundle(bundle);

  requests.length = 0;
  const resumed = await scrapeCatalog({ ...options, limit: 1 });
  assert.equal(resumed.complete, true);
  assert.deepEqual(resumed.selectedUrls, [`${SOURCE}/exercise/alpha/`]);
  assert.equal(resumed.exercises.length, 1);
  assert.deepEqual(requests, [`${SOURCE}/robots.txt`, `${SOURCE}/exercises/chest/`]);
  assert.equal((await preflightBundle(bundle)).exercises.length, 1);
});
