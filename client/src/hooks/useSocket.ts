import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL, refreshAccessToken, session } from '../api/client';

type Handlers = Record<string, (payload: any) => void>;

/**
 * Connects an authenticated staff socket (or a customer order-tracking socket) and
 * re-subscribes handlers. The server places sockets only in rooms of their own tenant.
 *
 * Staff sockets read the CURRENT access token on every (re)connect. If the server refuses it (the
 * 15-minute token expired while the screen sat idle), the token is refreshed and the socket reconnects;
 * socket.io does not retry middleware rejections by itself, so without this a kitchen screen silently
 * stopped receiving orders after its first network blip.
 * A `reconnect` handler, if given, runs after every reconnection so pages can re-fetch what they missed.
 */
export function useSocket(handlers: Handlers, opts: { orderId?: string; trackingToken?: string; enabled?: boolean; onConnect?: (s: Socket) => void } = {}) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const [connected, setConnected] = useState(false);
  const enabled = opts.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    const isStaff = !opts.orderId;
    const auth = isStaff
      ? (cb: (data: object) => void) => cb({ token: session.token })
      : { orderId: opts.orderId, trackingToken: opts.trackingToken };
    const s = io(API_URL || undefined, { path: '/socket.io', auth, transports: ['websocket', 'polling'], withCredentials: true });
    let closed = false;
    let everConnected = false;
    let authRetries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    s.on('connect', () => {
      setConnected(true);
      authRetries = 0;
      opts.onConnect?.(s);
      if (everConnected) ref.current.reconnect?.(undefined);
      everConnected = true;
    });
    s.on('disconnect', (reason) => {
      setConnected(false);
      // The server closes sockets when access is revoked; socket.io never reconnects those on its own.
      // Try once: a revoked user is refused (and the refresh fails), anyone else re-joins with a fresh token.
      if (reason === 'io server disconnect' && isStaff && !closed) s.connect();
    });
    s.on('connect_error', async (err) => {
      setConnected(false);
      // Middleware rejection (not a network error): renew the token, then reconnect with back-off.
      if (!isStaff || err?.message !== 'unauthorized' || closed || authRetries >= 5) return;
      authRetries++;
      const ok = await refreshAccessToken();
      if (closed || !ok) return; // session really ended; the next API call shows the sign-in screen
      retryTimer = setTimeout(() => !closed && s.connect(), Math.min(30_000, 1000 * 2 ** (authRetries - 1)));
    });
    s.onAny((event, payload) => ref.current[event]?.(payload));
    return () => {
      closed = true;
      clearTimeout(retryTimer);
      s.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, opts.orderId, opts.trackingToken]);

  return { connected };
}

/** Short beep for new-order alerts (no audio asset needed). */
export function beep(freq = 880, ms = 180) {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
    o.start();
    o.stop(ctx.currentTime + ms / 1000);
    setTimeout(() => ctx.close(), ms + 100);
  } catch {
    /* audio blocked until user interaction — visual alert still shows */
  }
}
