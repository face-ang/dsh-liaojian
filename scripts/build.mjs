import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

await build({
  entryPoints: ['client/index.jsx'],
  outfile: 'client/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: ['chrome120', 'safari17'],
  external: ['react'],
  loader: { '.css': 'text' },
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {\nconst module = { exports: {} };` },
  footer: { js: 'return module.exports; } });' },
})
