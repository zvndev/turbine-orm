'use client';

import { type KeyboardEvent, useId, useRef, useState } from 'react';

export interface CodeTab {
  label: string;
  file: string;
  caption: string;
  /** Highlighted HTML, rendered on the server by shiki. */
  html: string;
}

/**
 * A code window with one tab per example. Every panel is in the server
 * HTML; without JavaScript the first one shows and the rest stay hidden.
 */
export function CodeTabs({ tabs }: { tabs: CodeTab[] }) {
  const [active, setActive] = useState(0);
  const id = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const select = (i: number) => {
    const next = (i + tabs.length) % tabs.length;
    setActive(next);
    tabRefs.current[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight') select(active + 1);
    else if (e.key === 'ArrowLeft') select(active - 1);
    else if (e.key === 'Home') select(0);
    else if (e.key === 'End') select(tabs.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <div className="showcase">
      <div className="showcase-bar">
        <div className="showcase-tabs" role="tablist" aria-label="Turbine examples" onKeyDown={onKeyDown}>
          {tabs.map((t, i) => (
            <button
              key={t.label}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${i}`}
              aria-selected={i === active}
              aria-controls={`${id}-panel-${i}`}
              tabIndex={i === active ? 0 : -1}
              className="showcase-tab"
              onClick={() => setActive(i)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="showcase-file">{tabs[active]?.file}</span>
      </div>
      {tabs.map((t, i) => (
        <div
          key={t.label}
          role="tabpanel"
          id={`${id}-panel-${i}`}
          aria-labelledby={`${id}-tab-${i}`}
          hidden={i !== active}
          className="showcase-panel"
        >
          <div className="panel-code" dangerouslySetInnerHTML={{ __html: t.html }} />
          <p className="showcase-caption">{t.caption}</p>
        </div>
      ))}
    </div>
  );
}
