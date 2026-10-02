/**
 * Links that leave the app.
 *
 * This file used to hold `NATIVE_DESTINATIONS`, a hand-written ten-item menu. The
 * menu is now generated from the gateway's own dashboard definition
 * (lib/screens/catalog.ts), because a hand-written list drifts and cannot answer
 * "does this cover everything?". What is left here is the three addresses the
 * About rows open — and each one is a deliberate tap, never a fallback for a
 * screen the app failed to build.
 */

export const APP_LINKS = {
  upstream: 'https://github.com/diegosouzapw/OmniRoute',
  builds: 'https://github.com/evrahimkhan/Omniroute_mobile/actions',
  docs: 'https://github.com/evrahimkhan/Omniroute_mobile/blob/arena/01a0e9f8-omniroute-mobile/docs/NATIVE_UI.md',
};
