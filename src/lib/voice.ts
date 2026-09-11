/**
 * Live voice session against AssemblyAI's Voice Agent API.
 *
 * The page never sees the API key: it asks the backend for a 60-second token
 * and connects straight to wss://agents.assemblyai.com/v1/ws. Audio is mono
 * PCM16 at 24 kHz, base64 inside JSON frames, both directions.
 */

export type VoiceStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'error'

export interface VoiceCallbacks {
  onStatus: (status: VoiceStatus, detail?: string) => void
  onUser: (text: string) => void
  onUserFinal: (text: string) => void
  onAgentDelta: (delta: string, replyId?: string) => void
  onAgentFinal: (text: string, replyId?: string) => void
  /** Runs a client-side tool call and resolves its result. */
  onTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

const WIRE_RATE = 24_000

/** Resamples mic input to WIRE_RATE mono PCM16 and posts buffers to the main thread. */
const CAPTURE_WORKLET = `
  class CaptureProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this._ratio = sampleRate / ${WIRE_RATE};
      this._pos = 0;
      this._prev = 0;
      this._src = null;
      this._out = null;
    }
    _toPcm(samples, len) {
      const pcm = new Int16Array(len);
      for (let i = 0; i < len; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return pcm;
    }
    process(inputs) {
      const ch = inputs[0]?.[0];
      if (!ch) return true;
      if (this._ratio === 1) {
        const pcm = this._toPcm(ch, ch.length);
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        return true;
      }
      const n = ch.length;
      if (!this._src || this._src.length < n + 1) {
        this._src = new Float32Array(n + 1);
        this._out = new Float32Array(Math.ceil((n + 1) / this._ratio) + 2);
      }
      const src = this._src;
      const out = this._out;
      src[0] = this._prev;
      src.set(ch, 1);
      let outLen = 0;
      let pos = this._pos;
      while (pos < n) {
        const i = Math.floor(pos);
        const frac = pos - i;
        out[outLen++] = src[i] + (src[i + 1] - src[i]) * frac;
        pos += this._ratio;
      }
      this._pos = pos - n;
      this._prev = ch[n - 1];
      if (outLen) {
        const pcm = this._toPcm(out, outLen);
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
      }
      return true;
    }
  }
  registerProcessor('casa-capture', CaptureProcessor);
`

/** Ring buffer so streamed chunks play gaplessly; 'stop' empties it for barge-in. */
const PLAYBACK_WORKLET = `
  class PlaybackProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this._ring = new Float32Array(sampleRate * 30);
      this._writePos = 0;
      this._readPos = 0;
      this._available = 0;
      this._step = ${WIRE_RATE} / sampleRate;
      this._rsPos = 0;
      this._rsPrev = 0;
      this._drained = false;
      this.port.onmessage = (e) => {
        if (e.data === 'stop') {
          this._writePos = this._readPos = this._available = 0;
          this._rsPos = this._rsPrev = 0;
          return;
        }
        const int16 = new Int16Array(e.data);
        if (!int16.length) return;
        if (this._drained) {
          this._rsPrev = 0;
          this._rsPos = 0;
          this._drained = false;
        }
        if (this._step === 1) {
          for (let i = 0; i < int16.length; i++) this._push(int16[i] / 32768);
          return;
        }
        const n = int16.length;
        let pos = this._rsPos;
        while (pos < n) {
          const i = Math.floor(pos);
          const frac = pos - i;
          const a = i === 0 ? this._rsPrev : int16[i - 1] / 32768;
          const b = int16[i] / 32768;
          this._push(a + (b - a) * frac);
          pos += this._step;
        }
        this._rsPos = pos - n;
        this._rsPrev = int16[n - 1] / 32768;
      };
    }
    _push(v) {
      if (this._available < this._ring.length) {
        this._ring[this._writePos] = v;
        this._writePos = (this._writePos + 1) % this._ring.length;
        this._available++;
      }
    }
    process(inputs, outputs) {
      const output = outputs[0];
      const out = output[0];
      const cap = this._ring.length;
      for (let i = 0; i < out.length; i++) {
        if (this._available > 0) {
          out[i] = this._ring[this._readPos];
          this._readPos = (this._readPos + 1) % cap;
          this._available--;
        } else {
          out[i] = 0;
          this._drained = true;
        }
      }
      for (let ch = 1; ch < output.length; ch++) output[ch].set(out);
      return true;
    }
  }
  registerProcessor('casa-playback', PlaybackProcessor);
`

const blobUrl = (code: string) =>
  URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))

function bytesToB64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)))
  }
  return btoa(binary)
}

function b64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

export interface VoiceSessionHandle {
  start: () => Promise<void>
  stop: () => void
}

