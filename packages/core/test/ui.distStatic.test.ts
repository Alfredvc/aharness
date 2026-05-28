import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import viteConfig from '../../web-ui/vite.config';

const rootPackageJson = fileURLToPath(new URL('../../../package.json', import.meta.url));
const uiPackageJson = fileURLToPath(new URL('../../web-ui/package.json', import.meta.url));
const sourceIndexHtml = fileURLToPath(new URL('../src/ui/static/index.html', import.meta.url));
const distIndexHtml = fileURLToPath(new URL('../dist/ui/static/index.html', import.meta.url));
const servedStaticDir = fileURLToPath(new URL('../src/ui/static', import.meta.url));

const jsAssetReference = /<script[^>]+type="module"[^>]+src="\.\/assets\/[^"]+\.js"/;
const cssAssetReference = /<link[^>]+rel="stylesheet"[^>]+href="\.\/assets\/[^"]+\.css"/;
const placeholderBody = '<main id="root">Harness Web UI</main>';
const placeholderTitle = '<title>Harness Web UI</title>';

describe('packaged UI static assets', () => {
  it('configures Vite to emit relative asset URLs into the served source static directory', () => {
    expect(viteConfig).toMatchObject({
      base: './',
      build: {
        emptyOutDir: true,
        outDir: servedStaticDir,
      },
    });
  });

  it('exposes a UI typecheck script for the chunk gate', async () => {
    const packageJson = JSON.parse(await readFile(uiPackageJson, 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.typecheck).toBe('tsc --noEmit --project tsconfig.json');
  });

  it('runs the UI Vite build before packaging static assets from the root build', async () => {
    const packageJson = JSON.parse(await readFile(rootPackageJson, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const buildScript = packageJson.scripts?.build ?? '';

    expect(buildScript).toContain('pnpm --dir packages/web-ui build');
    expect(buildScript).toContain('pnpm --dir packages/core exec node scripts/postBuild.mjs');
    expect(buildScript.indexOf('pnpm --dir packages/web-ui build')).toBeLessThan(
      buildScript.indexOf('pnpm --dir packages/core exec node scripts/postBuild.mjs'),
    );
  });

  it('uses the Vite-built React app in source static assets after the UI build', async () => {
    const html = await readFile(sourceIndexHtml, 'utf8');

    expect(html).toMatch(jsAssetReference);
    expect(html).toMatch(cssAssetReference);
    expect(html).not.toContain(placeholderTitle);
    expect(html).not.toContain(placeholderBody);
  });

  it('packages the refreshed Vite-built React app after the root build', async () => {
    const html = await readFile(distIndexHtml, 'utf8');

    expect(html).toMatch(jsAssetReference);
    expect(html).toMatch(cssAssetReference);
    expect(html).not.toContain(placeholderTitle);
    expect(html).not.toContain(placeholderBody);
  });
});
