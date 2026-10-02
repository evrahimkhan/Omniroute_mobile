import React from 'react';
import { Tabs } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { theme } from '../../lib/theme';

const tabIcon = (
  name: keyof typeof MaterialCommunityIcons.glyphMap,
  focused: boolean,
) => (
  <MaterialCommunityIcons
    name={name}
    size={22}
    color={focused ? theme.accent : theme.textMuted}
  />
);

/**
 * The five surfaces that earn a tab: what the gateway is doing, talking to a
 * model, what it can serve, what it can reach, and everything else.
 *
 * These are native screens. The tabs used to render the gateway's dashboard in a
 * WebView — the same five routes a browser would show — which is what made the
 * app feel like a browser with an icon.
 */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: theme.bg },
        tabBarStyle: {
          backgroundColor: theme.tabBarBg,
          borderTopColor: theme.border,
          height: 60,
          paddingBottom: 6,
          paddingTop: 6,
        },
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textMuted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Home', tabBarIcon: ({ focused }) => tabIcon('view-dashboard-outline', focused) }}
      />
      <Tabs.Screen
        name="chat"
        options={{ title: 'Playground', tabBarIcon: ({ focused }) => tabIcon('chat-processing-outline', focused) }}
      />
      <Tabs.Screen
        name="models"
        options={{ title: 'Models', tabBarIcon: ({ focused }) => tabIcon('format-list-bulleted', focused) }}
      />
      <Tabs.Screen
        name="providers"
        options={{ title: 'Providers', tabBarIcon: ({ focused }) => tabIcon('lan-connect', focused) }}
      />
      <Tabs.Screen
        name="more"
        options={{ title: 'More', tabBarIcon: ({ focused }) => tabIcon('dots-horizontal-circle-outline', focused) }}
      />
    </Tabs>
  );
}
