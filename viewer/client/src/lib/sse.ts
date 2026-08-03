// The single SSE connection to the console. Phase 1 uses it only to prove the
// stream reaches the client through the dev proxy; Phase 2 fans its 15 event names
// out into TanStack Query invalidations. Browser-native reconnect + the server's
// Last-Event-ID replay are relied on — no hand-rolled retry.

export type SseStatus = 'connecting' | 'open' | 'closed';

export function openStream(handlers: {
  onStatus?: (s: SseStatus) => void;
  onEvent?: (name: string, data: unknown) => void;
}): () => void {
  const source = new EventSource('/events');
  handlers.onStatus?.('connecting');

  source.onopen = () => handlers.onStatus?.('open');
  source.onerror = () => handlers.onStatus?.(source.readyState === source.CLOSED ? 'closed' : 'connecting');

  // The server names its events; `message` is only the unnamed `hello` frame.
  const names = [
    'hello', 'changed', 'warm', 'health', 'approval', 'approval:resolved',
    'notification', 'notification:delivery', 'notification:read', 'notification:cleared',
    'run:run', 'run:phase', 'run:stream', 'run:journal', 'run:verify', 'run:state',
  ];
  for (const name of names) {
    source.addEventListener(name, (ev) => {
      let data: unknown = null;
      try { data = JSON.parse((ev as MessageEvent).data); } catch { /* keep null */ }
      handlers.onEvent?.(name, data);
    });
  }

  return () => source.close();
}
