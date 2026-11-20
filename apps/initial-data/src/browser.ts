import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

export async function openBrowser() {
  let executablePath = process.env.MRGYM_CHROMIUM_PATH;
  if (!executablePath) {
    try {
      await access(chromium.executablePath(), constants.X_OK);
    } catch {
      // Reuse an installed Chromium when the Playwright browser has not been downloaded.
      for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
        for (const name of ['chromium', 'chromium-browser', 'google-chrome']) {
          const candidate = path.join(directory, name);
          try {
            await access(candidate, constants.X_OK);
            executablePath = candidate;
            break;
          } catch {
            /* try next executable */
          }
        }
        if (executablePath) break;
      }
    }
  }
  try {
    return await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
  } catch (error) {
    throw new Error(
      'Chromium could not start. Run: npx playwright install chromium; or set MRGYM_CHROMIUM_PATH.',
      { cause: error },
    );
  }
}

export async function loadHtml(page: Page, html: string) {
  // Static public HTML already contains the muscle classes. Never execute site scripts
  // or load ads, video, fonts, analytics, or other unrelated resources.
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
}

export async function extractExercise(page: Page) {
  return page.evaluate(() => {
    // Object methods remain self-contained when tsx preserves function names.
    const { text, one } = {
      text(this: void, node: Element | null) {
        return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
      },
      one(this: void, selector: string) {
        return text(document.querySelector(selector));
      },
    };
    const player = document.querySelector('#mgx-player, mgx-player, .mgx-player');
    const video = player?.querySelector('video');
    const videoUrl =
      player?.getAttribute('data-video') ||
      video?.getAttribute('data-mrgym-src') ||
      video?.getAttribute('data-lazy-src') ||
      video?.getAttribute('src') ||
      video?.querySelector('source')?.getAttribute('src');
    if (!videoUrl) throw new Error('No main video found inside mgx-player.');
    const title = one('h1.mgx-title, h1.entry-title, h1');
    if (!title) throw new Error('Exercise title is missing.');
    const glance: Record<string, string> = {};
    document.querySelectorAll('.mgx-gtile').forEach((tile) => {
      glance[text(tile.querySelector('.mgx-gtile__k'))] = text(tile.querySelector('.mgx-gtile__v'));
    });
    const focus = document.querySelector('#mgx-focus');
    const muscles = JSON.parse(focus?.getAttribute('data-muscles') || '{}') as Record<
      string,
      unknown
    >;
    const anatomy = focus?.querySelector('.mgx-anat');
    if (!anatomy) throw new Error('The mgx-focus .mgx-anat muscle map is missing.');
    const diagrams = Array.from(
      anatomy.querySelectorAll<SVGSVGElement>('figure[data-side] > svg'),
    ).map((svg) => {
      const side = svg.closest('figure')?.getAttribute('data-side');
      if (side !== 'front' && side !== 'back') throw new Error(`Unexpected anatomy side: ${side}`);
      const clone = svg.cloneNode(true) as SVGSVGElement;
      const originals = [svg, ...svg.querySelectorAll('*')];
      const copies = [clone, ...clone.querySelectorAll('*')];
      const properties = [
        'fill',
        'fill-opacity',
        'fill-rule',
        'stroke',
        'stroke-width',
        'stroke-opacity',
        'stroke-linecap',
        'stroke-linejoin',
        'stroke-miterlimit',
        'stroke-dasharray',
        'stroke-dashoffset',
        'opacity',
        'color',
        'paint-order',
        'vector-effect',
        'stop-color',
        'stop-opacity',
        'clip-rule',
      ];
      // Freeze the real CSS cascade (including inherited values and CSS variables).
      // Keep transform attributes on mirrored muscle groups intact.
      originals.forEach((original, index) => {
        const copy = copies[index]!;
        const computed = getComputedStyle(original);
        copy.removeAttribute('style');
        for (const property of properties) {
          const value = computed
            .getPropertyValue(property)
            .trim()
            .replace(/url\(["']?[^)]*#([^"')]+)["']?\)/g, 'url(#$1)');
          if (value) copy.setAttribute(property, value);
        }
      });
      // The gradients live in a zero-sized sibling SVG; each exported view needs its own copy.
      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      anatomy
        .querySelectorAll('defs > *')
        .forEach((definition) => defs.appendChild(definition.cloneNode(true)));
      clone.prepend(defs);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', '640');
      clone.setAttribute('height', '960');
      // The original body silhouette uses translucent light strokes and needs a dark canvas.
      const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      const [x, y, width, height] = (svg.getAttribute('viewBox') || '0 0 320 480').split(/\s+/);
      for (const [key, value] of Object.entries({ x, y, width, height, fill: '#0e1116' })) {
        background.setAttribute(key, value!);
      }
      defs.after(background);
      // The exported image contains only inert SVG geometry and local fragment references.
      clone
        .querySelectorAll(
          'script, style, foreignObject, image, a, use, animate, animateTransform, set',
        )
        .forEach((node) => node.remove());
      [clone, ...clone.querySelectorAll('*')].forEach((node) => {
        for (const attr of Array.from(node.attributes)) {
          if (
            /^on/i.test(attr.name) ||
            ['class', 'tabindex', 'href', 'xlink:href'].includes(attr.name) ||
            (attr.value.includes('url(') && !/^url\(#[\w-]+\)$/.test(attr.value))
          ) {
            node.removeAttribute(attr.name);
          }
        }
      });
      return { side, svg: new XMLSerializer().serializeToString(clone) };
    });
    if (diagrams.length !== 2 || new Set(diagrams.map((item) => item.side)).size !== 2) {
      throw new Error('Both front and back muscle diagrams are required.');
    }
    const steps = Array.from(document.querySelectorAll('#mgx-howto .mgx-step__body')).map(text);
    if (!steps.length) throw new Error('Exercise instructions are missing.');
    return {
      title,
      englishTitle: one('.mgx-en'),
      videoUrl,
      posterUrl: video?.getAttribute('poster') || '',
      description:
        one('#mgx-overview .mgx-lead') ||
        document.querySelector('meta[name="description"]')?.getAttribute('content') ||
        '',
      muscleGroup: glance['عضله اصلی هدف'] || one('.mgx-tags .mgx-chip--pri'),
      equipment: glance['تجهیزات مورد نیاز'] || 'بدون وسیله',
      level: document.querySelector('.mgx-lvl')?.getAttribute('data-f') || '',
      steps,
      muscles,
      diagrams,
      sections: Array.from(document.querySelectorAll<HTMLElement>('.mgx-section'))
        .filter((section) => section.id !== 'mgx-related')
        .map((section) => ({
          id: section.id,
          title: text(section.querySelector('h2')),
          text: section.innerText.trim(),
        })),
    };
  });
}
