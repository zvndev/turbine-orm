export default {
  plugins: {
    // Tailwind v4 ships its PostCSS integration as a separate package and
    // handles @import inlining + vendor prefixing itself (autoprefixer no
    // longer needed).
    '@tailwindcss/postcss': {},
  },
};
