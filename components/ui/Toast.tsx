/**
 * The app's toast.
 *
 * A small confirmation that does not need an answer — "Copied", "Provider
 * disabled", "Key revoked". The old app had none of these because the dashboard's
 * own toasts lived in the page; a native screen that changes something needs to
 * say so, and `Alert.alert` for every confirmation is a popup the user has to
 * dismiss to get on with their work.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { theme } from '../../lib/theme';

interface ToastState {
  message: string;
  tone: 'default' | 'ok' | 'danger';
  /** Bumped per toast so the animation restarts for a repeated message. */
  id: number;
}

interface ToastContextValue {
  showToast: (message: string, tone?: ToastState['tone']) => void;
}

const ToastContext = createContext<ToastContextValue>({ showToast: () => {} });

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

const VISIBLE_MS = 2600;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const counter = useRef(0);
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback(
    (message: string, tone: ToastState['tone'] = 'default') => {
      counter.current += 1;
      setToast({ message, tone, id: counter.current });
    },
    []
  );

  useEffect(() => {
    if (!toast) return;
    if (timer.current) clearTimeout(timer.current);
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }).start();
    timer.current = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(({ finished }) => {
        if (finished) setToast(null);
      });
    }, VISIBLE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [toast, opacity]);

  const value = useMemo(() => ({ showToast }), [showToast]);
  const icon = toast?.tone === 'ok' ? 'check-circle' : toast?.tone === 'danger' ? 'alert-circle' : 'information';
  const tint =
    toast?.tone === 'ok' ? theme.success : toast?.tone === 'danger' ? theme.danger : theme.textMuted;

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast ? (
        <Animated.View style={[styles.wrap, { opacity }]} pointerEvents="box-none">
          <Pressable onPress={() => setToast(null)} accessibilityRole="button" style={styles.toast}>
            <MaterialCommunityIcons name={icon} size={17} color={tint} />
            <Text style={styles.text} numberOfLines={3}>
              {toast.message}
            </Text>
          </Pressable>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 86,
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    maxWidth: 460,
    backgroundColor: theme.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  text: { color: theme.text, fontSize: 13, flexShrink: 1 },
});
