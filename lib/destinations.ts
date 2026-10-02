/**
 * What the native app can do, as a list.
 *
 * This replaces `lib/features.ts`, which mirrored the dashboard's 94-item
 * navigation and opened every entry in a WebView. A catalog is only worth having
 * if it is true: every entry here is a screen that exists in the app right now,
 * and nothing here is a link to a browser view.
 *
 * Surfaces that are dashboard-only today are not listed. They are tracked in
 * docs/NATIVE_UI.md, which also records what each one would take to bring across
 * — a native screen that quietly opens a web page is worse than one that is
 * honestly absent, because it hides where the app's real coverage ends.
 */

import type { MaterialCommunityIcons } from '@expo/vector-icons';

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

export interface Destination {
  id: string;
  title: string;
  subtitle: string;
  icon: IconName;
  /** An expo-router path inside the app. */
  route: string;
}

export interface DestinationSection {
  id: string;
  title: string;
  items: Destination[];
}

export const NATIVE_DESTINATIONS: DestinationSection[] = [
  {
    id: 'gateway',
    title: 'GATEWAY',
    items: [
      {
        id: 'home',
        title: 'Overview',
        subtitle: 'Health, uptime, memory, traffic and recent requests',
        icon: 'view-dashboard-outline',
        route: '/(tabs)',
      },
      {
        id: 'keys',
        title: 'API keys',
        subtitle: 'Create, copy and revoke the keys your clients use',
        icon: 'key-variant',
        route: '/keys',
      },
      {
        id: 'providers',
        title: 'Providers',
        subtitle: 'Which connections exist, and switching them on or off',
        icon: 'lan-connect',
        route: '/(tabs)/providers',
      },
      {
        id: 'models',
        title: 'Models',
        subtitle: 'The whole catalog, searchable, with what you can call',
        icon: 'format-list-bulleted',
        route: '/(tabs)/models',
      },
      {
        id: 'combos',
        title: 'Combos',
        subtitle: 'Failover groups and what is in them',
        icon: 'layers-triple',
        route: '/combos',
      },
      {
        id: 'logs',
        title: 'Request log',
        subtitle: 'Every call: model, latency, tokens and cost',
        icon: 'text-box-search-outline',
        route: '/logs',
      },
    ],
  },
  {
    id: 'use',
    title: 'USE IT',
    items: [
      {
        id: 'playground',
        title: 'Playground',
        subtitle: 'Chat with any connected model, streamed',
        icon: 'chat-processing-outline',
        route: '/(tabs)/chat',
      },
    ],
  },
  {
    id: 'this-phone',
    title: 'THIS PHONE',
    items: [
      {
        id: 'host',
        title: 'Host the gateway here',
        subtitle: 'Install the payload, start it, keep it running',
        icon: 'cellphone-cog',
        route: '/settings',
      },
      {
        id: 'settings',
        title: 'Settings',
        subtitle: 'Gateway address, session, and app information',
        icon: 'tune',
        route: '/settings',
      },
      {
        id: 'sign-in',
        title: 'Dashboard session',
        subtitle: 'Sign in when the gateway is protected by a password',
        icon: 'login',
        route: '/sign-in',
      },
    ],
  },
];

export const APP_LINKS = {
  upstream: 'https://github.com/diegosouzapw/OmniRoute',
  builds: 'https://github.com/evrahimkhan/Omniroute_mobile/actions',
  docs: 'https://github.com/evrahimkhan/Omniroute_mobile/blob/arena/01a0e9f8-omniroute-mobile/docs/NATIVE_UI.md',
};
