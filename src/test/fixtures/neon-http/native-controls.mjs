// Deliberate faults live only in copied fixtures, never in production source or an actual archive.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function controlFixtures(output) {
  const original = readFileSync(new URL('./native-contract.mjs', import.meta.url), 'utf8');
  const start = original.indexOf('      assert.deepEqual(await at.create(');
  const end = original.indexOf('      const native = ', start);
  assert.ok(start !== -1 && end > start, 'Native effect-control anchor must exist');
  const invocation = '      await at.create({ data: { id: 9, tenantId: 4, displayName: value } });\n';
  const controls = [
    { name: 'omit-native-effect', body: '', expected: /independent native write effect missing/ },
    {
      name: 'corrupt-native-effect',
      body: `${invocation}      await admin.query(\`UPDATE "\${accounts}" SET display_name=$1 WHERE id=9\`, ['corrupted-native-effect']);\n`,
      expected: /independent native effect must match actual bound value/,
    },
  ];
  for (const control of controls) {
    const dir = join(output, control.name);
    mkdirSync(dir);
    for (const name of ['native-contract.mjs', 'native-consumer.mjs', 'native-bridge.mjs', 'native-lifecycle.mjs'])
      cpSync(fileURLToPath(new URL(name, import.meta.url)), join(dir, name));
    writeFileSync(join(dir, 'native-contract.mjs'), original.slice(0, start) + control.body + original.slice(end));
    control.path = join(dir, 'native-consumer.mjs');
  }
  return controls;
}
