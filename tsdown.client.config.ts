import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@modesto_ma/dsh-channels'

/**
 * Client half build: one closure-factory bundle registered through
 * `window.__ModuleLoader__`, exactly like the first-party client modules.
 * React (and its JSX runtime) stay external — the web shell's frozen
 * PLATFORM_MODULES table answers them; everything else is inlined.
 *
 * The Bundle must already exist at load time: DSH consumes the built
 * `lib/client.js`, never the TypeScript source.
 */
export default defineConfig({
  name: `${PACKAGE_NAME}/client`,
  entry: { client: 'src/client/index.ts' },
  tsconfig: 'tsconfig.client.json',
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  external: [
    'react',
    'react/jsx-runtime',
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
