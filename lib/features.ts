/**
 * Full OmniRoute feature catalog for the native shell.
 *
 * Mirrors the dashboard navigation defined in the OmniRoute source
 * (`src/shared/constants/sidebarVisibility/sections.ts`) with labels from
 * `src/i18n/messages/en.json`. Every feature of the gateway is reachable
 * from this app — each entry opens the corresponding route in the in-app
 * web view (or in the external browser when marked `external`).
 *
 * Keep this list in sync when updating the pinned OmniRoute ref.
 */

export interface FeatureItem {
  /** Stable id, used as list key. */
  id: string;
  /** Display label (English, as in the web dashboard). */
  label: string;
  /** Short subtitle, same as the web sidebar. */
  subtitle?: string;
  /**
   * Route on the gateway.
   * - `/...`        → opened in the in-app web view
   * - `https://...` → opened in the external browser
   */
  path: string;
  /** MaterialCommunityIcons icon name. */
  icon: string;
}

export interface FeatureGroup {
  title: string;
  items: FeatureItem[];
}

export interface FeatureSection {
  id: string;
  title: string;
  groups: FeatureGroup[];
}

const item = (
  id: string,
  label: string,
  path: string,
  icon: string,
  subtitle?: string,
): FeatureItem => ({ id, label, path, icon, subtitle });