export function createVoiceSession(cb: VoiceCallbacks): VoiceSessionHandle {
  let ws: WebSocket | null = null
  let captureCtx: AudioContext | null = null
  let playbackCtx: AudioContext | null = null
  let playbackNode: AudioWorkletNode | null = null
  let micStream: MediaStream | null = null
  let ready = false
  let lastEvent: string | null = null
  let pending: { call_id: string; result: unknown }[] = []
  let stopping = false

  const fail = (detail: string) => {
    teardown()
    cb.onStatus('error', detail)
  }

  async function addWorklet(ctx: AudioContext, code: string, name: string) {
    const url = blobUrl(code)
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    return new AudioWorkletNode(ctx, name)
  }

  function flushIfIdle() {
    if (lastEvent !== 'reply.done' || pending.length === 0 || !ws || ws.readyState !== WebSocket.OPEN) return
    for (const t of pending) {
      ws.send(
        JSON.stringify({
          type: 'tool.result',
          call_id: t.call_id,
          result: JSON.stringify(t.result),
        }),
      )
    }
    pending = []
  }

  function teardown() {
    ready = false
    pending = []
    lastEvent = null
    micStream?.getTracks().forEach((t) => t.stop())
    micStream = null
    void captureCtx?.close().catch(() => undefined)
    void playbackCtx?.close().catch(() => undefined)
    captureCtx = null
    playbackCtx = null
    playbackNode = null
  }

  async function start() {
    if (ws) return
    cb.onStatus('connecting')
    stopping = false
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        return fail('this browser has no microphone support')
      }
      const res = await fetch('/api/token')
      if (!res.ok) {
        return fail(res.status === 503 ? 'voice backend not running' : 'token request failed')
      }
      const { token, agent_id } = (await res.json()) as { token: string; agent_id: string }

      captureCtx = new AudioContext({ sampleRate: WIRE_RATE })
      playbackCtx = new AudioContext({ sampleRate: WIRE_RATE })
      await Promise.all([captureCtx.resume(), playbackCtx.resume()])

      playbackNode = await addWorklet(playbackCtx, PLAYBACK_WORKLET, 'casa-playback')
      playbackNode.connect(playbackCtx.destination)

      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
      const capture = await addWorklet(captureCtx, CAPTURE_WORKLET, 'casa-capture')
      captureCtx.createMediaStreamSource(micStream).connect(capture)
      capture.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
        if (!ready || !ws || ws.readyState !== WebSocket.OPEN) return
        ws.send(JSON.stringify({ type: 'input.audio', audio: bytesToB64(new Uint8Array(data)) }))
      }

      const url = new URL('wss://agents.assemblyai.com/v1/ws')
      url.searchParams.set('token', token)
      ws = new WebSocket(url.toString())

      ws.onopen = () => {
        ws?.send(JSON.stringify({ type: 'session.update', session: { agent_id } }))
      }

      ws.onmessage = async ({ data }) => {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(String(data)) as Record<string, unknown>
        } catch {
          return
        }
        const type = msg.type as string
        switch (type) {
          case 'session.ready':
            ready = true
            lastEvent = type
            cb.onStatus('listening')
            break
          case 'input.speech.started':
            lastEvent = type
            playbackNode?.port.postMessage('stop')
            cb.onStatus('listening')
            break
          case 'reply.started':
            lastEvent = type
            cb.onStatus('speaking')
            break
          case 'reply.audio':
            if (typeof msg.data === 'string') {
              const bytes = b64ToBytes(msg.data)
              playbackNode?.port.postMessage(bytes.buffer, [bytes.buffer])
            }
            break
          case 'reply.done':
            lastEvent = type
            cb.onStatus('listening')
            if (msg.status === 'interrupted') {
              playbackNode?.port.postMessage('stop')
              pending = []
            } else {
              flushIfIdle()
            }
            break
          case 'transcript.user.delta':
            cb.onUser(String(msg.text ?? ''))
            break
          case 'transcript.user':
            cb.onUserFinal(String(msg.text ?? ''))
            break
          case 'transcript.agent.delta':
            cb.onAgentDelta(String(msg.delta ?? ''), msg.reply_id as string | undefined)
            break
          case 'transcript.agent':
            cb.onAgentFinal(String(msg.text ?? ''), msg.reply_id as string | undefined)
            break
          case 'tool.call': {
            const callId = String(msg.call_id ?? '')
            const name = String(msg.name ?? '')
            const args = (msg.arguments ?? {}) as Record<string, unknown>
            try {
              const result = await cb.onTool(name, args)
              pending.push({ call_id: callId, result })
            } catch (error) {
              pending.push({ call_id: callId, result: { ok: false, error: String(error) } })
            }
            flushIfIdle()
            break
          }
          case 'session.error':
            cb.onStatus('error', String(msg.message ?? 'session error'))
            break
          case 'session.ended':
            ws?.close()
            break
          default:
            break
        }
      }

      ws.onclose = () => {
        if (!stopping) fail('connection to Verde closed')
        else {
          teardown()
          cb.onStatus('idle')
        }
      }
      ws.onerror = () => {
        if (!stopping) fail('could not reach Verde — check the connection')
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : 'failed to start')
    }
  }

  function stop() {
    stopping = true
    try {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'session.end' }))
    } catch {
      /* closing anyway */
    }
    window.setTimeout(() => {
      ws?.close()
      ws = null
      teardown()
      cb.onStatus('idle')
    }, 150)
  }

  return { start, stop }
}
