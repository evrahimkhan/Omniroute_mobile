/**
 * OmniRoute Mobile theme.
 *
 * Colors mirror the OmniRoute web dashboard (manifest background #0b0f1a,
 * orange/red accent) so the native shell feels like part of the product.
 */
export const theme = {
  bg: '#0b0f1a',
  bgElevated: '#111827',
  surface: '#151d2e',
  surfaceAlt: '#1a2438',
  border: '#223049',
  text: '#e6ebf4',
  textMuted: '#8b98b0',
  accent: '#ff5a3c',
  accentSoft: 'rgba(255, 90, 60, 0.14)',
  success: '#34d399',
  danger: '#f87171',
  tabBarBg: '#0d1322',
} as const;

export type Theme = typeof theme;
