import { defineConfig } from 'tsdown'

/**
 * Host half build: emit `lib/index.js` so an installed package (a profile's
 * `node_modules/dsh-channels`) runs as plain ESM. The Loader imports the
 * package entry with Node's default type stripping, which rejects TypeScript
 * parameter properties; shipping the built host is also what other DSH plugins
 * (dsh-pet, dsh-balance) do.
 *
 * Runtime deps stay external — the consuming profile resolves them through
 * the package's own `node_modules`.
 */
export default defineConfig({
  name: 'dsh-channels/host',
  entry: { index: 'src/index.ts' },
  tsconfig: 'tsconfig.json',
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2023',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  external: [
    '@larksuiteoapi/node-sdk',
    'zod',
  ],
})
