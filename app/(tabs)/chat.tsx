import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';

import { Button, EmptyState, Loading, uiStyles } from '../../components/ui/kit';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { useApiContext } from '../../lib/api/context';
import { streamChat, type ChatMessage } from '../../lib/api/chat';
import { getModels, type ModelEntry } from '../../lib/api/resources';
import { titleCase } from '../../lib/api/shape';
import { theme } from '../../lib/theme';

/**
 * Playground — a real chat client, natively.
 *
 * This is the screen the WebView was worst at. In the browser the playground
 * streams into a page that has to be scrolled by the page, the keyboard covers
 * half of it, and every token costs a round trip through a web view. Here the
 * tokens are appended to React state directly, the list follows the newest
 * message, and stopping is an abort on the request.
 *
 * The gateway is OpenAI-compatible, so the request shape is the ordinary one:
 * POST a message list, read `choices[0].delta.content` out of the SSE stream.
 * See lib/api/chat.ts for the path probe and the no-stream fallback.
 */
export default function ChatScreen() {
  const { api, waiting } = useApiContext();
  const { showToast } = useToast();
  const params = useLocalSearchParams<{ model?: string }>();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamed, setStreamed] = useState('');
  const [model, setModel] = useState<string | null>(null);
  const [modelSheet, setModelSheet] = useState(false);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const abort = useRef<AbortController | null>(null);
  const list = useRef<FlatList<ChatMessage>>(null);

  // A model chosen on the Models screen arrives as a route param.
  useEffect(() => {
    if (params.model) setModel(String(params.model));
  }, [params.model]);

  useEffect(() => {
    if (!api || models.length) return;
    getModels(api, { all: true })
      .then((all) => {
        setModels(all.filter((m) => m.configured !== false).slice(0, 400));
        setModel((current) => current ?? all.find((m) => m.configured)?.id ?? all[0]?.id ?? null);
      })
      .catch(() => {
        // The picker stays empty; the chat still works with a typed model name.
      });
  }, [api, models.length]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !api || streaming) return;
    if (!model) {
      showToast('Pick a model first', 'danger');
      return;
    }
    const next: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setStreaming(true);
    setStreamed('');
    const controller = new AbortController();
    abort.current = controller;
    try {
      const answer = await streamChat(api, {
        model,
        messages: next,
        signal: controller.signal,
        onDelta: (delta) => {
          setStreamed((current) => current + delta);
          list.current?.scrollToEnd({ animated: true });
        },
      });
      setMessages([...next, { role: 'assistant', content: answer.text }]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A cancelled stream is the user's own doing; keep the question.
      if (!controller.signal.aborted) {
        setMessages((current) => [
          ...current,
          { role: 'assistant', content: `⚠️ ${message}` },
        ]);
      }
    } finally {
      setStreaming(false);
      setStreamed('');
      abort.current = null;
    }
  }, [api, input, messages, model, showToast, streaming]);

  const stop = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setStreaming(false);
  }, []);

  const rendered = useMemo(
    () => (streamed ? [...messages, { role: 'assistant' as const, content: streamed }] : messages),
    [messages, streamed]
  );

  if (waiting) return <Loading label="Reading settings…" />;
  if (!api) {
    return (
      <View style={uiStyles.screen}>
        <EmptyState icon="link-off" title="No gateway configured" body="Open Settings to point the app at a gateway." />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={uiStyles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 84 : 0}
    >
      <View style={styles.header}>
        <Pressable style={styles.modelBtn} onPress={() => setModelSheet(true)} accessibilityRole="button">
          <MaterialCommunityIcons name="robot-outline" size={16} color={theme.accent} />
          <Text style={styles.modelName} numberOfLines={1}>
            {model ?? 'Choose a model'}
          </Text>
          <MaterialCommunityIcons name="chevron-down" size={16} color={theme.textMuted} />
        </Pressable>
        <Pressable
          style={styles.iconBtn}
          onPress={() => {
            setMessages([]);
            setStreamed('');
          }}
          accessibilityLabel="New chat"
          accessibilityRole="button"
        >
          <MaterialCommunityIcons name="plus" size={20} color={theme.textMuted} />
        </Pressable>
      </View>

      <FlatList
        ref={list}
        data={rendered}
        keyExtractor={(_, index) => String(index)}
        contentContainerStyle={styles.messages}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <EmptyState
            icon="chat-processing-outline"
            title="Ask anything"
            body="Messages go through your gateway, so the model, the routing and the logging are the ones you configured on this phone."
          />
        }
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.role === 'user' ? styles.userBubble : styles.assistantBubble]}>
            <Text style={item.role === 'user' ? styles.userText : styles.assistantText} selectable>
              {item.content}
            </Text>
          </View>
        )}
      />

      {streaming ? (
        <View style={styles.streamingRow}>
          <ActivityIndicator size="small" color={theme.accent} />
          <Text style={styles.streamingText}>Streaming…</Text>
          <Button label="Stop" variant="secondary" icon="stop" onPress={stop} style={styles.stopBtn} />
        </View>
      ) : null}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Message your gateway…"
          placeholderTextColor={theme.textMuted}
          multiline
          editable={!streaming}
          onSubmitEditing={send}
        />
        <Pressable
          style={[styles.sendBtn, (streaming || !input.trim()) && styles.sendDisabled]}
          onPress={send}
          disabled={streaming || !input.trim()}
          accessibilityRole="button"
          accessibilityLabel="Send"
        >
          <MaterialCommunityIcons name="send" size={20} color="#0b0f1a" />
        </Pressable>
      </View>

      <Sheet
        visible={modelSheet}
        onClose={() => setModelSheet(false)}
        title="Model"
        subtitle="Only providers you have connected are listed."
        fullHeight
      >
        {models.length ? (
          models.map((entry) => (
            <Pressable
              key={entry.id}
              onPress={() => {
                setModel(entry.id);
                setModelSheet(false);
              }}
              style={styles.modelRow}
            >
              <View style={styles.modelRowText}>
                <Text style={styles.modelRowTitle} numberOfLines={1}>
                  {entry.name}
                </Text>
                <Text style={styles.modelRowSub} numberOfLines={1}>
                  {titleCase(entry.provider || 'unknown')} · {entry.id}
                </Text>
              </View>
              {model === entry.id ? (
                <MaterialCommunityIcons name="check-circle" size={18} color={theme.success} />
              ) : null}
            </Pressable>
          ))
        ) : (
          <EmptyState
            icon="robot-confused-outline"
            title="No connected models"
            body="Connect a provider on the Providers screen, then reopen this list."
            action={<Button label="Go to Providers" onPress={() => router.push('/(tabs)/providers')} />}
          />
        )}
      </Sheet>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  modelBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  modelName: { color: theme.text, fontSize: 13, fontWeight: '600', flex: 1 },
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  messages: { padding: 14, gap: 10, paddingBottom: 24, flexGrow: 1 },
  bubble: { borderRadius: 16, paddingHorizontal: 13, paddingVertical: 10, maxWidth: '92%' },
  userBubble: { alignSelf: 'flex-end', backgroundColor: theme.accent },
  assistantBubble: {
    alignSelf: 'flex-start',
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
  },
  userText: { color: '#0b0f1a', fontSize: 14, lineHeight: 20, fontWeight: '600' },
  assistantText: { color: theme.text, fontSize: 14, lineHeight: 20 },
  streamingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingBottom: 6 },
  streamingText: { color: theme.textMuted, fontSize: 12, flex: 1 },
  stopBtn: { paddingVertical: 7, paddingHorizontal: 12 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    backgroundColor: theme.tabBarBg,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 16,
    color: theme.text,
    fontSize: 14,
    paddingHorizontal: 13,
    paddingTop: 11,
    paddingBottom: 11,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { opacity: 0.4 },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: 4,
  },
  modelRowText: { flex: 1, gap: 2 },
  modelRowTitle: { color: theme.text, fontSize: 14, fontWeight: '600' },
  modelRowSub: { color: theme.textMuted, fontSize: 11 },
});
