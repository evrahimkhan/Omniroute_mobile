/**
 * The route every catalog entry opens.
 *
 * One route rather than ninety because the catalog, not the file system, decides
 * what a surface is; the id is looked up in lib/screens/catalog.ts and rendered
 * by the matching renderer. Deep-linking to `/surface/audit` works from anywhere
 * in the app, including a script or a future widget.
 */

import { useLocalSearchParams } from 'expo-router';

import { SurfaceScreen } from '../../components/screens/SurfaceScreen';

export default function SurfaceRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  return <SurfaceScreen id={id ?? ''} />;
}
