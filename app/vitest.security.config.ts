// app/vitest.security.config.ts
//
// The attack suite is separated from `npm test` because it needs an external target: the
// hostile relayer at /tmp (or app/security/hostile_relayer.mjs) must be listening. It fails
// loudly rather than skipping when the target is unreachable, since a security test that
// silently passes when it cannot reach anything is worse than no test. That behaviour is right
// for a deliberate run and wrong for the default suite, hence two configs.
//
// Usage:
//   node security/hostile_relayer.mjs 3999
//   npm run test:security

import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/security/**/*.test.ts'],
  },
  resolve: {
    alias: {
      'vite-plugin-node-polyfills/shims/buffer': path.resolve(
        __dirname,
        'node_modules/vite-plugin-node-polyfills/shims/buffer'
      ),
    },
  },
});
