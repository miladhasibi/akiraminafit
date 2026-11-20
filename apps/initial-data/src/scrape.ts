import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { extractExercise, extractLinks, sitemapLocations } from './extract.js';
import {
  categoryUrl,
  exerciseUrl,
  hashFile,
  orderCatalogMedia,
  readManifest,
  recordSchema,
  SOURCE,
  sourceUrl,
  verifyRecord,
  writeJson,
  type Asset,
  type CatalogRecord,
  type Manifest,
} from './bundle.js';
import { SourceClient } from './http.js';

type ScrapeOptions = {
  directory: string;
  urls: string[];
  categories?: string[];
  limit?: number;
  refresh: boolean;
  interval: number;
};

export async function discoverExercises(client: SourceClient) {
  const index = await sitemapLocations(await client.text(`${SOURCE}/sitemap_index.xml`));
  const maps = index.urls.filter((url) =>
    /^\/exercise-sitemap\d*\.xml$/.test(new URL(sourceUrl(url)).pathname),
  );
  if (!index.index || !maps.length)
    throw new Error('Exercise sitemaps were not found in sitemap_index.xml.');
  const urls = new Set<string>();
  for (const url of maps) {
    const sitemap = await sitemapLocations(await client.text(url));
    if (sitemap.index) throw new Error(`Unexpected nested exercise sitemap: ${url}`);
    for (const candidate of sitemap.urls) urls.add(exerciseUrl(candidate));
  }
  if (!urls.size) throw new Error('No exercises discovered.');
  console.log(`Discovered ${urls.size} unique exercises across ${maps.length} sitemaps.`);
  return [...urls].sort();
}

export async function discoverCategoryExercises(client: SourceClient, categories: string[]) {
  const urls = new Set<string>();
  for (const category of new Set(categories.map(categoryUrl))) {
    const links = await extractLinks(await client.text(category));
    const exercises = new Set<string>();
    for (const link of links) {
      try {
        exercises.add(exerciseUrl(new URL(link, category).href));
      } catch {
        // Ignore navigation, media, external links and other categories.
      }
    }
    if (!exercises.size) throw new Error(`No exercises found in category: ${category}`);
    for (const url of exercises) urls.add(url);
  }
  console.log(`Discovered ${urls.size} unique exercises in the selected categories.`);
  return [...urls].sort();
}

