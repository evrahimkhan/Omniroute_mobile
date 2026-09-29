import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { openURL } from 'expo-linking';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import { clearWebViewData } from '../lib/webData';
import LocalGatewayCard from '../components/LocalGatewayCard';

import { checkGateway, normalizeServerUrl } from '../lib/gateway';
import { useSettings } from '../lib/useSettings';
import { theme } from '../lib/theme';

const OMNIROUTE_REPO = 'https://github.com/diegosouzapw/OmniRoute';

export default function SettingsScreen() {
  const { settings, save, reset } = useSettings();
  const [url, setUrl] = useState(settings.serverUrl);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const appVersion = (Constants.expoConfig?.version as string | undefined) ?? '1.0.0';

  const test = async () => {
    const target = normalizeServerUrl(url);
    if (!target) return;
    setTesting(true);
    setTestResult(null);
    const res = await checkGateway(target);
    setTesting(false);
    if (res.ok) {
      setTestResult(`Online — HTTP ${res.status} in ${res.latencyMs ?? '?'} ms`);
    } else {
      setTestResult(`Unreachable — ${res.detail ?? `HTTP ${res.status ?? '?'}`}`);
    }
  };

  const saveServer = async () => {
    const target = normalizeServerUrl(url);
    if (!target) return;
    await save({ serverUrl: target, configured: true });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    Alert.alert('Gateway saved', `Connected to ${target}`);
  };

  const usePublic = async () => {
    setUrl('https://omniroute.online');
    setTestResult(null);
  };

  /**
   * Point the app at the gateway that is running on this phone. The URL comes
   * from the installer only after it has answered `/healthz`, so this saves a
   * gateway that is known to be up.
   */
  const useLocal = async (localUrl: string) => {
    setUrl(localUrl);
    setTestResult(null);
    await save({ serverUrl: localUrl, configured: true });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    Alert.alert(
      'Using the local gateway',
      `The dashboard now loads from ${localUrl}, served by this phone.`,
    );
  };

  const changeServer = () => {
    Alert.alert('Change gateway', 'Reset the app and point it at another OmniRoute gateway?', [
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

  const clearData = () => {
    Alert.alert(
      'Clear gateway data',
      'Removes all cookies and cache used by the dashboard (you will need to sign in again).',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            setClearing(true);
            try {
              clearWebViewData();
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
                () => {},
              );
            } catch {
              // Platform without WebViewCache — nothing to clear.
            } finally {
              setClearing(false);
            }
          },
        },
      ],
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <MaterialCommunityIcons name="arrow-left" size={24} color={theme.text} />
        </Pressable>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.cardTitle}>LOCAL GATEWAY</Text>
        <LocalGatewayCard onUse={useLocal} />

        <Text style={styles.cardTitle}>GATEWAY</Text>
        <View style={styles.card}>
          <Text style={styles.fieldLabel}>Server URL</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={(t) => {
              setUrl(t);
              setTestResult(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://omniroute.online"
            placeholderTextColor={theme.textMuted}
            returnKeyType="done"
          />
          <View style={styles.row}>
            <Pressable
              style={({ pressed }) => [
                styles.btn,
                styles.btnSecondary,
                pressed && styles.pressed,
              ]}
              onPress={test}
              disabled={testing}
              accessibilityRole="button"
            >
              {testing ? (
                <ActivityIndicator size="small" color={theme.text} />
              ) : (
                <MaterialCommunityIcons name="radar" size={17} color={theme.text} />
              )}
              <Text style={styles.btnLabel}>Test</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.btn,
                styles.btnSecondary,
                pressed && styles.pressed,
              ]}
              onPress={usePublic}
              accessibilityRole="button"
            >
              <MaterialCommunityIcons name="earth" size={17} color={theme.text} />
              <Text style={styles.btnLabel}>Public</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.pressed]}
              onPress={saveServer}
              accessibilityRole="button"
            >
              <MaterialCommunityIcons name="check" size={17} color="#0b0f1a" />
              <Text style={styles.btnLabelDark}>Save</Text>
            </Pressable>
          </View>
          {testResult ? (
            <Text
              style={[
                styles.testResult,
                testResult.startsWith('Online')
                  ? { color: theme.success }
                  : { color: theme.danger },
              ]}
            >
              {testResult}
            </Text>
          ) : null}
          <Pressable
            style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.7 }]}
            onPress={changeServer}
            accessibilityRole="button"
          >
            <MaterialCommunityIcons name="swap-horizontal" size={17} color={theme.textMuted} />
            <Text style={styles.linkLabel}>Change gateway / reset app</Text>
          </Pressable>
        </View>

        <Text style={styles.cardTitle}>DATA</Text>
        <View style={styles.card}>
          <Pressable
            style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.7 }]}
            onPress={clearData}
            disabled={clearing}
            accessibilityRole="button"
          >
            {clearing ? (
              <ActivityIndicator size="small" color={theme.textMuted} />
            ) : (
              <MaterialCommunityIcons name="delete-sweep" size={17} color={theme.textMuted} />
            )}
            <Text style={styles.linkLabel}>Clear dashboard cookies & cache</Text>
          </Pressable>
          <Text style={styles.note}>
            Your session lives in the app’s web storage — clearing it signs you out of the
            dashboard.
          </Text>
        </View>

        <Text style={styles.cardTitle}>ABOUT</Text>
        <View style={styles.card}>
          <View style={styles.aboutRow}>
            <Text style={styles.aboutLabel}>OmniRoute Mobile</Text>
            <Text style={styles.aboutValue}>v{appVersion}</Text>
          </View>
          <View style={styles.aboutRow}>
            <Text style={styles.aboutLabel}>Source</Text>
            <Pressable onPress={() => openURL(OMNIROUTE_REPO).catch(() => {})}>
              <Text style={styles.aboutLink}>github.com/diegosouzapw/OmniRoute</Text>
            </Pressable>
          </View>
          <View style={styles.aboutRow}>
            <Text style={styles.aboutLabel}>Build</Text>
            <Pressable
              onPress={() =>
                openURL(
                  'https://github.com/evrahimkhan/Omniroute_mobile/actions',
                ).catch(() => {})
              }
            >
              <Text style={styles.aboutLink}>GitHub workflow → APK / Docker</Text>
            </Pressable>
          </View>
          <Text style={styles.note}>
            This app is a native shell for the OmniRoute gateway. The gateway source is
            compiled by the CI pipeline (Next.js build + Docker image + Android APK).
            OmniRoute is MIT licensed.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 10,
    backgroundColor: theme.tabBarBg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    color: theme.text,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  scroll: { padding: 16, paddingBottom: 48 },
  cardTitle: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginTop: 18,
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 14,
    gap: 10,
  },
  fieldLabel: { color: theme.textMuted, fontSize: 12, fontWeight: '600' },
  input: {
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    color: theme.text,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  row: { flexDirection: 'row', gap: 8 },
  btn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 12,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.bg,
  },
  btnPrimary: { backgroundColor: theme.accent, borderColor: theme.accent },
  btnSecondary: { backgroundColor: theme.bg },
  pressed: { opacity: 0.85 },
  btnLabel: { color: theme.text, fontWeight: '700', fontSize: 13 },
  btnLabelDark: { color: '#0b0f1a', fontWeight: '800', fontSize: 13 },
  testResult: { fontSize: 13, fontWeight: '600' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  linkLabel: { color: theme.text, fontSize: 14, fontWeight: '500', flex: 1 },
  note: { color: theme.textMuted, fontSize: 12, lineHeight: 17 },
  aboutRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  aboutLabel: { color: theme.textMuted, fontSize: 13 },
  aboutValue: { color: theme.text, fontSize: 13, fontWeight: '700' },
  aboutLink: { color: theme.accent, fontSize: 13, fontWeight: '600' },
});
