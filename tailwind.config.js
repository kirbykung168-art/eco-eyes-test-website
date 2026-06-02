/** @type {import('tailwindcss').Config} */
// Eco Eyes Village — Tailwind config
//
// Self-hosted Tailwind build replaces the previous CDN script
// (cdn.tailwindcss.com) which compiled in-browser and printed a
// production warning. To rebuild after editing HTML classes:
//
//   npm run build:css
//
// The output file `tailwind.css` is committed to git and served
// statically by express.static() in server.js.

export default {
  // Scan every HTML page (root level) for class usage so the purge
  // keeps only classes we actually use.
  content: ['./*.html'],

  theme: {
    extend: {
      // Brand palette — superset of every inline tailwind.config across pages.
      colors: {
        cream:       '#FAF7EF',
        'cream-mid': '#F0E9D8',
        'cream-dk':  '#E3D8C2',
        gold:        '#967138',
        'gold-lt':   '#C4A36A',
        'gold-pale': '#E8D9BE',
        'gold-dk':   '#6B4F22',
        dark:        '#1C1915',
        'dark-mid':  '#2A251E',
        forest:      '#2B3A20',
        'forest-lt': '#3D5230',
        moss:        '#5C6B47',
      },
      fontFamily: {
        display: ['"Cormorant Garamond"', 'serif'],
        sans:    ['Jost', 'sans-serif'],
      },
      letterSpacing: {
        widest:   '0.25em',
        widester: '0.4em',
      },
    },
  },

  plugins: [],
}
