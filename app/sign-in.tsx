import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import ScreenHeader from '../components/ScreenHeader';
import { Button, Card, Field, ListRow, Loading, Screen, SectionHeader } from '../components/ui/kit';
import { useToast } from '../components/ui/Toast';
import { describeError, useApiContext } from '../lib/api/context';
import { explainAuthFailure } from '../lib/api/auth';
import { ApiError } from '../lib/api/client';
import { checkGateway, hostOf, type GatewayStatus } from '../lib/gateway';
import { isLoopbackAddress } from '../lib/serverUrl';
import { useSettings } from '../lib/useSettings';
import { theme } from '../lib/theme';

/**
 * Signing in to the gateway, natively.
 *
 * A local gateway in bootstrap mode needs no session — loopback requests are
 * trusted, and that is the normal case on this phone. This screen exists for the
 * other case: a management password has been set, and the app has to hold a
 * dashboard session the way the browser did with a cookie. React Native has no
 * cookie jar, so the cookie from the login response is captured and replayed
 * (see lib/api/auth.ts).
 *
 * The screen asks the gateway directly rather than reasoning from the stored
 * session. `authenticated` has three states — signed in, asked-for-a-session, and
 * *unknown* — and an earlier version of this file collapsed "unknown" into
 * "answering, nothing to do", which made it print a green all-clear about a
 * gateway that was not running and hide the form behind it. A screen that can only
 * say "yes" or "no" about something with three answers is the same mistake as a
 * 404 meaning "signed in", so it probes `/api/health` and reports what it got.
 */
