import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceSignal } from '../../../shared/types.ts';
import { api, socket } from '../net/socket.ts';

/**
 * Voice chat: a WebRTC audio mesh (every player talks directly to every other
 * player in the voice channel). The Worker only relays the signalling messages
 * (offer / answer / ICE candidates) over the existing WebSocket; audio never
 * goes through the server.
 *
 * Rule that avoids offer collisions: of two seats, the LOWER seat sends the offer.
 */
const FALLBACK_ICE: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

interface Peer {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  analyser: AnalyserNode | null;
  source: MediaStreamAudioSourceNode | null;
  pending: RTCIceCandidateInit[];
  connected: boolean;
}

export interface VoiceApi {
  supported: boolean;
  active: boolean;
  busy: boolean;
  muted: boolean;
  error: string | null;
  /** Seats currently in the voice channel (including you when active). */
  seats: number[];
  /** Seats whose audio link is up. */
  linked: number[];
  /** Seats that are talking right now. */
  speaking: number[];
  join: () => Promise<void>;
  leave: () => void;
  toggleMute: () => void;
}

export function useVoice(you: number): VoiceApi {
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof RTCPeerConnection !== 'undefined';
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seats, setSeats] = useState<number[]>([]);
  const [linked, setLinked] = useState<number[]>([]);
  const [speaking, setSpeaking] = useState<number[]>([]);
  const [retry, setRetry] = useState(0);

  const stream = useRef<MediaStream | null>(null);
  const peers = useRef(new Map<number, Peer>());
  const ice = useRef<RTCIceServer[]>(FALLBACK_ICE);
  const ctx = useRef<AudioContext | null>(null);
  const localAnalyser = useRef<AnalyserNode | null>(null);
  const activeRef = useRef(false);
  const rejoin = useRef(false);
  const youRef = useRef(you);
  youRef.current = you;

  const syncLinked = () => setLinked([...peers.current.entries()].filter(([, p]) => p.connected).map(([s]) => s).sort());

  const closePeer = useCallback((seat: number) => {
    const p = peers.current.get(seat);
    if (!p) return;
    peers.current.delete(seat);
    p.pc.onicecandidate = null; p.pc.ontrack = null; p.pc.onconnectionstatechange = null;
    try { p.pc.close(); } catch { /* ignore */ }
    try { p.source?.disconnect(); } catch { /* ignore */ }
    p.audio.srcObject = null;
    p.audio.remove();
    syncLinked();
  }, []);

  const createPeer = useCallback((seat: number): Peer => {
    closePeer(seat);
    const pc = new RTCPeerConnection({ iceServers: ice.current });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.style.display = 'none';
    document.body.appendChild(audio);
    const peer: Peer = { pc, audio, analyser: null, source: null, pending: [], connected: false };
    peers.current.set(seat, peer);

    stream.current?.getTracks().forEach((t) => pc.addTrack(t, stream.current!));
    pc.onicecandidate = (e) => api.voiceSignal(seat, { kind: 'candidate', candidate: e.candidate ? (e.candidate.toJSON() as Record<string, unknown>) : null });
    pc.ontrack = (e) => {
      const remote = e.streams[0] ?? new MediaStream([e.track]);
      audio.srcObject = remote;
      void audio.play().catch(() => { /* autoplay is allowed after the join click */ });
      if (ctx.current && !peer.analyser) {
        try {
          peer.source = ctx.current.createMediaStreamSource(remote);
          peer.analyser = ctx.current.createAnalyser();
          peer.analyser.fftSize = 512;
          peer.source.connect(peer.analyser);
        } catch { /* speaking indicator is optional */ }
      }
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      peer.connected = st === 'connected';
      syncLinked();
      if ((st === 'failed' || st === 'closed') && peers.current.get(seat) === peer) {
        closePeer(seat);
        if (activeRef.current) setTimeout(() => setRetry((n) => n + 1), 1200);
      }
    };
    return peer;
  }, [closePeer]);

  const closeAll = useCallback(() => {
    for (const seat of [...peers.current.keys()]) closePeer(seat);
  }, [closePeer]);

  // ---- who is in the channel (pushed by the server) ---------------------------
  useEffect(() => {
    const onPeers = (p: { seats: number[] }) => {
      setSeats(p.seats);
      // After a reconnect the server forgot us: join again as soon as our seat is back.
      if (rejoin.current && activeRef.current && !p.seats.includes(youRef.current)) {
        rejoin.current = false;
        void api.voiceJoin();
      }
    };
    const onDisconnect = () => { if (activeRef.current) { rejoin.current = true; closeAll(); } };
    socket.on('voice:peers', onPeers);
    socket.on('disconnect', onDisconnect);
    return () => { socket.off('voice:peers', onPeers); socket.off('disconnect', onDisconnect); };
  }, [closeAll]);

  // ---- connect to everybody in the channel ------------------------------------
  useEffect(() => {
    if (!active) return;
    for (const seat of [...peers.current.keys()]) if (!seats.includes(seat)) closePeer(seat);
    for (const seat of seats) {
      if (seat === you || peers.current.has(seat)) continue;
      if (you < seat) {
        // I am the lower seat: I send the offer.
        const peer = createPeer(seat);
        void (async () => {
          try {
            const offer = await peer.pc.createOffer();
            await peer.pc.setLocalDescription(offer);
            api.voiceSignal(seat, { kind: 'offer', sdp: offer.sdp ?? '' });
          } catch { closePeer(seat); }
        })();
      }
    }
  }, [active, seats, you, retry, createPeer, closePeer]);

  // ---- signalling from the other side ------------------------------------------
  useEffect(() => {
    const onSignal = async ({ from, data }: { from: number; data: VoiceSignal }) => {
      if (!activeRef.current || !stream.current) return;
      try {
        if (data.kind === 'offer') {
          const peer = createPeer(from);
          await peer.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          api.voiceSignal(from, { kind: 'answer', sdp: answer.sdp ?? '' });
          for (const c of peer.pending.splice(0)) await peer.pc.addIceCandidate(c).catch(() => undefined);
        } else if (data.kind === 'answer') {
          const peer = peers.current.get(from);
          if (peer && peer.pc.signalingState === 'have-local-offer') {
            await peer.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
            for (const c of peer.pending.splice(0)) await peer.pc.addIceCandidate(c).catch(() => undefined);
          }
        } else if (data.kind === 'candidate' && data.candidate) {
          const peer = peers.current.get(from);
          const cand = data.candidate as RTCIceCandidateInit;
          if (!peer) return;
          if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(cand).catch(() => undefined);
          else peer.pending.push(cand);
        }
      } catch { closePeer(from); }
    };
    socket.on('voice:signal', onSignal);
    return () => { socket.off('voice:signal', onSignal); };
  }, [createPeer, closePeer]);

  // ---- speaking indicator -------------------------------------------------------
  useEffect(() => {
    if (!active) { setSpeaking([]); return; }
    const level = (an: AnalyserNode | null) => {
      if (!an) return 0;
      const buf = new Uint8Array(an.fftSize);
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
      return Math.sqrt(sum / buf.length);
    };
    let last = '';
    const id = setInterval(() => {
      const now: number[] = [];
      if (!muted && level(localAnalyser.current) > 0.04) now.push(youRef.current);
      for (const [seat, p] of peers.current) if (level(p.analyser) > 0.04) now.push(seat);
      const key = now.sort().join(',');
      if (key !== last) { last = key; setSpeaking(now); }
    }, 180);
    return () => clearInterval(id);
  }, [active, muted]);

  const stop = useCallback(() => {
    activeRef.current = false;
    closeAll();
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    localAnalyser.current = null;
    void ctx.current?.close().catch(() => undefined);
    ctx.current = null;
    setActive(false);
    setMuted(false);
    setLinked([]);
    setSpeaking([]);
  }, [closeAll]);

  const join = useCallback(async () => {
    if (activeRef.current || busy) return;
    setError(null);
    if (!supported) { setError('Voice chat is not supported by this browser (it also needs HTTPS).'); return; }
    setBusy(true);
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      stream.current = media;
      try {
        const res = await fetch('/api/voice/ice', { credentials: 'same-origin' });
        const data = await res.json() as { ok?: boolean; iceServers?: RTCIceServer[] };
        if (data.ok && Array.isArray(data.iceServers) && data.iceServers.length) ice.current = data.iceServers;
      } catch { /* STUN fallback */ }
      try {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctx.current = new AC();
        void ctx.current.resume();
        const src = ctx.current.createMediaStreamSource(media);
        localAnalyser.current = ctx.current.createAnalyser();
        localAnalyser.current.fftSize = 512;
        src.connect(localAnalyser.current);
      } catch { /* speaking indicator is optional */ }
      const res = await api.voiceJoin();
      if (!res.ok) { stop(); setError(res.error); return; }
      activeRef.current = true;
      setActive(true);
    } catch (e) {
      stop();
      const name = (e as { name?: string })?.name;
      setError(name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in your browser and try again.'
        : name === 'NotFoundError' ? 'No microphone was found.' : 'Could not start voice chat.');
    } finally {
      setBusy(false);
    }
  }, [busy, supported, stop]);

  const leave = useCallback(() => {
    if (!activeRef.current) return;
    stop();
    void api.voiceLeave();
  }, [stop]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      stream.current?.getAudioTracks().forEach((t) => { t.enabled = !next; });
      return next;
    });
  }, []);

  // Leaving the room (component unmount) always releases the microphone.
  useEffect(() => () => {
    activeRef.current = false;
    for (const seat of [...peers.current.keys()]) closePeer(seat);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    void ctx.current?.close().catch(() => undefined);
  }, [closePeer]);

  return { supported, active, busy, muted, error, seats, linked, speaking, join, leave, toggleMute };
}
