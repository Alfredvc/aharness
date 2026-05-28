import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// macOS `$TMPDIR` is `/var/folders/<2>/<26-char-hash>/T/` (~49 chars), which
// blows past the 104-byte `sun_path` limit once tests append a run-dir and
// `hook.sock` suffix. Pin to `/tmp` for tests so UDS bindings stay short.
// Mirrors the convention used by Postgres, devenv, NixOS, EasyBuild, etc.
if (process.platform === 'darwin') {
  process.env['TMPDIR'] = '/tmp';
}

// Resolve workspace packages to their source entry points so `pnpm test` works
// without requiring `pnpm build` first.
const resolveSrc = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@aharness/core/runtime': resolveSrc('./packages/core/src/runtime.ts'),
      '@aharness/core/package-runner': resolveSrc('./packages/core/src/package-runner.ts'),
      '@aharness/core': resolveSrc('./packages/core/src/index.ts'),
      '@aharness/test-support': resolveSrc('./packages/test-support/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
    passWithNoTests: false,
  },
});
