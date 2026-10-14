import type { SocketLike } from './connection.js';

/** The dashboard's own `/ws`, on the page's origin, so the login cookie goes with it. */
export function dashboardSocketUrl(loc: Pick<Location, 'protocol' | 'host'>): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

/** Adapts a browser WebSocket to the small interface `Connection` uses. */
export function openBrowserSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  const socket: SocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close: () => ws.close(),
  };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (event) => socket.onmessage?.({ data: event.data });
  ws.onclose = () => socket.onclose?.();
  // Every error is followed by 'close', where Connection recovers.
  ws.onerror = () => socket.onerror?.();
  return socket;
}
