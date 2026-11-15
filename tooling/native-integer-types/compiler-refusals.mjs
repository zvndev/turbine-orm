import assert from 'node:assert/strict';

/** Require the intended diagnostic on each exact negative statement's line. */
export function compilerDiagnostics(output, source, statements, codes) {
  assert.ok(statements.length, 'Type-negative controls must be nonempty');
  assert.equal(codes.length, statements.length, 'Every negative statement needs an explicit diagnostic');
  for (const [index, statement] of statements.entries()) {
    assert.ok(source.includes(statement), 'Missing type-negative statement');
    const line = source.slice(0, source.indexOf(statement)).split('\n').length;
    assert.ok(Number.isInteger(codes[index]), 'Diagnostic code must be an integer');
    assert.ok(
      new RegExp(`invalid\\.ts\\(${line},\\d+\\): error TS${codes[index]}\\b`).test(output),
      `Missing compiler refusal TS${codes[index]} at line ${line}: ${statement}\n${output}`,
    );
  }
}
