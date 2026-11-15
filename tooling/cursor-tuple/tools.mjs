import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** Actual CLI and stdio MCP dispatch from a concretely staged package. */
export async function tupleTools(packageDir, url) {
  const root = mkdtempSync('/tmp/tuple-cursor-tools-');
  const cli = join(packageDir, 'dist/cli/index.js');
  const commands = [], pids = [];
  const report = { packageDir, root, pids, commands, checks: [], status: 'running' };
  const page = { cursor: { sortKey: 10, id: 20 }, orderBy: { sortKey: 'asc' }, limit: 7 };
  const input = args => ({ table: 'items', args });
  async function run(args, writes) {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: ['pipe', 'pipe', 'pipe'] });
    pids.push(child.pid);
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (exit, signal) => resolve({ exit, signal })); });
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
    try {
      if (writes) await Promise.race([writes(child), closed.then(() => { throw Error('MCP closed before all replies'); })]);
      child.stdin.end();
      const result = await closed;
      commands.push({ args, pid: child.pid, ...result, stdout, stderr });
      assert.equal(result.exit, 0, stdout + stderr);
      return writes ? stdout : JSON.parse(stdout);
    } catch (error) {
      child.kill('SIGTERM');
      await closed;
      if (!commands.some(c => c.pid === child.pid)) commands.push({ args, pid: child.pid, failed: true, stdout, stderr });
      throw error;
    } finally { clearTimeout(timer); }
  }
  try {
    const compile = (args, extra = []) => run(['compile', JSON.stringify(input(args)), '--url', url, ...extra]);
    const plain = await compile(page);
    const lex = await compile({ ...page, cursorPredicate: 'lexicographic' });
    const tuple = await compile({ ...page, cursorPredicate: 'tuple' });
    assert.equal(plain.ok, true); assert.equal(plain.executed, false);
    assert.equal(tuple.ok, true); assert.equal(tuple.executed, false);
    assert.equal(lex.sql, plain.sql); assert.deepEqual(lex.params, plain.params);
    assert.match(tuple.sql, /\("items"\."sort_key", "items"\."id"\) > \(\$1, \$2\)/);
    assert.notEqual(tuple.sql, plain.sql); assert.deepEqual(tuple.params, plain.params);
    report.checks.push('CLI default/lexicographic byte identity and explicit tuple compilation');
    const missing = await compile({ ...page, cursorPredicate: 'tuple', cursor: { id: 20 } });
    assert.equal(missing.ok, false); assert.equal(missing.error.code, 'TURBINE_E003');
    const nested = await compile({ with: { children: { cursorPredicate: 'tuple', cursor: { id: 1 } } } });
    assert.equal(nested.ok, false); assert.equal(nested.error.code, 'TURBINE_E017');
    report.checks.push('CLI incomplete/nested tuple refusals');
    let replies;
    await run(['mcp', '--url', url], async child => {
      const lines = createInterface({ input: child.stdout });
      const pending = new Map();
      lines.on('line', line => { try { const reply = JSON.parse(line); pending.get(reply.id)?.resolve(reply); } catch (error) { for (const p of pending.values()) p.reject(error); } });
      const call = (id, args) => new Promise((resolve, reject) => {
        pending.set(id, {resolve, reject});
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'compile_query', arguments: input(args) } }) + '\n');
      });
      const read = reply => { assert.equal(reply.error, undefined); return JSON.parse(reply.result.content[0].text); };
      replies = [read(await call(1, page)), read(await call(2, { ...page, cursorPredicate: 'tuple' })), read(await call(3, { ...page, cursorPredicate: 'tuple', cursor: { id: 20 } }))];
      assert.equal(replies[0].sql, plain.sql); assert.equal(replies[1].sql, tuple.sql);
      assert.deepEqual(replies[1].params, tuple.params); assert.equal(replies[1].executed, false);
      assert.equal(replies[2].ok, false); assert.equal(replies[2].error.code, 'TURBINE_E003');
      lines.close();
    });
    report.checks.push('MCP actual stdio tuple compilation and refusal');
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.failure = { message: error.message, stack: error.stack }; }
  finally {
    try { rmSync(root, { recursive: true, force: true }); } catch (error) { report.status = 'failed'; report.cleanupError = error.message; }
    report.cleanup = { rootAbsent: !existsSync(root), pidsAbsent: pids.every(pid => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } }) };
    if (!report.cleanup.pidsAbsent || !report.cleanup.rootAbsent) report.status = 'failed';
  }
  return report;
}
