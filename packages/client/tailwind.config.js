/** @type {import('tailwindcss').Config} */

// Neutral monochrome ramp. The product uses one near-black accent instead of a
// saturated brand hue, so `indigo-*` (the accent family used across the app)
// resolves to this ramp. `slate-*` is remapped to the same neutral family so
// surfaces stay neutral rather than blue-tinted.
const neutral = {
  50: '#fafafa',
  100: '#f4f4f5',
  200: '#e4e4e7',
  300: '#d4d4d8',
  400: '#a1a1aa',
  500: '#71717a',
  600: '#52525b',
  700: '#3f3f46',
  800: '#27272a',
  900: '#18181b',
  950: '#09090b',
}

const accent = {
  50: '#fafafa',
  100: '#f4f4f5',
  200: '#e4e4e7',
  300: '#a1a1aa',
  400: '#71717a',
  500: '#3f3f46',
  600: '#18181b',
  700: '#27272a',
  800: '#27272a',
  900: '#18181b',
  950: '#09090b',
}

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        slate: neutral,
        zinc: neutral,
        indigo: accent,
        brand: {
          50: 'var(--c-brand-50)',
          100: 'var(--c-brand-100)',
          200: 'var(--c-brand-200)',
          300: 'var(--c-brand-300)',
          400: 'var(--c-brand-400)',
          500: 'var(--c-brand-500)',
          600: 'var(--c-brand-600)',
          700: 'var(--c-brand-700)',
        },
        surface: {
          50: 'var(--c-surface-50)',
          100: 'var(--c-surface-100)',
          200: 'var(--c-surface-200)',
          300: 'var(--c-surface-300)',
          400: 'var(--c-surface-400)',
          500: 'var(--c-surface-500)',
          600: 'var(--c-surface-600)',
          700: 'var(--c-surface-700)',
          800: 'var(--c-surface-800)',
          900: 'var(--c-surface-900)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
}
