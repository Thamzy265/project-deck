import { useCallback, useState } from 'react';

/**
 * A polite live-region message. Setting the same text again re-announces it, because a
 * counter makes each message a new node.
 */
export function useAnnounce(): {
  message: { text: string; id: number };
  announce: (text: string) => void;
} {
  const [message, setMessage] = useState({ text: '', id: 0 });
  const announce = useCallback((text: string) => setMessage((m) => ({ text, id: m.id + 1 })), []);
  return { message, announce };
}
