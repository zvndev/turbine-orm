import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        zinc: {
          950: '#09090b',
        },
      },
      fontFamily: {
        mono: [
          'Geist Mono',
          'SF Mono',
          'Fira Code',
          'Fira Mono',
          'Roboto Mono',
          'Menlo',
          'Courier New',
          'monospace',
        ],
        sans: [
          'Geist',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      maxWidth: {
        content: '52rem',
      },
    },
  },
  plugins: [],
};

export default config;
