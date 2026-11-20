import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { categoryUrl, DEFAULT_BUNDLE } from './bundle.js';

const HELP = `Initial data — دریافت داده‌ی اولیه

From the repository root:
  vp run initial-data:scrape [options]   Download a portable bundle (no database needed)
  vp run initial-data:import [options]   Verify files, upload to S3/MinIO and import for a coach
  vp run initial-data:sync [options]     Scrape and import in one command

Pass options directly with vp. With npm, use: npm run initial-data:<command> -- [options]

Options:
  --bundle <directory>   Bundle directory (default: apps/initial-data/${DEFAULT_BUNDLE}; custom paths relative to repository root)
  --url <url>            Download a specific exercise; repeat for multiple exercises
  --category <slug|url>  Download exercises from a category (e.g. chest); repeat to combine categories
  --limit <number>       Download only the first N exercises from the selected categories or URLs
  --delay-ms <number>    Delay between source requests (default: 1000; minimum: 250)
  --refresh             Download selected pages and files again instead of resuming
  --coach-email <email>  Existing coach email (default: COACH_EMAIL from apps/initial-data/.env)
  --dry-run             Validate the bundle without database access or uploads (import only)
  --allow-partial       Explicitly import successful records from an incomplete bundle
  --help                Show help

Scraping runs entirely in Node.js; no Chromium or browser installation is needed.
Interrupted scrapes resume with the same command. See apps/initial-data/README.md.
`;

async function main() {
  const args = process.argv.slice(2);
  // vp forwards an optional runner separator all the way past the workspace script.
  if (args[1] === '--') args.splice(1, 1);
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      bundle: { type: 'string' },
      url: { type: 'string', multiple: true },
      category: { type: 'string', multiple: true },
      limit: { type: 'string' },
      'delay-ms': { type: 'string' },
      refresh: { type: 'boolean', default: false },
      'coach-email': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'allow-partial': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const [command] = positionals;
  if (positionals.length !== 1 || !['scrape', 'import', 'sync'].includes(command ?? ''))
    throw new Error(HELP);
  if (values['dry-run'] && command !== 'import')
    throw new Error('--dry-run is supported by initial-data:import only.');
  if (
    command === 'import' &&
    (values.url ||
      values.category ||
      values.limit !== undefined ||
      values.refresh ||
      values['delay-ms'])
  ) {
    throw new Error('Scraping options are not supported by initial-data:import.');
  }
  if (values.url && values.category)
    throw new Error('Use either --url or --category to select exercises, not both.');
  const categories = values.category?.map(categoryUrl) ?? [];
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    throw new Error('--limit must be a positive integer.');
  const interval = Number(values['delay-ms'] ?? 1000);
  if (!Number.isSafeInteger(interval) || interval < 250)
    throw new Error('--delay-ms must be an integer of at least 250.');
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const appDirectory = fileURLToPath(new URL('../', import.meta.url));
  const directory = values.bundle
    ? path.resolve(root, values.bundle)
    : path.resolve(appDirectory, DEFAULT_BUNDLE);
  if (command === 'scrape' || command === 'sync') {
    const { scrapeCatalog } = await import('./scrape.js');
    await scrapeCatalog({
      directory,
      urls: values.url ?? [],
      categories,
      refresh: values.refresh,
      interval,
      ...(limit === undefined ? {} : { limit }),
    });
  }
  if (command === 'import' || command === 'sync') {
    const { importCatalog } = await import('./import.js');
    await importCatalog({
      directory,
      dryRun: values['dry-run'],
      allowPartial: values['allow-partial'],
      ...(values['coach-email'] ? { coachEmail: values['coach-email'] } : {}),
    });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
