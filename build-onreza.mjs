import { mkdir, copyFile, writeFile } from 'node:fs/promises';

// Copy only the three public runtime files; never package local secrets or notes.
const output = new URL('./dist-onreza/', import.meta.url);
await mkdir(new URL('.onreza/', output), { recursive: true });
for (const file of ['index.mjs', 'server.mjs', 'package.json']) {
  await copyFile(new URL(file, import.meta.url), new URL(file, output));
}

// https://docs.onreza.ru/manifest.html — version 2, public HTTP Compute process.
const manifest = {
  version: 2,
  layers: [{
    name: 'server',
    target: 'COMPUTE',
    directory: '.',
    entry: 'server.mjs',
    runtime: {
      timeoutMs: 60000,
      memoryMb: 256,
      network: {
        schemaVersion: 'COMPUTE_NETWORK_V1',
        exposure: 'PUBLIC',
        ports: [{ name: 'http', protocol: 'http', port: 3000, binding: 'primary' }],
        readiness: { protocol: 'http', port: 'http', path: '/healthz' },
        allowFrom: [],
      },
    },
  }],
  routes: [{ pattern: '^/.*$', layer: 'server', priority: 0 }],
};
await writeFile(new URL('.onreza/manifest.json', output), JSON.stringify(manifest, null, 2) + '\n');
console.log('ONREZA output: dist-onreza (4 public files, no diary secrets).');
