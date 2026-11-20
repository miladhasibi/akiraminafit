import { Window, type Element, type HTMLElement, type SVGSVGElement } from 'happy-dom';

async function withDocument<T>(html: string, extract: (window: Window) => T): Promise<T> {
  // The source already includes the data and CSS. Parse them in Node without
  // launching a browser, running page scripts or fetching embedded resources.
  const window = new Window({
    url: 'https://mrgym.ir/',
    width: 1440,
    height: 1000,
    settings: {
      enableJavaScriptEvaluation: false,
      disableJavaScriptFileLoading: true,
      enableCSSFileLoading: false,
      enableImageFileLoading: false,
      enableIframePageLoading: false,
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
      },
    },
  });
  try {
    window.document.write(html);
    return extract(window);
  } finally {
    await window.happyDOM.close();
  }
}

export function extractLinks(html: string) {
  return withDocument(html, ({ document }) =>
    Array.from(document.querySelectorAll('a[href]')).map((link) => link.getAttribute('href')!),
  );
}

export function sitemapLocations(xml: string) {
  return withDocument('', (window) => {
    const document = new window.DOMParser().parseFromString(xml, 'application/xml');
    if (document.querySelector('parsererror')) throw new Error('Invalid sitemap XML.');
    const root = document.documentElement.localName;
    if (!['sitemapindex', 'urlset'].includes(root)) throw new Error('Not a sitemap.');
    return {
      index: root === 'sitemapindex',
      // image:loc and video:content_loc are media, not exercise pages.
      urls: Array.from(document.documentElement.children).flatMap((child) =>
        Array.from(child.children)
          .filter(
            (node) =>
              node.localName === 'loc' &&
              node.namespaceURI === document.documentElement.namespaceURI,
          )
          .map((node) => node.textContent.trim()),
      ),
    };
  });
}

export function extractExercise(html: string) {
  return withDocument(html, (window) => {
    const { document } = window;
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
      const nonInherited = new Set(['opacity', 'vector-effect', 'stop-color', 'stop-opacity']);
      // Freeze the real CSS cascade (including inherited values and CSS variables).
      // Keep transform attributes on mirrored muscle groups intact.
      originals.forEach((original, index) => {
        const copy = copies[index]!;
        const computed = window.getComputedStyle(original);
        copy.removeAttribute('style');
        for (const property of properties) {
          let value = computed.getPropertyValue(property).trim();
          // Happy DOM leaves some inherited SVG properties empty. Preserve the
          // surrounding page's styles on the exported root; children can then
          // inherit normally without overriding their own presentation attributes.
          if (
            original === svg &&
            !value &&
            !svg.hasAttribute(property) &&
            !nonInherited.has(property)
          ) {
            for (
              let ancestor = svg.parentElement;
              ancestor && !value;
              ancestor = ancestor.parentElement
            ) {
              value =
                window.getComputedStyle(ancestor).getPropertyValue(property).trim() ||
                ancestor.getAttribute(property) ||
                '';
            }
          }
          if (value)
            copy.setAttribute(
              property,
              value.replace(/url\(["']?[^)]*#([^"')]+)["']?\)/g, 'url(#$1)'),
            );
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
          const value = attr.value ?? '';
          if (
            /^on/i.test(attr.name) ||
            ['class', 'tabindex', 'href', 'xlink:href'].includes(attr.name) ||
            (value.includes('url(') && !/^url\(#[\w-]+\)$/.test(value))
          ) {
            node.removeAttribute(attr.name);
          }
        }
      });
      return { side, svg: new window.XMLSerializer().serializeToString(clone) };
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
