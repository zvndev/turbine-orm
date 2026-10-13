/**
 * The shape of the CI and release workflows, checked in the unit lane.
 *
 * Each assertion here is a property that fails SILENTLY on GitHub when it is
 * lost, because a workflow that stops checking something still goes green:
 *
 *   - ci.yml and release.yml both call gates.yml, so the release gate is CI's
 *     gate and cannot drift from it.
 *   - release.yml's publish needs every other job in the file, including the
 *     ancestry guard, and runs no build of its own.
 *   - The tarball is packed once. Every job that installs it downloads the
 *     `pack` job's artifact, and publish stages that same file, compares its
 *     hashes, and uploads it with lifecycle scripts off.
 *   - The unit matrix covers the `engines.node` floor and the @types/node major.
 *   - The package-types job runs the same publint/attw flags as package.json.
 *   - Every third-party action is pinned to a full commit SHA.
 *
 * A line parser, like src/test/ci-ok-needs-sync.test.ts: no YAML dependency,
 * and every extraction asserts it found something, so a layout change fails
 * here instead of passing over an empty block.
 *
 * Run: npx tsx --test src/test/ci-release-workflows.test.ts
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const WF = new URL('../../.github/workflows/', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, WF), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  engines: { node: string };
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};

/** Top-level jobs: name to the lines of its block. */
function jobs(text: string): Map<string, string[]> {
  const lines = text.split('\n');
  const at = lines.indexOf('jobs:');
  assert.notEqual(at, -1, 'no top-level `jobs:`');
  const out = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines.slice(at + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m?.[1]) {
      current = [];
      out.set(m[1], current);
    } else if (current && !/^ {2}#/.test(line)) {
      current.push(line);
    }
  }
  assert.ok(out.size > 0, 'parsed no jobs');
  return out;
}

function job(map: Map<string, string[]>, name: string): string[] {
  const block = map.get(name);
  assert.ok(block, `no job \`${name}\``);
  return block;
}

