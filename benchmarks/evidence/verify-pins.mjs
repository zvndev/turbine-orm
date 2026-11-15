import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const pins = JSON.parse(readFileSync(new URL('./pins.json', import.meta.url)));
const require = createRequire(import.meta.url);
export function installedVersion(name) {
  // Some packages intentionally do not export package.json.
  let directory = dirname(require.resolve(name));
  for (;;) {
    try {
      const data = JSON.parse(readFileSync(join(directory, 'package.json')));
      if (data.name === pins.selection[name]?.package) return data.version;
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot determine installed ${name} version`);
    directory = parent;
  }
}
export function verifyPins() {
  const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
  const lock = JSON.parse(readFileSync(new URL('./package-lock.json', import.meta.url)));
  const installed = {};
  for (const [name, pin] of Object.entries(pins.selection)) {
    const specifier = name === pin.package ? pin.version : `npm:${pin.package}@${pin.version}`;
    assert.equal(manifest.dependencies[name], specifier, `Manifest pin mismatch: ${name}`);
    assert.equal(lock.packages[`node_modules/${name}`].version, pin.version, `Lock pin mismatch: ${name}`);
    assert.equal(lock.packages[`node_modules/${name}`].integrity, pin.integrity, `Lock integrity mismatch: ${name}`);
    assert.equal(installedVersion(name), pin.version, `Installed pin mismatch: ${name}`);
    installed[name] = pin.version;
  }
  return installed;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(verifyPins(), null, 2));