export const FEATURE_SECTIONS: FeatureSection[] = [
  {
    id: 'omni-proxy',
    title: 'OmniProxy',
    groups: [
      {
        title: '',
        items: [
          item('endpoints', 'Endpoints', '/dashboard/endpoint', 'link', 'Your AI connection URLs'),
          item('api-manager', 'API Keys', '/dashboard/api-manager', 'key', 'Manage API keys and access'),
          item('providers', 'Providers', '/dashboard/providers', 'dns', '358 providers, one endpoint'),
          item('model-catalog', 'Model Catalog', '/dashboard/models', 'format-list-bulleted', 'Browse models across providers'),
          item('embedded-services', 'Embedded Services', '/dashboard/providers/services', 'server', 'Optional local services'),
          item('combos', 'Combos', '/dashboard/combos', 'layers-triple', 'Group providers for failover'),
          item('combos-live', 'Combo Studio', '/dashboard/combos/live', 'sitemap', 'Live routing cascade'),
          item('provider-quota', 'Provider Quota', '/dashboard/quota', 'tune'),
          item('quota-share', 'Quota Sharing', '/dashboard/costs/quota-share', 'pie-chart'),
        ],
      },
      {
        title: 'Compression Context',
        items: [
          item('context-settings', 'Compression Settings', '/dashboard/context/settings', 'cog', 'Global defaults'),
          item('context-combos', 'Engine Combos', '/dashboard/context/combos', 'layers-triple'),
          item('context-caveman', 'Caveman', '/dashboard/context/caveman', 'account-voice', 'Prompt compression'),
          item('context-rtk', 'RTK', '/dashboard/context/rtk', 'filter', 'Output filtering'),
          item('context-headroom', 'Headroom', '/dashboard/context/headroom', 'table', 'Tabular compaction'),
          item('context-session-dedup', 'Session Dedup', '/dashboard/context/session-dedup', 'merge', 'Cross-turn deduplication'),
          item('context-ccr', 'CCR', '/dashboard/context/ccr', 'magnify', 'Retrieve markers'),
          item('context-llmlingua', 'LLMLingua', '/dashboard/context/llmlingua', 'scissors', 'Semantic pruning'),
          item('context-lite', 'Lite', '/dashboard/context/lite', 'feather', 'Fast whitespace cleanup'),
          item('context-aggressive', 'Aggressive', '/dashboard/context/aggressive', 'flame', 'Summary + aging'),
          item('context-ultra', 'Ultra', '/dashboard/context/ultra', 'bolt', 'Heuristic pruning'),
          item('context-omniglyph', 'OmniGlyph', '/dashboard/context/omniglyph', 'image', 'Context-as-image'),
          item('compression-studio', 'Compression Studio', '/dashboard/compression/studio', 'chart-line', 'Live engine cascade'),
          item('compression-exclusions', 'Exclusions', '/dashboard/compression/exclusions', 'block', 'Per-model/endpoint bypass'),
        ],
      },
      {
        title: 'Tools',
        items: [
          item('cli-code', 'CLI Code', '/dashboard/cli-code', 'terminal'),
          item('cli-agents', 'CLI Agents', '/dashboard/cli-agents', 'robot'),
          item('acp-agents', 'ACP Agents', '/dashboard/acp-agents', 'robot-outline'),
          item('cloud-agents', 'Cloud Agents', '/dashboard/cloud-agents', 'cloud'),
          item('conductor', 'Conductor', '/dashboard/conductor', 'music', 'CLI-agent fleet'),
          item('orchestration', 'Orchestration', '/dashboard/orchestration', 'swap-horizontal'),
          item('agent-bridge', 'Agent Bridge', '/dashboard/tools/agent-bridge', 'bridge'),
          item('traffic-inspector', 'Traffic Inspector', '/dashboard/tools/traffic-inspector', 'swap-horizontal-variant'),
          item('discovery', 'Discovery', '/dashboard/discovery', 'compass'),
        ],
      },
      {
        title: 'Integrations',
        items: [
          item('api-endpoints', 'API Endpoints', '/dashboard/api-endpoints', 'code-braces'),
          item('webhooks', 'Webhooks', '/dashboard/webhooks', 'web', 'Get notified of events'),
          item('log-export', 'Log Export', '/dashboard/log-export', 'export', 'Ship call logs out'),
          item('proxy', 'Proxy', '/dashboard/system/proxy', 'dns'),
        ],
      },
    ],
  },
  {
    id: 'analytics',
    title: 'Analytics',
    groups: [
      {
        title: '',
        items: [
          item('usage', 'Usage', '/dashboard/analytics', 'chart-bar'),
          item('combo-health', 'Combo Health', '/dashboard/analytics/combo-health', 'heart-pulse'),
          item('utilization', 'Utilization', '/dashboard/analytics/utilization', 'gauge'),
          item('cache', 'Cache', '/dashboard/cache', 'database'),
          item('analytics-compression', 'Compression', '/dashboard/analytics/compression', 'chart-box-outline'),
          item('analytics-search', 'Search', '/dashboard/analytics/search', 'magnify'),
          item('analytics-evals', 'Evals', '/dashboard/analytics/evals', 'flask'),
          item('provider-stats', 'Provider Stats', '/dashboard/provider-stats', 'chart-donut'),
          item('activity', 'Activity', '/dashboard/activity', 'timeline-clock'),
        ],
      },
    ],
  },
  {
    id: 'costs',
    title: 'Costs',
    groups: [
      {
        title: '',
        items: [
          item('costs-overview', 'Overview', '/dashboard/costs', 'wallet'),
          item('costs-pricing', 'Pricing', '/dashboard/costs/pricing', 'tag'),
          item('costs-budget', 'Budget', '/dashboard/costs/budget', 'piggy-bank'),
          item('free-tiers', 'Free-Tier Budget', '/dashboard/free-tiers', 'ticket'),
          item('free-provider-rankings', 'Free Provider Rankings', '/dashboard/free-provider-rankings', 'trophy'),
          item('radar', 'Radar Catalog', '/dashboard/radar', 'radar'),
        ],
      },
    ],
  },
  {
    id: 'monitoring',
    title: 'Monitoring',
    groups: [
      {
        title: 'Logs',
        items: [
          item('logs', 'Logs', '/dashboard/logs', 'file-document'),
          item('logs-proxy', 'Proxy Logs', '/dashboard/logs/proxy', 'network'),
          item('logs-console', 'Console Logs', '/dashboard/logs/console', 'console'),
          item('logs-timeline', 'Timeline', '/dashboard/logs/timeline', 'format-list-checks'),
          item('conversations', 'Conversations', '/dashboard/conversations', 'forum'),
        ],
      },
      {
        title: 'Audit',
        items: [
          item('audit', 'Audit Log', '/dashboard/audit', 'shield-check'),
          item('audit-mcp', 'MCP Audit', '/dashboard/audit/mcp', 'shield-account'),
          item('audit-a2a', 'A2A Audit', '/dashboard/audit/a2a', 'shield-link'),
        ],
      },
      {
        title: 'System',
        items: [
          item('health', 'Health', '/dashboard/health', 'heart'),
          item('runtime', 'Runtime', '/dashboard/runtime', 'server'),
          item('resilience', 'Resilience', '/dashboard/resilience/connections', 'web-refresh'),
        ],
      },
    ],
  },
  {
    id: 'devtools',
    title: 'Dev Tools',
    groups: [
      {
        title: '',
        items: [
          item('translator', 'Translator', '/dashboard/translator', 'translate'),
          item('playground', 'Playground', '/dashboard/playground', 'flask-outline'),
          item('search-tools', 'Search Tools', '/dashboard/search-tools', 'magnify-plus'),
        ],
      },
    ],
  },
  {
    id: 'agentic',
    title: 'Agentic Features',
    groups: [
      {
        title: '',
        items: [
          item('memory', 'Memory', '/dashboard/memory', 'brain'),
          item('agent-skills', 'AgentSkills', '/dashboard/agent-skills', 'hand'),
          item('chaos', 'Chaos Mode', '/dashboard/chaos', 'swap', 'Multi-model parallel execution'),
          item('omni-skills', 'OmniSkills', '/dashboard/omni-skills', 'wand'),
          item('mcp', 'MCP Server', '/dashboard/mcp', 'server-network'),
          item('a2a', 'A2A Server', '/dashboard/a2a', 'swap-horizontal'),
          item('plugins', 'Plugins', '/dashboard/plugins', 'plug'),
        ],
      },
    ],
  },
  {
    id: 'other',
    title: 'Other Features',
    groups: [
      {
        title: 'Gamification',
        items: [
          item('leaderboard', 'Leaderboard', '/dashboard/leaderboard', 'trophy'),
          item('profile', 'Profile', '/dashboard/profile', 'account'),
          item('tokens', 'Tokens', '/dashboard/tokens', 'ticket-confirmation'),
          item('gamification-admin', 'Gamification Admin', '/dashboard/gamification/admin', 'account-cog'),
        ],
      },
      {
        title: '',
        items: [
          item('media', 'Media', '/dashboard/cache/media', 'image-multiple'),
        ],
      },
      {
        title: 'Batch',
        items: [
          item('batch', 'Batch Jobs', '/dashboard/batch', 'format-list-numbered'),
          item('batch-files', 'Files', '/dashboard/batch/files', 'folder'),
        ],
      },
    ],
  },
  {
    id: 'configuration',
    title: 'Configuration',
    groups: [
      {
        title: '',
        items: [
          item('settings-general', 'Storage', '/dashboard/settings/general', 'cog'),
          item('settings-appearance', 'Appearance', '/dashboard/settings/appearance', 'palette'),
          item('settings-ai', 'AI Settings', '/dashboard/settings/ai', 'brain'),
          item('settings-modality-bridge', 'Modality Bridge', '/dashboard/settings/modality-bridge', 'image-search'),
          item('settings-routing', 'Global Routing', '/dashboard/settings/routing', 'route'),
          item('settings-resilience', 'Resilience', '/dashboard/settings/resilience', 'shield'),
          item('settings-advanced', 'Advanced', '/dashboard/settings/advanced', 'cog-extended'),
          item('settings-security', 'Security', '/dashboard/settings/security', 'lock'),
          item('settings-access-tokens', 'Access Tokens', '/dashboard/settings/access-tokens', 'key-variant'),
          item('settings-feature-flags', 'Feature Flags', '/dashboard/settings/feature-flags', 'flag'),
          item('settings-cache', 'Cache', '/dashboard/settings/cache', 'database'),
          item('settings-sidebar', 'Sidebar', '/dashboard/settings/sidebar', 'menu'),
        ],
      },
    ],
  },
  {
    id: 'help',
    title: 'Help',
    groups: [
      {
        title: '',
        items: [
          item('docs', 'Docs', '/docs', 'book'),
          item('issues', 'Issues', 'https://github.com/diegosouzapw/OmniRoute/issues', 'bug'),
          item('changelog', 'Changelog', '/dashboard/changelog', 'calendar-clock'),
        ],
      },
    ],
  },
];

export const isExternal = (path: string): boolean => /^https?:\/\//.test(path);

/** Look up a feature by its route (e.g. `/dashboard/models`). */
export function findFeatureByPath(path: string): FeatureItem | undefined {
  for (const section of FEATURE_SECTIONS) {
    for (const group of section.groups) {
      for (const f of group.items) {
        if (f.path === path) return f;
      }
    }
  }
  return undefined;
}

export const TOTAL_FEATURE_COUNT = FEATURE_SECTIONS.reduce(
  (n, s) => n + s.groups.reduce((m, g) => m + g.items.length, 0),
  0,
);
