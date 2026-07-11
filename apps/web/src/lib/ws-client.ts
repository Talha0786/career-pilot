'use client';

import { useEffect, useRef } from 'react';
import type { JobEmbeddedEvent } from '@careerpilot/contracts';

/**
 * Opens `/ws` (proxied to the API, same origin — see next.config.ts) and
 * calls `onEvent` for every `job.embedded` push. This is the entire
 * mechanism behind M2's headline claim: a pasted job flips from pending to
 * ready with zero page refresh.
 */
export function useJobEmbeddedSocket(onEvent: (event: JobEmbeddedEvent) => void): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data as string) as JobEmbeddedEvent;
        if (event.type === 'job.embedded') onEventRef.current(event);
      } catch {
        // Malformed push — ignore rather than crash the board.
      }
    };

    return () => socket.close();
  }, []);
}
