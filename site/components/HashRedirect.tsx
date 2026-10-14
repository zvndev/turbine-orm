'use client';

import { useEffect } from 'react';

/**
 * Forwards an old deep link (`/page#old-section`) to the section's new home.
 * A URL fragment never reaches the server, so this has to run in the browser.
 */
export function HashRedirect({ moved }: { moved: Readonly<Record<string, string>> }) {
  useEffect(() => {
    const forward = () => {
      const to = moved[decodeURIComponent(window.location.hash.slice(1))];
      if (to) window.location.replace(to);
    };
    forward();
    window.addEventListener('hashchange', forward);
    return () => window.removeEventListener('hashchange', forward);
  }, [moved]);
  return null;
}
