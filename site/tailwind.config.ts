import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{ts,tsx,js,jsx,md,mdx}',
    './components/**/*.{ts,tsx,js,jsx,md,mdx}',
    './mdx-components.tsx',
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          0: '#09090B',
          1: '#0C0C0E',
          2: '#111114',
          3: '#141417',
          4: '#1A1A1F',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      maxWidth: {
        content: '820px',
        landing: '1200px',
      },
    },
  },
  plugins: [],
};

export default config;
