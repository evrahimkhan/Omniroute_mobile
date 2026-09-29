import React, { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import LocalGatewayCard from './LocalGatewayCard';
import { checkGateway, normalizeServerUrl } from '../lib/gateway';
import { DEFAULT_SERVER_URL, type Settings } from '../lib/useSettings';
import { theme } from '../lib/theme';

interface Props {
  initial: Settings;
  onSave: (next: Settings) => Promise<void>;
}

type TestState =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'ok'; latencyMs: number }
  | { state: 'fail'; detail: string };

/**
 * First-run (or "change server") screen: point the app at your OmniRoute
 * gateway, verify it answers, and continue.
 */
export default function ConnectionGate({ initial, onSave }: Props) {
  const [url, setUrl] = useState(initial.serverUrl || DEFAULT_SERVER_URL);
  const [test, setTest] = useState<TestState>({ state: 'idle' });
  const [saving, setSaving] = useState(false);
  // Collapsed by default: the common case is still "point me at a gateway".
  const [showLocal, setShowLocal] = useState(false);

  const runTest = async () => {
    const target = normalizeServerUrl(url);
    if (!target) return;
    setTest({ state: 'testing' });
    const res = await checkGateway(target);
    if (res.ok) {
      setTest({ state: 'ok', latencyMs: res.latencyMs ?? 0 });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } else {
      setTest({ state: 'fail', detail: res.detail || `HTTP ${res.status ?? '?'}` });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave({ serverUrl: normalizeServerUrl(url), configured: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Image source={require('../assets/icon.png')} style={styles.logo} />
        <Text style={styles.title}>OmniRoute Mobile</Text>
        <Text style={styles.subtitle}>
          One endpoint → 358 AI providers.
          {'\n'}Every dashboard feature lives in this app.
        </Text>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>GATEWAY URL</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder={DEFAULT_SERVER_URL}
            placeholderTextColor={theme.textMuted}
            returnKeyType="done"
          />
          <Text style={styles.hint}>
            Self-hosted? Use the URL of your gateway — e.g.{' '}
            <Text style={styles.hintCode}>http://192.168.1.10:20128</Text> (same Wi-Fi) or a
            tunnel/domain. Built from source by the GitHub workflow — see the README.
          </Text>

          <View style={styles.row}>
            <Pressable
              style={({ pressed }) => [styles.btn, styles.btnSecondary, pressed && styles.pressed]}
              onPress={runTest}
              disabled={test.state === 'testing'}
              accessibilityRole="button"
            >
              {test.state === 'testing' ? (
                <ActivityIndicator size="small" color={theme.text} />
              ) : (
                <MaterialCommunityIcons name="radar" size={18} color={theme.text} />
              )}
              <Text style={styles.btnLabel}>Test</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.pressed]}
              onPress={save}
              disabled={saving || !normalizeServerUrl(url)}
              accessibilityRole="button"
            >
              {saving ? (
                <ActivityIndicator size="small" color="#0b0f1a" />
              ) : (
                <MaterialCommunityIcons name="login" size={18} color="#0b0f1a" />
              )}
              <Text style={styles.btnLabelDark}>Connect</Text>
            </Pressable>
          </View>

          {test.state === 'ok' ? (
            <View style={[styles.testResult, styles.testOk]}>
              <MaterialCommunityIcons name="check-circle" size={18} color={theme.success} />
              <Text style={styles.testResultText}>
                Gateway online · {test.latencyMs} ms
              </Text>
            </View>
          ) : null}
          {test.state === 'fail' ? (
            <View style={[styles.testResult, styles.testFail]}>
              <MaterialCommunityIcons name="alert-circle" size={18} color={theme.danger} />
              <Text style={[styles.testResultText, { color: theme.danger }]}>
                Unreachable: {test.detail}
              </Text>
            </View>
          ) : null}
        </View>

        <Pressable
          style={({ pressed }) => [styles.localRow, pressed && { opacity: 0.7 }]}
          onPress={() => setShowLocal((v) => !v)}
          accessibilityRole="button"
        >
          <MaterialCommunityIcons
            name={showLocal ? 'chevron-down' : 'chevron-right'}
            size={18}
            color={theme.textMuted}
          />
          <Text style={styles.localLabel}>
            No gateway yet? Run OmniRoute on this phone
          </Text>
        </Pressable>

        {showLocal ? (
          <LocalGatewayCard
            onUse={async (localUrl) => {
              setUrl(localUrl);
              await onSave({ serverUrl: localUrl, configured: true });
            }}
          />
        ) : null}

        <Text style={styles.footer}>
          Sign in to the dashboard once inside the app (Home tab) — your session is shared
          across all features.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  localRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 16,
    paddingVertical: 6,
  },
  localLabel: { color: theme.text, fontSize: 14, fontWeight: '600', flex: 1 },
  root: { flex: 1, backgroundColor: theme.bg },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
  },
  logo: { width: 96, height: 96, borderRadius: 22, alignSelf: 'center' },
  title: {
    color: theme.text,
    fontSize: 26,
    fontWeight: '800',
    textAlign: 'center',
    marginTop: 16,
  },
  subtitle: {
    color: theme.textMuted,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
  },
  card: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 16,
    marginTop: 28,
  },
  cardLabel: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  input: {
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    color: theme.text,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginTop: 8,
  },
  hint: { color: theme.textMuted, fontSize: 12, marginTop: 10, lineHeight: 17 },
  hintCode: { color: theme.accent },
  row: { flexDirection: 'row', gap: 10, marginTop: 14 },
  btn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.bg,
  },
  btnPrimary: { backgroundColor: theme.accent, borderColor: theme.accent },
  btnSecondary: { backgroundColor: theme.bg },
  pressed: { opacity: 0.85 },
  btnLabel: { color: theme.text, fontWeight: '700', fontSize: 14 },
  btnLabelDark: { color: '#0b0f1a', fontWeight: '800', fontSize: 14 },
  testResult: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  testOk: { backgroundColor: 'rgba(52, 211, 153, 0.1)' },
  testFail: { backgroundColor: 'rgba(248, 113, 113, 0.1)' },
  testResultText: { color: theme.text, fontSize: 13, flex: 1 },
  footer: {
    color: theme.textMuted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 22,
    lineHeight: 18,
  },
});
