import React, { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';

import LocalGatewayCard from '../components/LocalGatewayCard';
import ScreenHeader from '../components/ScreenHeader';
import { Button, Card, Field, ListRow, Screen, SectionHeader } from '../components/ui/kit';
import { useToast } from '../components/ui/Toast';
import { describeError, useApiContext } from '../lib/api/context';
import { checkGateway, normalizeServerUrl } from '../lib/gateway';
import { useSettings } from '../lib/useSettings';
import { theme } from '../lib/theme';

/**
 * Settings — natively, and without the WebView it used to clear.
 *
 * Three things live here: where the gateway is (including hosting it on this
 * phone), how the app authenticates to it, and what the app is. The old version
 * also offered "clear dashboard cookies & cache", which cleared a web view this
 * app no longer has — the equivalent now is the session, and that is a sign-out.
 */
export default function SettingsScreen() {
  const { settings, save, reset, loaded } = useSettings();
  const { session } = useApiContext();
  const { showToast } = useToast();

  const [url, setUrl] = useState(settings.serverUrl);
  const [token, setToken] = useState(settings.apiToken ?? '');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [savingToken, setSavingToken] = useState(false);

  // The stored value arrives asynchronously; without this the field can show the
  // default gateway and Save would then silently switch the app to it.
  useEffect(() => {
    if (loaded) setUrl(settings.serverUrl);
  }, [loaded, settings.serverUrl]);

  const appVersion = (Constants.expoConfig?.version as string | undefined) ?? '1.0.0';

  const test = async () => {
    const target = normalizeServerUrl(url);
    if (!target) return;
    setTesting(true);
    setTestResult(null);
    const res = await checkGateway(target);
    setTesting(false);
    setTestResult(
      res.ok ? `Online — HTTP ${res.status} in ${res.latencyMs ?? '?'} ms` : `Unreachable — ${res.detail ?? ''}`
    );
  };

  const saveServer = async () => {
    const target = normalizeServerUrl(url);
    if (!target) return;
    await save({ ...settings, serverUrl: target, configured: true });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    showToast(`Gateway saved: ${target}`, 'ok');
  };

  const saveToken = async () => {
    setSavingToken(true);
    try {
      await save({ ...settings, apiToken: token.trim() || undefined });
      showToast(token.trim() ? 'API token saved' : 'API token cleared', 'ok');
    } catch (err) {
      showToast(describeError(err), 'danger');
    } finally {
      setSavingToken(false);
    }
  };

  const useLocal = async (localUrl: string) => {
    setUrl(localUrl);
    setTestResult(null);
    await save({ ...settings, serverUrl: localUrl, configured: true });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    showToast('Using the gateway running on this phone', 'ok');
  };

  const changeServer = () => {
    Alert.alert('Reset the app?', 'Forget the saved gateway and start over from the connection screen.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: () => {
          reset().then(() => router.navigate('/'));
        },
      },
    ]);
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="Settings" subtitle={settings.serverUrl} />
      <Screen scroll>
        <SectionHeader title="LOCAL GATEWAY" />
        <LocalGatewayCard onUse={useLocal} />

        <SectionHeader title="GATEWAY ADDRESS" />
        <Card>
          <View style={styles.cardBody}>
            <Field
              label="Server URL"
              value={url}
              onChange={(next) => {
                setUrl(next);
                setTestResult(null);
              }}
              placeholder="http://127.0.0.1:8080"
              keyboardType="url"
              hint="A bare address gets http on loopback and your local network, https anywhere else."
            />
            <View style={styles.row}>
              <Button label="Test" icon="radar" variant="secondary" loading={testing} onPress={test} style={styles.flex} />
              <Button label="Save" icon="check" onPress={saveServer} style={styles.flex} />
            </View>
            <Pressable onPress={() => setUrl('http://127.0.0.1:8080')} style={styles.linkRow}>
              <MaterialCommunityIcons name="cellphone-link" size={16} color={theme.textMuted} />
              <Text style={styles.linkLabel}>Use the gateway on this phone</Text>
            </Pressable>
            {testResult ? (
              <Text style={[styles.testResult, { color: testResult.startsWith('Online') ? theme.success : theme.danger }]}>
                {testResult}
              </Text>
            ) : null}
          </View>
        </Card>

        <SectionHeader title="SESSION" />
        <Card>
          <ListRow
            icon={
              session.authenticated === false
                ? 'lock-outline'
                : session.authenticated
                  ? 'shield-check-outline'
                  : 'shield-off-outline'
            }
            // Green for a state that was never established is how this app came to
            // claim it was signed in to a website: `authenticated` has three
            // answers, and only two of them mean anything. `null` is "unknown", so
            // it is drawn as unknown.
            iconColor={
              session.authenticated === false ? '#f5a524' : session.authenticated ? theme.success : theme.textMuted
            }
            title={
              session.authenticated === false
                ? 'The gateway wants a session'
                : session.authenticated
                  ? 'Signed in'
                  : 'Session state unknown'
            }
            subtitle={
              session.authenticated === null
                ? 'Nothing has confirmed the gateway is answering yet. The session screen checks it directly.'
                : 'A local gateway trusts requests from this phone; a password on it changes that.'
            }
          />
          <View style={styles.cardBody}>
            <Field
              label="API token (optional)"
              value={token}
              onChange={setToken}
              secure
              placeholder="Paste an OmniRoute API key"
              hint="Sent as a bearer token on every request. Useful when the gateway is on a LAN or a tunnel."
            />
            <View style={styles.row}>
              <Button label="Save token" icon="key-plus" variant="secondary" loading={savingToken} onPress={saveToken} style={styles.flex} />
              <Button
                label={session.authenticated === false ? 'Sign in' : 'Session & sign-in'}
                icon={session.authenticated === false ? 'login' : 'shield-search'}
                variant="secondary"
                onPress={() => router.push('/sign-in')}
                style={styles.flex}
              />
            </View>
            {session.cookie ? (
              <Button
                label="Sign out of this gateway"
                icon="logout"
                variant="ghost"
                onPress={async () => {
                  await session.signOut();
                  showToast('Signed out', 'ok');
                }}
              />
            ) : null}
          </View>
        </Card>

        <SectionHeader title="DASHBOARD-FIRST SETTINGS" />
        <Card>
          <ListRow
            icon="tune-variant"
            title="Advanced configuration lives on the gateway"
            subtitle="Compression engines, routing rules, cache, CLI tools and provider onboarding are configured in the gateway's own dashboard — the app shows the results of those settings rather than duplicating their editors."
          />
        </Card>

        <SectionHeader title="APP" />
        <Card>
          <ListRow icon="information-outline" title="OmniRoute Mobile" detail={`v${appVersion}`} />
          <ListRow
            icon="sync"
            title="Reset the app"
            subtitle="Forget the saved gateway and return to the connection screen"
            onPress={changeServer}
          />
          <ListRow
            icon="cellphone"
            title="Everything here is native"
            subtitle="The app talks to the gateway's JSON API. No screen is a web view."
          />
        </Card>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  cardBody: { padding: 12, gap: 12 },
  row: { flexDirection: 'row', gap: 8 },
  flex: { flex: 1 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  linkLabel: { color: theme.text, fontSize: 13, fontWeight: '600' },
  testResult: { fontSize: 13, fontWeight: '600' },
});
