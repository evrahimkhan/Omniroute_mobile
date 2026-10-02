import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';

import { ApiProvider } from '../lib/api/context';
import { ToastProvider } from '../components/ui/Toast';
import { theme } from '../lib/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  return (
    <ApiProvider>
      <ToastProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: theme.bg },
            animation: 'slide_from_right',
          }}
        >
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="settings" />
          <Stack.Screen name="keys" />
          <Stack.Screen name="logs" />
          <Stack.Screen name="combos" />
          <Stack.Screen name="sign-in" options={{ presentation: 'modal' }} />
        </Stack>
      </ToastProvider>
    </ApiProvider>
  );
}
