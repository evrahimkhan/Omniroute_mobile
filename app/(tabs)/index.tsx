import React, { useCallback } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import {
  Button,
  Card,
  ListRow,
  Loading,
  ErrorState,
  Screen,
  SectionHeader,
  StatTile,
} from '../../components/ui/kit';
import { useApiContext, usePolling } from '../../lib/api/context';
import { getHealth, getProviders, getTelemetry, getCallLogs, logSummary } from '../../lib/api/resources';
import { compactNumber, humanBytes, humanDuration } from '../../lib/api/shape';
import { hostOf } from '../../lib/gateway';
import { useSettings } from '../../lib/useSettings';
import { theme } from '../../lib/theme';

/**
 * Home — the gateway, natively.
 *
 * This screen is what the dashboard's overview page used to be, and it is the
 * clearest example of why the rewrite was worth it: three requests that the
 * browser made with its own cache and cookies are now three numbers on a native
 * screen, with the gateway's own health, uptime, memory and traffic in one
 * glance — and a tappable path into everything else.
 *
 * Polling rather than a socket: the gateway's dashboard routes are request/
 * response, and a 10-second refresh is honest about what it is.
 */
export default function HomeScreen() {
  const { api, waiting } = useApiContext();
  const { settings } = useSettings();

  const health = usePolling(api ? () => getHealth(api) : null, 10_000);
  const telemetry = usePolling(api ? () => getTelemetry(api) : null, 10_000);
  const providers = usePolling(api ? () => getProviders(api) : null, 30_000);
  const logs = usePolling(api ? () => getCallLogs(api, { limit: 5 }) : null, 15_000);

  const refreshing = health.loading || telemetry.loading;
  const reloadAll = useCallback(async () => {
    await Promise.all([health.reload(), telemetry.reload(), providers.reload(), logs.reload()]);
  }, [health, telemetry, providers, logs]);

  if (waiting) return <Loading label="Reading settings…" />;

  if (!api) {
    return (
      <Screen>
        <ErrorState
          message="No gateway is configured yet. Open Settings to point the app at one, or host a gateway on this phone."
          onRetry={() => router.push('/settings')}
        />
      </Screen>
    );
  }

  if (health.error && !health.data) {
    // If the address answered with a web page, retrying will not help: the fix
    // is a different address, so the second button goes there instead.
    const wrongAddress = /web page|not a gateway/i.test(health.error);
    return (
      <Screen>
        <ErrorState
          message={health.error}
          title={wrongAddress ? 'This address is not a gateway' : undefined}
          onRetry={reloadAll}
          action={
            wrongAddress
              ? { label: 'Gateway settings', icon: 'cog-outline', onPress: () => router.push('/settings') }
              : undefined
          }
        />
      </Screen>
    );
  }

  const active = providers.data?.filter((p) => p.active).length ?? 0;
  const total = providers.data?.length ?? 0;
  const errorRate = telemetry.data?.errorRate;

  return (
    <Screen
      scroll
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reloadAll} tintColor={theme.textMuted} />}
    >
      <View style={styles.hero}>
        <View style={[styles.dot, health.data?.ok ? styles.dotOn : styles.dotOff]} />
        <View style={styles.heroText}>
          <Text style={styles.heroTitle}>
            {health.data?.ok ? 'Gateway is healthy' : health.data ? `Gateway: ${health.data.status}` : 'Checking…'}
          </Text>
          <Text style={styles.heroSubtitle} numberOfLines={1}>
            {hostOf(settings.serverUrl)}
          </Text>
        </View>
        <MaterialCommunityIcons name="server-network" size={22} color={theme.textMuted} />
      </View>

      <View style={styles.statRow}>
        <StatTile
          label="UPTIME"
          value={humanDuration(telemetry.data?.uptimeMs)}
          hint={telemetry.data?.uptimeMs === undefined ? 'not reported' : undefined}
          icon="clock-outline"
        />
        <StatTile
          label="MEMORY"
          value={humanBytes(telemetry.data?.memoryBytes)}
          hint={telemetry.data?.memoryBytes === undefined ? 'not reported' : undefined}
          icon="memory"
        />
        <StatTile
          label="ERRORS"
          value={errorRate === undefined ? '—' : `${(errorRate * 100).toFixed(1)}%`}
          tone={errorRate && errorRate > 0.05 ? 'warn' : 'ok'}
          icon="alert-outline"
        />
      </View>

      <View style={styles.statRow}>
        <StatTile
          label="PROVIDERS ON"
          value={total ? `${active}/${total}` : '—'}
          hint={providers.data ? undefined : 'loading'}
          tone={active > 0 ? 'ok' : 'warn'}
          icon="lan"
        />
        <StatTile
          label="CONNECTIONS"
          value={compactNumber(telemetry.data?.activeConnections)}
          icon="access-point"
        />
      </View>

      <SectionHeader title="MANAGE" />
      <Card>
        <ListRow
          icon="key-variant"
          title="API keys"
          subtitle="Create, reveal and revoke keys for your clients"
          onPress={() => router.push('/keys')}
        />
        <ListRow
          icon="lan-connect"
          title="Providers"
          subtitle={`${active} active of ${total || '…'} connections`}
          onPress={() => router.push('/(tabs)/providers')}
        />
        <ListRow
          icon="format-list-bulleted"
          title="Models"
          subtitle="The catalog, and which ones you can call"
          onPress={() => router.push('/(tabs)/models')}
        />
        <ListRow
          icon="layers-triple"
          title="Combos"
          subtitle="Grouped providers used for failover"
          onPress={() => router.push('/combos')}
        />
        <ListRow
          icon="text-box-search-outline"
          title="Request log"
          subtitle="Every call through the gateway, filtered"
          onPress={() => router.push('/logs')}
        />
      </Card>

      <SectionHeader
        title="RECENT REQUESTS"
        right={
          logs.data?.length ? (
            <Button label="See all" variant="ghost" icon="arrow-right" onPress={() => router.push('/logs')} />
          ) : undefined
        }
      />
      <Card>
        {logs.data?.length ? (
          logs.data.slice(0, 5).map((log) => (
            <ListRow
              key={log.id}
              icon={log.ok ? 'check-circle-outline' : 'alert-circle-outline'}
              iconColor={log.ok ? theme.success : theme.danger}
              title={log.model}
              subtitle={[log.provider, logSummary(log)].filter(Boolean).join(' · ')}
              detail={log.when}
              onPress={() => router.push('/logs')}
            />
          ))
        ) : (
          <ListRow
            icon="sleep"
            title={logs.error ? 'Could not read the log' : 'No requests yet'}
            subtitle={logs.error ?? 'Calls you make through the gateway show up here.'}
          />
        )}
      </Card>

      <SectionHeader title="THIS PHONE" />
      <Card>
        <ListRow
          icon="cellphone-cog"
          title="Host a gateway here"
          subtitle="Install, start and keep OmniRoute running on the device"
          onPress={() => router.push('/settings')}
        />
        <ListRow
          icon="tune"
          title="Settings"
          subtitle="Gateway address, session and app information"
          onPress={() => router.push('/settings')}
        />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 14,
  },
  heroText: { flex: 1, gap: 2 },
  heroTitle: { color: theme.text, fontSize: 16, fontWeight: '700' },
  heroSubtitle: { color: theme.textMuted, fontSize: 12 },
  dot: { width: 11, height: 11, borderRadius: 6 },
  dotOn: { backgroundColor: theme.success },
  dotOff: { backgroundColor: theme.danger },
  statRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
});
