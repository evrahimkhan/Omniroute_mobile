import React from 'react';
import { StyleSheet } from 'react-native';
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
 * Primary navigation — the five most-used OmniRoute surfaces, plus a More
 * tab that exposes the complete feature catalog (80+ features) and Settings.
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
          borderTopWidth: StyleSheet.hairlineWidth,
          height: 60,
        },
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textMuted,
        tabBarLabelStyle: { fontSize: 10, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ focused }) => tabIcon('home', focused),
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: 'Chat',
          tabBarIcon: ({ focused }) => tabIcon('message-text', focused),
        }}
      />
      <Tabs.Screen
        name="models"
        options={{
          title: 'Models',
          tabBarIcon: ({ focused }) => tabIcon('puzzle', focused),
        }}
      />
      <Tabs.Screen
        name="providers"
        options={{
          title: 'Providers',
          tabBarIcon: ({ focused }) => tabIcon('dns', focused),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: ({ focused }) => tabIcon('menu', focused),
        }}
      />
    </Tabs>
  );
}
