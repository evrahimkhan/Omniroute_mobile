/**
 * Registry of live WebView refs so app-level actions (e.g. "Clear gateway
 * data" in Settings) can reach every mounted dashboard view.
 */

type WebViewLike = {
  clearCache?: (includeDiskFiles: boolean) => void;
  injectJavaScript?: (script: string) => void;
};

const refs = new Set<WebViewLike>();

/** Register a web view ref; returns an unregister callback. */
export function registerWebViewRef(webView: WebViewLike | null | undefined): () => void {
  if (webView) refs.add(webView);
  return () => {
    refs.delete(webView as WebViewLike);
  };
}

const CLEAR_STORAGE_SCRIPT =
  'try{localStorage.clear();sessionStorage.clear();}catch(e){}' +
  'try{if(window.indexedDB){const req=indexedDB.databases();req.then&&req.then(function(ns){ns.forEach(function(n){indexedDB.deleteDatabase(n.name);});});}}catch(e){}';

/** Clear caches + web storage across all in-app dashboards. */
export function clearWebViewData(): void {
  for (const w of refs) {
    try {
      w.injectJavaScript?.(CLEAR_STORAGE_SCRIPT);
    } catch {
      // ignore
    }
    try {
      w.clearCache?.(true);
    } catch {
      // ignore
    }
  }
}