export default function SignInScreen() {
  const { api, session } = useApiContext();
  const { settings } = useSettings();
  const { showToast } = useToast();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<GatewayStatus | null>(null);
  const [probing, setProbing] = useState(true);

  const serverUrl = settings.serverUrl;

  // Held in a ref, not a dependency: `session` is a fresh object on every context
  // update, so depending on it would make `ask` change identity every time a probe
  // finishes — and the effect that calls `ask` would fire again, forever. The
  // screen would quietly hammer the gateway instead of asking it once.
  const refreshRef = useRef(session.refresh);
  refreshRef.current = session.refresh;

  const ask = useCallback(async () => {
    setProbing(true);
    // Both questions, in parallel: "is anything serving the API there" and "does
    // it recognise this client's session". Either can be answered without the
    // other, and the screen needs both to say anything true.
    const [status] = await Promise.all([checkGateway(serverUrl), refreshRef.current()]);
    setProbe(status);
    setProbing(false);
  }, [serverUrl]);

  useEffect(() => {
    void ask();
  }, [ask]);

  const submit = async () => {
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await session.signIn(password);
      setPassword('');
      showToast('Signed in — the session is kept on this device', 'ok');
    } catch (err) {
      setError(
        err instanceof ApiError && (err.status === 401 || err.status === 403)
          ? 'That password was not accepted.'
          : describeError(err)
      );
    } finally {
      setBusy(false);
    }
  };

  const status = session.authenticated;
  const local = isLoopbackAddress(serverUrl);
  const reached = Boolean(probe?.ok);
  const website = probe?.kind === 'website';
  const nothingThere = !reached && !website;

  // The card that answers "what is the state of signing in", in the three states
  // the gateway can actually be in. `null` is its own answer, not a friendly one.
  type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  let headline: { icon: IconName; color: string; title: string; subtitle: string };
  if (probing && !probe) {
    headline = {
      icon: 'shield-check-outline',
      color: theme.textMuted,
      title: 'Asking the gateway…',
      subtitle: `Checking ${serverUrl || 'the configured address'}`,
    };
  } else if (nothingThere) {
    headline = {
      icon: 'lan-disconnect',
      color: theme.danger,
      title: `Nothing is answering at ${hostOf(serverUrl)}`,
      subtitle: local
        ? 'No gateway is serving this phone yet. Sign-in needs a gateway to talk to, so start one first.'
        : `The app tried ${serverUrl} and got no answer. Check that the gateway is running and that this phone can reach it.`,
    };
  } else if (website) {
    headline = {
      icon: 'lan-disconnect',
      color: theme.danger,
      title: `${hostOf(serverUrl)} is a website, not a gateway`,
      subtitle: 'A website answers every path with its own pages, so it can never sign anyone in. Point the app at the gateway API instead.',
    };
  } else if (status === false) {
    headline = {
      icon: 'lock-outline',
      color: '#f5a524',
      title: 'A session is needed',
      subtitle: 'This gateway has a management password. Enter it below to hold a session on this device.',
    };
  } else if (status === true) {
    headline = {
      icon: 'shield-check-outline',
      color: theme.success,
      title: 'Signed in',
      subtitle: 'This app holds a session on the gateway, so the dashboard screens are already working.',
    };
  } else {
    headline = {
      icon: 'shield-off-outline',
      color: theme.success,
      title: 'Answering, and no session is required',
      subtitle: 'A local gateway trusts requests from this phone; it did not ask for a password. If one is set later, this screen is where it goes.',
    };
  }

  // The form is offered whenever a password could be in play — including when the
  // session state is unknown, which used to hide it. Signing in is not something
  // to guess one's way out of.
  const showForm = reached && !website;

  return (
    <View style={styles.root}>
      <ScreenHeader title="Dashboard session" subtitle={hostOf(serverUrl)} />
      <Screen scroll>
        <View style={styles.banner}>
          <MaterialCommunityIcons name={headline.icon} size={22} color={headline.color} />
          <View style={styles.bannerTextWrap}>
            <Text style={styles.bannerTitle}>{headline.title}</Text>
            <Text style={styles.bannerText}>{headline.subtitle}</Text>
          </View>
        </View>

        {(probing || nothingThere || website) && (
          <Card>
            <View style={styles.cardBody}>
              {probing && !probe ? (
                <Loading label="Checking the gateway…" />
              ) : (
                <>
                  <Text style={styles.note}>{probe?.detail ?? (website ? 'That address serves web pages.' : 'No answer.')}</Text>
                  <View style={styles.row}>
                    <Button label="Try again" icon="refresh" variant="secondary" onPress={() => void ask()} style={styles.flex} />
                    <Button
                      label={local ? 'Gateway on this phone' : 'Gateway settings'}
                      icon={local ? 'cellphone-link' : 'cog-outline'}
                      onPress={() => router.push('/settings')}
                      style={styles.flex}
                    />
                  </View>
                </>
              )}
            </View>
          </Card>
        )}

        {showForm && (
          <>
            <SectionHeader title="SIGN IN" />
            <Card>
              <View style={styles.cardBody}>
                <Field
                  label="Management password"
                  value={password}
                  onChange={setPassword}
                  secure
                  placeholder="The password set on the gateway"
                  hint="Sent to your gateway only — over loopback it never leaves the phone."
                />
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <Button label="Sign in" icon="login" loading={busy} onPress={submit} disabled={!api} />
                {session.cookie ? (
                  <Button
                    label="Sign out of this gateway"
                    icon="logout"
                    variant="ghost"
                    onPress={async () => {
                      await session.signOut();
                      showToast('Signed out', 'ok');
                      void ask();
                    }}
                  />
                ) : null}
              </View>
            </Card>
            {status === null && (
              <Text style={styles.note}>
                The gateway answered but this app could not read its session state — usually an older gateway without
                that route. Signing in here is harmless if no password is set.
              </Text>
            )}
            <Text style={styles.note}>{explainAuthFailure(401, hostOf(serverUrl))}</Text>
          </>
        )}

        <SectionHeader title="IF SIGNING IN FAILS" />
        <Card>
          <ListRow
            icon="information-outline"
            title="Is the address the phone itself?"
            subtitle="Only http://127.0.0.1:8080 is trusted as local. A LAN or tunnel address is treated as a remote client and always needs credentials."
          />
          <ListRow
            icon="open-in-new"
            title="Set the password from the dashboard"
            subtitle="A gateway with no password at all cannot authenticate anyone — set one there first."
          />
        </Card>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  banner: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    marginBottom: 16,
  },
  bannerTextWrap: { flex: 1, gap: 4 },
  bannerTitle: { color: theme.text, fontSize: 15, fontWeight: '600' },
  bannerText: { color: theme.textMuted, fontSize: 13, lineHeight: 18 },
  cardBody: { gap: 12, padding: 14 },
  row: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1 },
  note: { color: theme.textMuted, fontSize: 12, lineHeight: 17, marginTop: 10 },
  error: { color: theme.danger, fontSize: 12 },
});
