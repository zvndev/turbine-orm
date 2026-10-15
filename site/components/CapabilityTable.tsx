import type { ReactNode } from 'react';
import { CAPABILITY_ENGINES, CAPABILITY_ROWS } from '../lib/capabilities.generated';

/** Inline `code` spans in a description, the one markdown feature it uses. */
function withCode(text: string): ReactNode[] {
  return text.split('`').map((part, i) => (i % 2 === 1 ? <code key={part}>{part}</code> : part));
}

/** A string value may break only after a hyphen, never mid-word. */
function breakable(value: string): ReactNode[] {
  return value.split('-').flatMap((part, i, all) => (i < all.length - 1 ? [`${part}-`, <wbr key={part} />] : [part]));
}

function cell(value: boolean | number | string | null): ReactNode {
  if (value === true) return '✓';
  if (value === false) return <span className="cap-no">✗</span>;
  if (value === null) return 'none';
  if (value === Number.POSITIVE_INFINITY) return 'no limit';
  if (typeof value === 'number') return value.toLocaleString('en-US');
  return <code className="cap-value">{breakable(value)}</code>;
}

/**
 * Every `EngineCapabilities` key with each shipped engine's value. The data is
 * generated from the dialect objects by scripts/gen-capability-table.ts, so the
 * table cannot disagree with the code. The description sits under its key so
 * the five value columns fit the content width.
 */
export function CapabilityTable() {
  return (
    <table className="cap-table">
      <thead>
        <tr>
          <th>Key</th>
          {CAPABILITY_ENGINES.map((e) => (
            <th key={e.id}>{e.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {CAPABILITY_ROWS.map((row) => (
          <tr key={row.key}>
            <td>
              <code className="cap-key">{row.key}</code>
              <span className="cap-decides">{withCode(row.decides)}</span>
            </td>
            {CAPABILITY_ENGINES.map((e) => (
              <td key={e.id}>{cell(row.values[e.id])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
