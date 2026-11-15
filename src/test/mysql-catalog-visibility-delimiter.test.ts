import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertMysqlCatalogVisibility } from '../cli/mysql-schema-snapshot.js';

describe('MySQL catalog grant scope delimiters', () => {
  for (const [database, scope] of [
    ['app TO other', '`app TO other`.*'],
    ['app` TO other', '`app`` TO other`.*'],
    ['app" TO other', '"app"" TO other".*'],
  ] as const) {
    it(`accepts complete quoted scope ${scope}`, () => {
      assert.doesNotThrow(() =>
        assertMysqlCatalogVisibility(
          ['GRANT SELECT ON *.* TO account', `GRANT SHOW VIEW, TRIGGER ON ${scope} TO account`],
          database,
        ),
      );
      for (const wrongScope of [scope.replace(/\.\*$/, '.table'), '`different`.*']) {
        assert.throws(
          () =>
            assertMysqlCatalogVisibility([`GRANT SELECT, SHOW VIEW, TRIGGER ON ${wrongScope} TO account`], database),
          /visibility grants/,
        );
      }
      assert.throws(
        () =>
          assertMysqlCatalogVisibility(
            ['GRANT ALL PRIVILEGES ON *.* TO account', `REVOKE SELECT ON ${scope} FROM account`],
            database,
          ),
        /partial revokes/,
      );
    });
  }
});
