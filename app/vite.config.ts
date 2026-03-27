import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ['buffer', 'crypto', 'stream', 'util', 'process'],
    }),
  ],
  resolve: {
    // Ensure linked SDK uses the app's copies of shared dependencies.
    dedupe: [
      '@solana/web3.js',
      'bn.js',
      '@coral-xyz/anchor',
      'buffer',
      'circomlibjs',
      'snarkjs',
    ],
    alias: {
      // Make the buffer shim resolvable from any location (including ../sdk/node_modules)
      'vite-plugin-node-polyfills/shims/buffer': path.resolve(
        __dirname,
        'node_modules/vite-plugin-node-polyfills/shims/buffer'
      ),
    },
  },
});
