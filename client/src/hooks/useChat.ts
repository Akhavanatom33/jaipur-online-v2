import { useCallback, useEffect, useState } from 'react';
import type { ChatMessage } from '../../../shared/types.ts';
import { api, socket } from '../net/socket.ts';

/**
 * Room chat. History arrives from the server when you (re)join a room; new
 * messages are pushed to everybody in the room, including the sender.
 */
export function useChat(roomId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    setMessages([]);
    const onHistory = (list: ChatMessage[]) => setMessages(list);
    const onMessage = (m: ChatMessage) => setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m].slice(-100)));
    socket.on('chat:history', onHistory);
    socket.on('chat:message', onMessage);
    return () => { socket.off('chat:history', onHistory); socket.off('chat:message', onMessage); };
  }, [roomId]);

  const send = useCallback(async (text: string): Promise<string | null> => {
    const clean = text.trim();
    if (!clean) return null;
    const res = await api.chat(clean);
    return res.ok ? null : res.error;
  }, []);

  return { messages, send };
}
