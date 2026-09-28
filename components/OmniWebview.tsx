import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { openURL } from 'expo-linking';
import { router } from 'expo-router';
import type {
  ShouldStartLoadRequest,
  WebViewErrorEvent,
  WebViewEvent,
} from 'react-native-webview/lib/WebViewTypes';
import { WebView } from 'react-native-webview';

import { registerWebViewRef } from '../lib/webData';
import { gatewayUrl, hostOf, isExternalUrl } from '../lib/gateway';
import { useSettings } from '../lib/useSettings';
import { theme } from '../lib/theme';

interface Props {
  /** Route on the gateway, e.g. `/dashboard/models`. */
  path: string;
  /** Title shown in the slim app header. */
  title: string;
  /** Show a back button (set false for tab screens that are top-level). */
  showBack?: boolean;
}

/**
 * In-app browser for the OmniRoute dashboard.
 *
 * Every feature of the gateway is rendered here. Cookies/localStorage are
 * shared across all web views in the app, so you sign in to the dashboard
 * once (on the Home tab) and can navigate all features freely.
 */
export default function OmniWebview({ path, title, showBack = true }: Props) {
  const { settings } = useSettings();
  const ref = useRef<React.ComponentRef<typeof WebView>>(null);
  const [loading, setLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const url = useMemo(() => {
    if (isExternalUrl(path)) return path;
    return gatewayUrl(settings.serverUrl, path);
  }, [settings.serverUrl, path]);

  useEffect(() => {
    const unregister = registerWebViewRef(ref.current);
    return unregister;
  }, [reloadToken]);

  const tryGoBack = useCallback(() => {
    if (canGoBack) {
      try {
        ref.current?.goBack();
        return true;
      } catch {
        // fall through
      }
    }
    return false;
  }, [canGoBack]);

  // Android hardware back → web history first.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => tryGoBack());
    return () => sub.remove();
  }, [tryGoBack]);

  const handleBack = useCallback(() => {
    if (tryGoBack()) return;
    if (showBack) {
      if (router.canGoBack()) router.back();
      else router.navigate('/');
    }
  }, [tryGoBack, showBack]);

  const handleRefresh = useCallback(() => {
    setError(null);
    setLoading(true);
    setReloadToken((t) => t + 1);
  }, []);

  const handleOpenExternal = useCallback(() => {
    openURL(url).catch(() => {});
  }, [url]);

  const onShouldStartLoad = useCallback(
    (nav: ShouldStartLoadRequest): boolean => {
      setCanGoBack(nav.canGoBack ?? false);
      const target = nav.url;
      if (!target) return true;
      // Let the gateway (and its assets) load; bounce other http(s) hosts out.
      const gateHost = hostOf(settings.serverUrl);
      let targetHost = '';
      try {
        targetHost = new URL(target).host;
      } catch {
        return true;
      }
      if (targetHost !== gateHost) {
        openURL(target).catch(() => {});
        return false;
      }
      return true;
    },
    [settings.serverUrl],
  );

  const trackBack = useCallback((event: WebViewEvent) => {
    setCanGoBack(event.nativeEvent.canGoBack ?? false);
  }, []);

  const handleError = useCallback(
    (e: WebViewErrorEvent) => {
      const d = e.nativeEvent;
      setLoading(false);
      if (d.code !== 0) {
        setError(d.description || `Could not reach the gateway at ${hostOf(settings.serverUrl)}`);
      }
    },
    [settings.serverUrl],
  );

  const host = isExternalUrl(path) ? '' : hostOf(settings.serverUrl);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable
          onPress={handleBack}
          hitSlop={12}
          style={({ pressed }) => [styles.headerBtn, pressed && styles.headerBtnPressed]}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <MaterialCommunityIcons name="arrow-left" size={24} color={theme.text} />
        </Pressable>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {title}
          </Text>
          {host ? (
            <Text style={styles.headerHost} numberOfLines={1}>
              {host}
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={handleRefresh}
          hitSlop={12}
          style={({ pressed }) => [styles.headerBtn, pressed && styles.headerBtnPressed]}
          accessibilityRole="button"
          accessibilityLabel="Refresh"
        >
          <MaterialCommunityIcons name="refresh" size={22} color={theme.text} />
        </Pressable>
        <Pressable
          onPress={handleOpenExternal}
          hitSlop={12}
          style={({ pressed }) => [styles.headerBtn, pressed && styles.headerBtnPressed]}
          accessibilityRole="button"
          accessibilityLabel="Open in browser"
        >
          <MaterialCommunityIcons name="open-in-new" size={20} color={theme.textMuted} />
        </Pressable>
      </View>

      <View style={styles.webWrap}>
        <WebView
          key={`${settings.serverUrl}|${path}|${reloadToken}`}
          ref={ref}
          source={{ uri: url }}
          style={styles.webview}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          cacheEnabled
          startInLoadingState
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          onShouldStartLoadWithRequest={onShouldStartLoad}
          onLoadStart={(e: WebViewEvent) => {
            setLoading(true);
            setError(null);
            setCanGoBack(e.nativeEvent.canGoBack ?? false);
          }}
          onLoadEnd={trackBack}
          onError={handleError}
          renderLoading={() => (
            <View style={styles.loadingBox} pointerEvents="none">
              <ActivityIndicator size="large" color={theme.accent} />
              <Text style={styles.loadingText}>
                {host ? `Connecting to ${host}…` : 'Loading…'}
              </Text>
            </View>
          )}
        />
        {error ? (
          <View style={styles.errorBox}>
            <MaterialCommunityIcons name="wifi-off" size={44} color={theme.danger} />
            <Text style={styles.errorTitle}>Gateway unreachable</Text>
            <Text style={styles.errorText}>{error}</Text>
            <View style={styles.errorActions}>
              <Pressable
                style={({ pressed }) => [
                  styles.errorBtn,
                  styles.errorBtnPrimary,
                  pressed && { opacity: 0.85 },
                ]}
                onPress={handleRefresh}
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="refresh" size={18} color="#0b0f1a" />
                <Text style={styles.errorBtnLabel}>Retry</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.errorBtn, pressed && { opacity: 0.85 }]}
                onPress={() => router.push('/settings')}
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="cog" size={18} color={theme.text} />
                <Text style={styles.errorBtnLabelMuted}>Server settings</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
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
  headerBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerBtnPressed: { backgroundColor: theme.surfaceAlt },
  headerTitleWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    marginLeft: 4,
    marginRight: 4,
  },
  headerTitle: {
    flex: 1,
    color: theme.text,
    fontSize: 15,
    fontWeight: '600',
  },
  headerHost: {
    color: theme.textMuted,
    fontSize: 11,
    marginLeft: 6,
  },
  webWrap: { flex: 1 },
  webview: { flex: 1, backgroundColor: theme.bg },
  loadingBox: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.bg,
    gap: 12,
  },
  loadingText: { color: theme.textMuted, fontSize: 13 },
  errorBox: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.bg,
    padding: 28,
    gap: 8,
  },
  errorTitle: { color: theme.text, fontSize: 17, fontWeight: '700', marginTop: 8 },
  errorText: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
  },
  errorActions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  errorBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
  },
  errorBtnPrimary: { backgroundColor: theme.accent, borderColor: theme.accent },
  errorBtnLabel: { color: '#0b0f1a', fontWeight: '700', fontSize: 13 },
  errorBtnLabelMuted: { color: theme.text, fontWeight: '600', fontSize: 13 },
});
