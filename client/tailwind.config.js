/** @type {import('tailwindcss').Config} */
/**
 * TableSaaS design tokens.
 * - Neutrals: warm "stone" scale (Tailwind) for the product UI; tenant storefronts use the store-* variables.
 * - Brand colours are CSS variables set per tenant at runtime (applyTheme), so every restaurant shares one layout.
 * - Accents (product UI): a controlled palette of soft tints, defined once in components/ui.tsx (ACCENTS):
 *   brand (tenant colour), blue = information / primary data, emerald = success, amber = pending / warning,
 *   rose = errors / critical, violet = AI & intelligence. Cards stay white; colour appears as small tinted icon
 *   tiles, a thin top rule, badges and chart series, never as saturated card fills.
 * - Motion: short, eased, transform/opacity only; globally disabled by prefers-reduced-motion (index.css).
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
          ink: 'rgb(var(--brand-ink) / <alpha-value>)',
          soft: 'rgb(var(--brand) / 0.08)',
        },
        accent: 'rgb(var(--accent) / <alpha-value>)',
        store: {
          bg: 'rgb(var(--store-bg) / <alpha-value>)',
          surface: 'rgb(var(--store-surface) / <alpha-value>)',
          text: 'rgb(var(--store-text) / <alpha-value>)',
          secondary: 'rgb(var(--store-secondary) / <alpha-value>)',
          'secondary-ink': 'rgb(var(--store-secondary-ink) / <alpha-value>)',
        },
        ink: {
          950: '#0E0C0B',
          900: '#171412',
          800: '#221E1B',
          700: '#2E2925',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'Fraunces', 'Georgia', 'serif'],
        sans: ['var(--font-body)', 'Inter', 'system-ui', 'sans-serif'],
        urdu: ['"Noto Nastaliq Urdu"', 'serif'],
        arabic: ['"Noto Naskh Arabic"', 'serif'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        // Typography scale for the product UI (page title > section > card title > body; metrics stand out).
        'page-title': ['2rem', { lineHeight: '2.375rem', letterSpacing: '-0.02em' }],
        'section-title': ['1.125rem', { lineHeight: '1.625rem', letterSpacing: '-0.01em' }],
        'card-title': ['0.9375rem', { lineHeight: '1.375rem' }],
        metric: ['2rem', { lineHeight: '2.25rem', letterSpacing: '-0.02em' }],
      },
      spacing: {
        // Spacing tokens: card padding, gaps between cards, gaps between page sections.
        'card-pad': '1.5rem',
        'grid-gap': '1.25rem',
        section: '2rem',
      },
      letterSpacing: {
        eyebrow: '0.16em',
      },
      borderRadius: {
        brand: 'var(--radius)',
        'brand-sm': 'calc(var(--radius) * 0.7)',
        'brand-lg': 'calc(var(--radius) * 1.4)',
      },
      boxShadow: {
        card: '0 1px 2px rgb(28 25 23 / 0.04), 0 1px 1px rgb(28 25 23 / 0.02)',
        soft: '0 1px 2px rgb(28 25 23 / 0.04), 0 4px 12px -2px rgb(28 25 23 / 0.06)',
        lift: '0 2px 4px rgb(28 25 23 / 0.04), 0 16px 40px -12px rgb(28 25 23 / 0.22)',
        float: '0 24px 64px -16px rgb(28 25 23 / 0.35)',
        ring: '0 0 0 1px rgb(28 25 23 / 0.06)',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(.2,.8,.2,1)',
        spring: 'cubic-bezier(.34,1.56,.64,1)',
      },
      keyframes: {
        'fade-up': { from: { opacity: 0, transform: 'translateY(8px)' }, to: { opacity: 1, transform: 'none' } },
        'fade-in': { from: { opacity: 0 }, to: { opacity: 1 } },
        'scale-in': { from: { opacity: 0, transform: 'translateY(8px) scale(.98)' }, to: { opacity: 1, transform: 'none' } },
        'sheet-up': { from: { transform: 'translateY(100%)' }, to: { transform: 'none' } },
        'slide-in': { from: { transform: 'translateX(100%)' }, to: { transform: 'none' } },
        pop: { '0%': { transform: 'scale(1)' }, '40%': { transform: 'scale(1.14)' }, '100%': { transform: 'scale(1)' } },
        shimmer: { from: { backgroundPosition: '-400px 0' }, to: { backgroundPosition: '400px 0' } },
        pulse2: { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.45 } },
        'ken-burns': { from: { transform: 'scale(1.06)' }, to: { transform: 'scale(1)' } },
      },
      animation: {
        'fade-up': 'fade-up 320ms cubic-bezier(.2,.8,.2,1) both',
        'fade-in': 'fade-in 200ms ease-out both',
        'scale-in': 'scale-in 260ms cubic-bezier(.2,.8,.2,1) both',
        'sheet-up': 'sheet-up 340ms cubic-bezier(.2,.8,.2,1) both',
        'slide-in': 'slide-in 300ms cubic-bezier(.2,.8,.2,1) both',
        pop: 'pop 360ms cubic-bezier(.34,1.56,.64,1)',
        shimmer: 'shimmer 1.3s linear infinite',
        pulse2: 'pulse2 1.6s ease-in-out infinite',
        'ken-burns': 'ken-burns 1400ms cubic-bezier(.2,.8,.2,1) both',
      },
    },
  },
  plugins: [],
};
