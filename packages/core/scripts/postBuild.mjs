// packages/core/scripts/postBuild.mjs
import { chmodSync, copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';

mkdirSync('dist/codexHome', { recursive: true });
copyFileSync('src/codexHome/hookClient.cjs', 'dist/codexHome/hookClient.cjs');
chmodSync('dist/codexHome/hookClient.cjs', 0o755);
chmodSync('dist/cli/main.js', 0o755);

// Copy raw scaffold templates into dist so the published package can find
// them via dist/templates/. Keeps src/ free of non-TS files.
cpSync('templates', 'dist/templates', { recursive: true });

// Copy browser UI static assets that TypeScript does not emit.
rmSync('dist/ui/static', { recursive: true, force: true });
cpSync('src/ui/static', 'dist/ui/static', { recursive: true });
