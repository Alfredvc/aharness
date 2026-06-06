// packages/core/scripts/postBuild.mjs
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';

const webUiDist = '../web-ui/dist';

mkdirSync('dist/codexHome', { recursive: true });
copyFileSync('src/codexHome/hookClient.cjs', 'dist/codexHome/hookClient.cjs');
chmodSync('dist/codexHome/hookClient.cjs', 0o755);
chmodSync('dist/cli/main.js', 0o755);
chmodSync('dist/cli/completionMain.js', 0o755);

// Copy raw scaffold templates into dist so the published package can find
// them via dist/templates/. Keeps src/ free of non-TS files.
cpSync('templates', 'dist/templates', { recursive: true });

if (!existsSync(`${webUiDist}/index.html`)) {
  throw new Error('Web UI dist is missing; run `pnpm --dir packages/web-ui build` first.');
}

// Copy browser UI static assets that TypeScript does not emit.
rmSync('dist/ui/static', { recursive: true, force: true });
cpSync(webUiDist, 'dist/ui/static', { recursive: true });
