import { ENGINE_SUPPORT_AS_OF, ENGINE_SUPPORT_ROWS } from '../lib/engine-support.generated';

/**
 * Support tier per engine and transport. The rows are generated from
 * docs/engine-support.json by scripts/gen-engine-support.ts, which computes each
 * tier from the route's evidence, so the page cannot claim more than the tests do.
 */
export function EngineSupportTable() {
  return (
    <table>
      <thead>
        <tr>
          <th>Route</th>
          <th>Import</th>
          <th>Tier</th>
          <th>Tested in CI on</th>
        </tr>
      </thead>
      <tbody>
        {ENGINE_SUPPORT_ROWS.map((row) => (
          <tr key={row.id}>
            <td>{row.label}</td>
            <td>
              {row.imports.map((name) => (
                <code key={name}>{name} </code>
              ))}
            </td>
            <td>
              <strong>{row.tier}</strong>
              {row.tier !== row.earned && row.earned !== 'n/a' ? ` (evidence earns ${row.earned})` : ''}
            </td>
            <td>{row.ci.length ? row.ci.join('; ') : 'nothing'}</td>
          </tr>
        ))}
      </tbody>
      <caption>As of {ENGINE_SUPPORT_AS_OF}</caption>
    </table>
  );
}
