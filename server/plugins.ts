/*
 * Marketplace plugins — optional integrations the user installs from Settings.
 *
 * This file is the single source of truth for the catalog. Each entry drives the
 * marketplace card the UI renders (via GET /api/plugins); installing a plugin
 * simply records its id in `settings.installedPlugins`, and that gate is what
 * decides whether the plugin's features show up on the board (e.g. the "From
 * Linear" import button appears only when `linear` is installed).
 *
 * Plugins here are intentionally lightweight — they surface an existing, self-
 * contained integration (like server/linear.ts) behind an install toggle rather
 * than being a code-loading plugin framework. To offer a new integration, append
 * an entry below and gate its UI on `installedPlugins.includes(id)`.
 */

import type { PluginInfo } from './types';

const PLUGINS: PluginInfo[] = [
  {
    id: 'linear',
    name: 'Linear',
    description:
      'Import Linear issues as groomed, ready-to-run tasks. Adds a "From Linear" button to the board.',
    icon: 'linear',
    docsUrl: 'https://linear.app/settings/api',
    requiresApiKey: true,
  },
  {
    id: 'autonomous',
    name: 'Autonomous Mode',
    description:
      'Drive a workspace’s ready tasks end-to-end within a budget: dispatch each run, then merge its PR and move it to Done once it’s green — no babysitting.',
    icon: 'bot',
    requiresApiKey: false,
  },
];

const byId = new Map(PLUGINS.map((p) => [p.id, p]));

// The full catalog for the marketplace listing.
function catalog(): PluginInfo[] {
  return PLUGINS.map((p) => ({ ...p }));
}

function isKnown(id: unknown): boolean {
  return typeof id === 'string' && byId.has(id);
}

// Keep only known ids, deduped, in catalog order — the canonical stored shape.
function sanitize(ids: unknown): string[] {
  const wanted = Array.isArray(ids) ? ids : [];
  return PLUGINS.filter((p) => wanted.includes(p.id)).map((p) => p.id);
}

export { PLUGINS, catalog, isKnown, sanitize };
