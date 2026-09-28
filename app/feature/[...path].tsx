import React, { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';

import OmniWebview from '../../components/OmniWebview';
import { findFeatureByPath } from '../../lib/features';

/**
 * Catch-all gateway feature screen.
 *
 * Routes look like `/feature/dashboard/context/caveman` → path
 * `/dashboard/context/caveman` on the gateway. This is how every single
 * OmniRoute feature (compression engines, analytics, logs, settings, …) is
 * opened from the native More menu.
 */
export default function FeatureScreen() {
  const params = useLocalSearchParams<{ path: string[] }>();
  const path = useMemo(() => {
    const segments = Array.isArray(params.path) ? params.path : [params.path ?? ''];
    return `/${segments.map((s) => decodeURIComponent(s)).join('/')}`;
  }, [params.path]);

  const feature = findFeatureByPath(path);
  const title = feature?.label ?? path.replace(/^\//, '').split('/').pop() ?? 'Feature';

  return <OmniWebview path={path} title={title} />;
}
