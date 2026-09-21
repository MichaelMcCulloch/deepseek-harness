import { defineConfig } from 'tsdown'

const entry = (path: string) => ({
  entry: [path],
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024' as const,
  fixedExtension: false,
  dts: false,
  clean: false,
})

/** Build the dispatcher plugin and the host-plane child plugin as separate Loader entries. */
export default defineConfig([
  entry('lib/types/index.js'),
  entry('lib/types/child.js'),
])
