import React from 'react';
import { View } from 'react-native';

import ConnectionGate from '../../components/ConnectionGate';
import OmniWebview from '../../components/OmniWebview';
import ServerPill from '../../components/ServerPill';
import { useSettings } from '../../lib/useSettings';
import { theme } from '../../lib/theme';

/**
 * Home — the OmniRoute dashboard (`/dashboard`), the gateway's main screen.
 * First run shows the connection gate; afterwards the live dashboard.
 */
export default function HomeScreen() {
  const { settings, loaded, save } = useSettings();

  if (!loaded) return <View style={{ flex: 1, backgroundColor: theme.bg }} />;

  if (!settings.configured || !settings.serverUrl) {
    return <ConnectionGate initial={settings} onSave={save} />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ServerPill />
      <OmniWebview path="/dashboard" title="Dashboard" showBack={false} />
    </View>
  );
}
