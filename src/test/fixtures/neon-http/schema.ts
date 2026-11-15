import type { SchemaMetadata } from '../../../schema.js';
import { mockTable } from '../../helpers.js';

export function neonHttpSchema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      accounts: mockTable(
        'accounts',
        [
          { name: 'id', field: 'id', pgType: 'int4' },
          { name: 'tenant_id', field: 'tenantId', pgType: 'int4' },
          { name: 'display_name', field: 'displayName', pgType: 'text' },
        ],
        {
          posts: {
            type: 'hasMany',
            name: 'posts',
            from: 'accounts',
            to: 'posts',
            foreignKey: 'account_id',
            referenceKey: 'id',
          },
        },
      ),
      posts: mockTable('posts', [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'account_id', field: 'accountId', pgType: 'int4' },
        { name: 'tenant_id', field: 'tenantId', pgType: 'int4' },
        { name: 'title', field: 'title', pgType: 'text' },
      ]),
    },
  };
}
