/**
 * MutationObserver helpers shared by claude.ts and chatgpt.ts. Keeps the
 * "wait for an element to appear, then settle" pattern in one place so both
 * surfaces benefit from the same retry / debounce semantics.
 */

export interface WaitForOpts {
  /** ms to wait before giving up. 0 = infinite. */
  timeoutMs?: number;
  /** Polling interval if MutationObserver isn't suitable. */
  pollMs?: number;
  /** Root to observe. Defaults to document. */
  root?: ParentNode;
}

/**
 * Returns a Promise that resolves with the first element matching `selectorFn`,
 * or null on timeout. Uses MutationObserver if possible; falls back to setInterval
 * (some single-page-app surfaces re-render via React's reconciler and don't always
 * trigger childList mutations on the observed root).
 */
export function waitFor<T extends Element>(
  selectorFn: (root: ParentNode) => T | null,
  opts: WaitForOpts = {},
): Promise<T | null> {
  const { timeoutMs = 10_000, pollMs = 100, root = document } = opts;
  return new Promise((resolve) => {
    const start = Date.now();
    const found = selectorFn(root);
    if (found) return resolve(found);

    let done = false;
    const finish = (el: T | null) => {
      if (done) return;
      done = true;
      obs.disconnect();
      clearInterval(poll);
      resolve(el);
    };

    const obs = new MutationObserver(() => {
      const el = selectorFn(root);
      if (el) finish(el);
    });
    obs.observe(root as Node, { childList: true, subtree: true });

    const poll = setInterval(() => {
      const el = selectorFn(root);
      if (el) return finish(el);
      if (timeoutMs > 0 && Date.now() - start > timeoutMs) finish(null);
    }, pollMs);
  });
}

/**
 * Observe `root` and fire `onSettle` ms after the LAST mutation. Used to detect
 * "the assistant finished streaming" — when no new mutations have happened for
 * `quietMs`, we consider the response complete. Returns a dispose function.
 */
export function debounceSettle(
  root: Node,
  quietMs: number,
  onSettle: () => void,
): () => void {
  let timer: number | null = null;
  const obs = new MutationObserver(() => {
    if (timer !== null) clearTimeout(timer);
    timer = window.setTimeout(() => onSettle(), quietMs);
  });
  obs.observe(root, { childList: true, subtree: true, characterData: true });
  return () => {
    obs.disconnect();
    if (timer !== null) clearTimeout(timer);
  };
}

/**
 * Hash a string to a stable short ID — used for conversation_id when the page
 * doesn't expose one in the URL or the title. NOT cryptographic; just a
 * deterministic compact key.
 */
export function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Pull a conversation_id from the URL (preferred — it's stable). Falls back to
 * a hash of the page title if the URL has no recognizable ID. Always returns
 * something — never null — so events always carry a key the audit log can
 * group by.
 */
export function conversationIdFromUrl(url: string): string {
  // Claude: https://claude.ai/chat/<uuid>
  // ChatGPT: https://chatgpt.com/c/<uuid>  OR  /share/<uuid>
  const m = url.match(/\/(?:chat|c|share)\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return "untitled-" + shortHash(document.title || url);
}