export async function scrapeCatalog(options: ScrapeOptions) {
  const directory = path.resolve(options.directory);
  await mkdir(directory, { recursive: true });
  const client = new SourceClient(options.interval);
  const robots = await client.text(`${SOURCE}/robots.txt`);
  // Public exercise, category and sitemap pages only; never access the disallowed /api/ routes.
  if (
    /^Disallow:\s*\/(?:exercise\/|\s*$)/im.test(robots) ||
    (options.categories?.length && /^Disallow:\s*\/exercises\//im.test(robots))
  ) {
    throw new Error('robots.txt disallows exercise crawling.');
  }
  const discovered = options.urls.length
    ? [...new Set(options.urls.map(exerciseUrl))]
    : options.categories?.length
      ? await discoverCategoryExercises(client, options.categories)
      : await discoverExercises(client);
  const selectedUrls = options.limit ? discovered.slice(0, options.limit) : discovered;
  let previous: Manifest | undefined;
  try {
    previous = await readManifest(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const manifest: Manifest = {
    schemaVersion: 1,
    provider: 'mrgym',
    source: SOURCE,
    generatedAt: new Date().toISOString(),
    complete: false,
    discoveredCount: discovered.length,
    selectedUrls,
    exercises: [],
    failures: [],
  };
  const checkpoint = () => {
    manifest.generatedAt = new Date().toISOString();
    return writeJson(path.join(directory, 'manifest.json'), manifest);
  };
  // Keep all verified resume candidates in the checkpoint, even if this run is interrupted.
  if (!options.refresh) {
    for (const record of previous?.exercises ?? []) {
      if (selectedUrls.includes(record.sourceUrl)) {
        try {
          await verifyRecord(directory, record);
          manifest.exercises.push({ ...record, media: orderCatalogMedia(record.media) });
        } catch {
          /* redownload damaged files */
        }
      }
    }
  }
  await checkpoint();
  for (const [index, url] of selectedUrls.entries()) {
    if (manifest.exercises.some((record) => record.sourceUrl === url)) {
      console.log(`[${index + 1}/${selectedUrls.length}] Cached: ${url}`);
      continue;
    }
    try {
      const html = await client.text(url);
      const extracted = await extractExercise(html);
      const slug = new URL(url).pathname.split('/')[2]!;
      const assetDirectory = `media/${slug}`;
      const media: Asset[] = [];
      await mkdir(path.join(directory, assetDirectory), { recursive: true });
      // Preserve useful source data and diagrams even if the remote video host is unavailable.
      await writeJson(path.join(directory, 'records', `${slug}.source.json`), {
        sourceUrl: url,
        scrapedAt: new Date().toISOString(),
        ...extracted,
        diagrams: extracted.diagrams.map((diagram) => ({
          side: diagram.side,
          path: `${assetDirectory}/anatomy-${diagram.side}.svg`,
        })),
      });
      const download = async (
        candidate: string,
        role: Asset['role'],
        mediaType: Asset['mediaType'],
      ) => {
        const remote = sourceUrl(candidate, url);
        const tempFile = path.join(directory, assetDirectory, `${role}.download`);
        const mimeType = await client.download(remote, tempFile, mediaType);
        const extensions: Record<string, string> = {
          'video/mp4': 'mp4',
          'video/webm': 'webm',
          'image/jpeg': 'jpg',
          'image/png': 'png',
          'image/webp': 'webp',
        };
        const relative = `${assetDirectory}/${role}.${extensions[mimeType]}`;
        await rename(tempFile, path.join(directory, relative));
        media.push({
          path: relative,
          role,
          mediaType,
          mimeType: mimeType as Asset['mimeType'],
          sourceUrl: remote,
          ...(await hashFile(path.join(directory, relative))),
        });
      };
      for (const diagram of extracted.diagrams) {
        const relative = `${assetDirectory}/anatomy-${diagram.side}.svg`;
        await writeFile(path.join(directory, relative), diagram.svg);
        media.push({
          path: relative,
          role: diagram.side === 'front' ? 'anatomy-front' : 'anatomy-back',
          mediaType: 'image',
          mimeType: 'image/svg+xml',
          ...(await hashFile(path.join(directory, relative))),
        });
      }
      await download(extracted.videoUrl, 'main-video', 'video');
      // Saving diagrams first must not change the main video order in the package or app.
      media.unshift(media.pop()!);
      if (extracted.posterUrl) await download(extracted.posterUrl, 'poster', 'image');
      const instructions = extracted.steps.map((step, i) => `${i + 1}. ${step}`).join('\n');
      const record: CatalogRecord = recordSchema.parse({
        sourceUrl: url,
        slug,
        scrapedAt: new Date().toISOString(),
        englishTitle: extracted.englishTitle,
        input: {
          title: extracted.title,
          description: extracted.description.slice(0, 1000),
          instructions: instructions.slice(0, 4000),
          muscleGroup: extracted.muscleGroup,
          equipment: extracted.equipment,
          difficulty:
            ({ easy: 'beginner', mid: 'intermediate', hard: 'advanced' } as const)[
              extracted.level as 'easy' | 'mid' | 'hard'
            ] ?? 'beginner',
        },
        muscles: extracted.muscles,
        sections: extracted.sections,
        media: orderCatalogMedia(media),
      });
      // Preserve the complete source text and provenance alongside the import-ready fields.
      await writeJson(path.join(directory, 'records', `${slug}.json`), {
        ...record,
        original: { description: extracted.description, instructions, level: extracted.level },
      });
      manifest.exercises.push(record);
      console.log(`[${index + 1}/${selectedUrls.length}] Downloaded: ${record.input.title}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      manifest.failures.push({ url, message });
      console.error(`[${index + 1}/${selectedUrls.length}] Failed: ${url}: ${message}`);
    }
    await checkpoint();
  }
  // Restore selection order after mixing cached and newly downloaded records.
  manifest.exercises.sort(
    (a, b) => selectedUrls.indexOf(a.sourceUrl) - selectedUrls.indexOf(b.sourceUrl),
  );
  manifest.complete =
    !manifest.failures.length && manifest.exercises.length === selectedUrls.length;
  await checkpoint();
  console.log(
    `Bundle: ${directory} (${manifest.exercises.length} exercises, ${manifest.failures.length} failures).`,
  );
  if (!manifest.complete)
    throw new Error(
      'Scrape incomplete. Run the same command to resume; see manifest.json failures.',
    );
  return manifest;
}