/** A job's `needs:` in inline or list form. */
function needs(block: string[]): string[] {
  const i = block.findIndex((l) => /^ {4}needs:/.test(l));
  if (i === -1) return [];
  const inline = /^ {4}needs:\s*\[(.*)\]\s*$/.exec(block[i] as string);
  if (inline) {
    return (inline[1] as string)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const single = /^ {4}needs:\s*([A-Za-z0-9_-]+)\s*$/.exec(block[i] as string);
  if (single?.[1]) return [single[1]];
  const out: string[] = [];
  for (const l of block.slice(i + 1)) {
    const m = /^ {6}- ([A-Za-z0-9_-]+)\s*$/.exec(l);
    if (!m?.[1]) break;
    out.push(m[1]);
  }
  return out;
}

/** The steps of a job, each as its lines, keyed by `name:` or `uses:`. */
function steps(block: string[]): { label: string; text: string }[] {
  const out: { label: string; lines: string[] }[] = [];
  for (const l of block) {
    if (/^ {6}- /.test(l)) out.push({ label: '', lines: [l] });
    else if (/^ {8}\S/.test(l) || /^ {10}/.test(l) || l.trim() === '') out.at(-1)?.lines.push(l);
  }
  return out.map((s) => {
    const text = s.lines.join('\n');
    const label = /name: (.+)/.exec(text)?.[1] ?? /uses: (\S+)/.exec(text)?.[1] ?? /run: (.+)/.exec(text)?.[1] ?? '';
    return { label: label.trim(), text };
  });
}

function step(block: string[], name: string): string {
  const s = steps(block).find((x) => x.label === name);
  assert.ok(s, `no step named "${name}"`);
  return s.text;
}

const ci = jobs(read('ci.yml'));
const release = jobs(read('release.yml'));
const gatesText = read('gates.yml');
const gates = jobs(gatesText);

describe('ci.yml and release.yml share one gate workflow', () => {
  it('gates.yml is a callable workflow', () => {
    assert.match(gatesText, /^on:\n {2}workflow_call:/m);
  });

  for (const [file, map] of [
    ['ci.yml', ci],
    ['release.yml', release],
  ] as const) {
    it(`${file} calls gates.yml from a job named \`gates\``, () => {
      const block = job(map, 'gates');
      assert.ok(
        block.some((l) => /^ {4}uses: \.\/\.github\/workflows\/gates\.yml\s*$/.test(l)),
        `${file}: job \`gates\` does not call gates.yml`,
      );
    });
  }

  it('ci.yml defines no gate job outside gates.yml', () => {
    assert.deepEqual([...ci.keys()].sort(), ['ci-ok', 'gates']);
  });

  it('release.yml has only the ancestry guard, the gates call and publish', () => {
    assert.deepEqual([...release.keys()].sort(), ['gates', 'publish', 'tag-ancestry']);
  });

  it('publish needs every other release.yml job', () => {
    const publishNeeds = needs(job(release, 'publish'));
    const others = [...release.keys()].filter((j) => j !== 'publish');
    assert.deepEqual([...publishNeeds].sort(), others.sort());
  });

  it('the gates run only after the ancestry guard', () => {
    assert.deepEqual(needs(job(release, 'gates')), ['tag-ancestry']);
  });
});

describe('release publishes the tarball the gates tested', () => {
  const publish = job(release, 'publish');
  const text = publish.join('\n');

  it('publish never builds or packs from the checkout', () => {
    assert.doesNotMatch(text, /npm run build/);
    assert.doesNotMatch(text, /run: npm pack\s*$/m);
  });

  it('lifecycle scripts are off for the whole publish job', () => {
    assert.ok(
      publish.some((l) => /^ {6}npm_config_ignore_scripts: 'true'\s*$/.test(l)),
      'publish job has no `npm_config_ignore_scripts: true` env',
    );
  });

  it('publish downloads the package-tarball artifact', () => {
    assert.match(text, /uses: actions\/download-artifact@[0-9a-f]{40}[\s\S]*?name: package-tarball/);
  });

  it('the staging step checks sha256, version and repack integrity against the gates outputs', () => {
    const stage = step(publish, 'Verify and stage the tested tarball');
    assert.match(stage, /needs\.gates\.outputs\.tarball-sha256/);
    assert.match(stage, /needs\.gates\.outputs\.tarball-integrity/);
    assert.match(stage, /sha256sum "\$TARBALL"/);
    assert.match(stage, /npm pack --dry-run --json/);
    assert.match(stage, /"\$REPACKED" != "\$TESTED_INTEGRITY"/);
    assert.match(stage, /"\$TAR_VERSION" != "\$PKG_VERSION"/);
  });

  it('npm publish runs in the staged package directory', () => {
    const pub = step(publish, 'Publish to npm');
    assert.match(pub, /working-directory: \$\{\{ runner\.temp \}\}\/release-package\/package/);
    assert.match(pub, /^ {10}npm publish --provenance --access public /m);
  });

  it('publish runs in the protected release environment', () => {
    assert.ok(
      publish.some((l) => /^ {4}environment: release\s*$/.test(l)),
      'publish job is not in the `release` environment',
    );
  });

  // npm tries trusted publishing (OIDC) before any token, but only from npm
  // 11.5.1, and only when no setup-node .npmrc makes every npm command need
  // NODE_AUTH_TOKEN. The npm that stages must be the npm that publishes.
  it('publish uses an OIDC-capable npm, installed before the staging step', () => {
    const names = steps(publish).map((s) => s.label);
    const npmStep = names.indexOf('Use npm 11.20.0');
    assert.ok(npmStep >= 0, 'no `Use npm 11.20.0` step');
    assert.ok(npmStep < names.indexOf('Verify and stage the tested tarball'), 'npm is upgraded after staging');
    assert.match(step(publish, 'Use npm 11.20.0'), /npm install -g npm@11\.20\.0/);
    assert.doesNotMatch(publish.join('\n'), /^ +registry-url:/m);
  });

  it('the token is a fallback that never reaches disk', () => {
    const pub = step(publish, 'Publish to npm');
    assert.match(pub, /if \[ -n "\$\{NPM_TOKEN:-\}" \]; then/);
    assert.match(pub, /printf '\/\/registry\.npmjs\.org\/:_authToken=\$\{NPM_TOKEN\}\\n'/);
    assert.doesNotMatch(publish.join('\n'), /NODE_AUTH_TOKEN: \$\{\{/);
  });

  it('the registry copy is checked against the tested integrity', () => {
    const verify = step(publish, 'Verify the registry holds the tested tarball');
    assert.match(verify, /dist\.integrity/);
    assert.match(verify, /"\$STORED" != "\$TESTED_INTEGRITY"/);
  });

  it('the ancestry guard checks the run commit against a full clone of main', () => {
    const anc = job(release, 'tag-ancestry').join('\n');
    assert.match(anc, /fetch-depth: 0/);
    assert.match(anc, /refs\/heads\/main:refs\/remotes\/origin\/main/);
    assert.match(anc, /node scripts\/check-tag-ancestry\.mjs "\$GITHUB_SHA" origin\/main\s*\n/);
  });
});

describe('gates.yml packs once', () => {
  const pack = job(gates, 'pack');

  it('the pack job uploads package-tarball and exposes its hashes', () => {
    const t = pack.join('\n');
    assert.match(t, /uses: actions\/upload-artifact@[0-9a-f]{40}[\s\S]*?name: package-tarball/);
    for (const out of ['tarball', 'sha256', 'integrity']) {
      assert.match(t, new RegExp(`^ {6}${out}: \\$\\{\\{ steps\\.pack\\.outputs\\.${out} \\}\\}`, 'm'));
    }
    for (const out of ['tarball', 'tarball-sha256', 'tarball-integrity']) {
      assert.match(
        gatesText,
        new RegExp(`^ {6}${out}:\\n(?: {8}.*\\n)*? {8}value: \\$\\{\\{ jobs\\.pack\\.outputs\\.`, 'm'),
      );
    }
  });

  it('no other job runs npm pack', () => {
    for (const [name, block] of gates) {
      if (name === 'pack') continue;
      const code = block.filter((l) => !/^\s*#/.test(l)).join('\n');
      assert.doesNotMatch(code, /npm pack(?! --dry-run)/, `job ${name} packs its own tarball`);
    }
  });

  it('every job that uses $TARBALL needs pack and downloads its artifact', () => {
    const users = [...gates].filter(
      ([n, b]) => n !== 'pack' && b.some((l) => !/^\s*#/.test(l) && l.includes('TARBALL')),
    );
    assert.ok(users.length >= 5, `only ${users.length} tarball consumers found`);
    for (const [name, block] of users) {
      assert.ok(needs(block).includes('pack'), `${name} uses the tarball but does not need pack`);
      assert.match(block.join('\n'), /name: package-tarball/, `${name} does not download package-tarball`);
    }
  });
});

describe('Node versions', () => {
  const unit = job(gates, 'unit-tests').join('\n');
  const matrix = /node-version: \[([^\]]+)\]/.exec(unit)?.[1];
  const versions = (matrix ?? '').split(',').map((v) => Number(v.trim()));

  it('the unit matrix covers the engines.node floor', () => {
    assert.ok(matrix, 'unit-tests has no node-version matrix');
    const floor = Number(/^>=\s*(\d+)/.exec(pkg.engines.node)?.[1]);
    assert.ok(Number.isInteger(floor), `cannot read a floor from engines.node ${pkg.engines.node}`);
    assert.ok(versions.includes(floor), `engines.node floor ${floor} is not in the unit matrix [${versions}]`);
    assert.ok(
      versions.every((v) => v >= floor),
      `the unit matrix tests a Node below engines.node: [${versions}]`,
    );
  });

  it('the unit matrix covers the @types/node major', () => {
    const major = Number(/(\d+)/.exec(pkg.devDependencies['@types/node'] ?? '')?.[1]);
    assert.ok(Number.isInteger(major), '@types/node has no readable major');
    assert.ok(
      versions.includes(major),
      `@types/node ^${major} describes a Node the unit matrix [${versions}] never runs`,
    );
  });
});

describe('package-types runs the flags package.json runs', () => {
  it('publint and attw flags match check:package', () => {
    const script = pkg.scripts['check:package'] ?? '';
    const publint = /publint (.+?)(?:&&|$)/.exec(script)?.[1]?.trim();
    const attw = /attw --pack \. (.+?)(?:&&|$)/.exec(script)?.[1]?.trim();
    assert.ok(publint && attw, `cannot read flags from check:package: ${script}`);
    const run = step(job(gates, 'package-types'), 'publint + are-the-types-wrong');
    assert.match(run, new RegExp(`npx publint ${publint} "\\$TARBALL"`));
    assert.match(run, new RegExp(`npx attw "\\$TARBALL" ${attw}`));
  });
});

describe('third-party actions are pinned', () => {
  it('every `uses:` is a local workflow or a 40-hex commit SHA', () => {
    let seen = 0;
    for (const file of readdirSync(WF).filter((f) => f.endsWith('.yml'))) {
      for (const [i, line] of read(file).split('\n').entries()) {
        const m = /^\s*(?:- )?uses:\s*(\S+)/.exec(line);
        if (!m?.[1]) continue;
        seen++;
        const ref = m[1];
        assert.ok(
          ref.startsWith('./') || /@[0-9a-f]{40}$/.test(ref),
          `${file}:${i + 1} uses an unpinned action ${ref}`,
        );
      }
    }
    assert.ok(seen > 20, `only ${seen} uses: lines found`);
  });
});
