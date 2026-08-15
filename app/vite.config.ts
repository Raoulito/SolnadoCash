import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';

/**
 * Inject a Content-Security-Policy at build time.
 *
 * There was none, on any layer, which matters specifically because a secret note is persisted
 * to localStorage between generating it and the user confirming they saved it (FE-1). React's
 * escaping stops injected strings becoming markup, but escaping is a single control: if any
 * XSS or a compromised dependency ever runs in this origin, `connect-src` is what stops the
 * note being POSTed to an attacker. That is the reason for a tight connect-src rather than a
 * decorative policy.
 *
 * The policy is generated at build time because the RPC and relayer origins are env-driven and
 * a static file cannot know them. A meta tag is used so the policy travels with the bundle and
 * does not depend on host configuration; `public/_headers` carries the same policy plus the
 * headers a meta tag cannot express (frame-ancestors) for hosts that support it.
 *
 * `'wasm-unsafe-eval'` is required and not optional: proof generation compiles the withdraw
 * circuit's WebAssembly in the browser, and without it snarkjs cannot run at all.
 */

/**
 * Strip remote font imports from third-party CSS.
 *
 * @solana/wallet-adapter-react-ui/styles.css contains
 * `@import "https://fonts.googleapis.com/css2?family=DM+Sans..."`, so every page load of this
 * app handed the user's IP and Referer to Google. For a privacy protocol that is a real leak,
 * and it contradicts the app's own PrivacyNotice, which enumerates who can observe a
 * withdrawal. The CSP already blocks the request, but a CSP can be stripped by a
 * misconfigured host, so the import is removed from the bundle as well. Text falls back to the
 * Tailwind font stack.
 */
function stripRemoteFonts() {
  return {
    name: 'strip-remote-fonts',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (id.includes('node_modules/.vite')) return null;
      if (!/\.(css|js|mjs|cjs|ts|tsx)$/.test(id)) return null;

      let cleaned = code.replace(
        /@import\s+(?:url\()?["']?https?:\/\/[^"')]*(?:googleapis|gstatic)[^"')]*["']?\)?\s*;?/g,
        ''
      );

      // The mobile wallet adapter's embedded modal builds an HTML string containing
      // <link rel="preconnect" href="https://fonts.googleapis.com"> and a font stylesheet, and
      // injects it into the DOM. A preconnect is a resource hint that CSP does not reliably
      // block, so it would open a connection to Google — revealing the user's IP — even with a
      // strict policy. Remove the tags rather than rely on the policy.
      cleaned = cleaned.replace(
        /<link[^>]*(?:googleapis|gstatic)[^>]*>/g,
        ''
      );

      return cleaned === code ? null : { code: cleaned, map: null };
    },
  };
}

function cspPlugin(env: Record<string, string | undefined>) {
  const origin = (url?: string): string[] => {
    if (!url) return [];
    try {
      return [new URL(url).origin];
    } catch {
      return [];
    }
  };

  // Defaults mirror src/config.ts so a build with no env still gets a working policy.
  const rpc = origin(env.VITE_RPC_ENDPOINT) ;
  const relayer = origin(env.VITE_RELAYER_URL);
  const network = env.VITE_SOLANA_NETWORK ?? 'devnet';
  const defaultRpc =
    network === 'mainnet-beta'
      ? ['https://api.mainnet-beta.solana.com']
      : [`https://api.${network}.solana.com`];

  const connect = [
    "'self'",
    ...(rpc.length ? rpc : defaultRpc),
    ...relayer,
    // Solana RPC providers use websockets for subscriptions.
    ...(rpc.length ? rpc.map((o) => o.replace(/^http/, 'ws')) : defaultRpc.map((o) => o.replace(/^http/, 'ws'))),
    // Solflare's web wallet talks to its own origin.
    'https://solflare.com',
  ];

  const policy = [
    "default-src 'self'",
    // 'wasm-unsafe-eval' is required for snarkjs proof generation.
    "script-src 'self' 'wasm-unsafe-eval'",
    // The wallet-adapter UI injects inline styles.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${[...new Set(connect)].join(' ')}`,
    // Solflare renders its approval flow in a frame.
    "frame-src 'self' https://solflare.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "worker-src 'self' blob:",
    'upgrade-insecure-requests',
  ].join('; ');

  return {
    name: 'inject-csp',
    // Build only. The dev server needs an inline preamble script for React refresh and an HMR
    // websocket to its own origin, neither of which this policy allows — and the right fix is
    // not to weaken the shipped policy to accommodate the dev server.
    apply: 'build' as const,
    transformIndexHtml(html: string) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />\n` +
          `    <meta name="referrer" content="no-referrer" />`
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = process.env as Record<string, string | undefined>;
  void mode;
  return {
    // jsdom gives the leaf-cache tests a real localStorage.
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.ts'],
      // The security attack suite needs the hostile relayer running and fails loudly when it
      // is not, by design. Excluding it here keeps `npm test` self-contained; run it
      // deliberately with `npm run test:security` after starting the server.
      exclude: ['src/security/**'],
    },
    plugins: [
      react(),
      nodePolyfills({
        include: ['buffer', 'crypto', 'stream', 'util', 'process'],
      }),
      stripRemoteFonts(),
      cspPlugin(env),
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
  };
});
