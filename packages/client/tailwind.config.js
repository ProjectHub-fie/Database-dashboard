/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Design tokens shared with the backend-provided theme palette.
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
