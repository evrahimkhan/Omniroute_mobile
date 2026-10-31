import { Api } from './client';

export async function startOAuthFlow(authUrl: string, redirectUrl: string = 'omniroute://oauth-callback'): Promise<{ token?: string; code?: string } | null> {
  try {
    // Dynamic import to bypass static tsc check on optional native modules in non-Expo environments
    // @ts-ignore
    const WebBrowser = await import(/* @vite-ignore */ 'expo-web-browser').catch(() => null);
    if (!WebBrowser) {
      console.warn('expo-web-browser not available');
      return null;
    }
    const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUrl);
    if (result.type === 'success' && result.url) {
      const urlObj = new URL(result.url);
      const token = urlObj.searchParams.get('token') || urlObj.searchParams.get('access_token');
      const code = urlObj.searchParams.get('code');
      return { token: token || undefined, code: code || undefined };
    }
    return null;
  } catch (err) {
    console.error('OAuth flow error:', err);
    return null;
  }
}
