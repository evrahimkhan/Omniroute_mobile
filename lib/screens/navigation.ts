/**
 * How a surface is opened, wherever it is tapped from.
 *
 * A bespoke screen goes to its own route; everything else goes to `/surface/<id>`,
 * which looks the surface up in the catalog and picks a renderer. Kept in one
 * place so the menu, a section list and a deep link cannot disagree.
 */

import type { useRouter } from 'expo-router';

import type { Surface } from './catalog';

type Router = ReturnType<typeof useRouter>;

export function openSurface(router: Router, surface: Surface): void {
  if (surface.kind === 'custom' && surface.route) router.push(surface.route as never);
  else router.push(`/surface/${surface.id}` as never);
}

/** The everyday screens, offered on the menu before the long tail. */
export const QUICK_SURFACE_IDS = ['playground', 'model-catalog', 'api-manager', 'logs', 'combos', 'settings-general'];
