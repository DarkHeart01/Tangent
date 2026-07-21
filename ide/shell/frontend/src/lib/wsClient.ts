// Connects to a single session's raw WS event stream, orders/dedupes by
// seq, and fans out to subscribers. One SessionWsClient == one WS
// connection == one session_id.
//
// Dedup strategy: the server always replays the full event log (seq 0..N)
// to a freshly (re)connected socket before switching to live delivery
// (see Session.Subscribe on the Go side), and within a single connection
// events always arrive in strictly increasing seq order. So a simple
// high-watermark check — drop anything at or below the highest seq already
// seen — is sufficient to make reconnects duplicate-free and drop-free.
import type { AnyEnvelope, EventPayloadMap, EventType } from "./contract";

export type ConnectionStatus = "connecting" | "open" | "closed";

type EnvelopeListener = (envelope: AnyEnvelope) => void;
type StatusListener = (status: ConnectionStatus) => void;

export class SessionWsClient {
  private socket: WebSocket | null = null;
  private lastSeq = -1;
  // Buffered so components that mount after some events already arrived
  // (e.g. switching tabs) can replay from the start instead of missing them.
  private history: AnyEnvelope[] = [];
  private listeners = new Set<EnvelopeListener>();
  private statusListeners = new Set<StatusListener>();
  private closed = false;
  private _status: ConnectionStatus = "connecting";

  constructor(private readonly url: string) {
    this.open();
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  private setStatus(status: ConnectionStatus) {
    this._status = status;
    for (const l of this.statusListeners) l(status);
  }

  private open() {
    if (this.closed) return;
    this.setStatus("connecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.onopen = () => this.setStatus("open");
    socket.onclose = () => this.setStatus("closed");
    socket.onerror = () => {
      /* onclose follows; surfaced via status */
    };
    socket.onmessage = (ev) => this.handleMessage(ev);
  }

  private handleMessage(ev: MessageEvent) {
    let envelope: AnyEnvelope;
    try {
      envelope = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (typeof envelope.seq !== "number" || envelope.seq <= this.lastSeq) {
      return; // already delivered in a prior connection's replay
    }
    this.lastSeq = envelope.seq;
    this.history.push(envelope);
    for (const l of this.listeners) l(envelope);
  }

  /**
   * Subscribe to every envelope, in order. Immediately replays everything
   * seen so far (synchronously, before returning) so a listener attached
   * mid-session — e.g. a panel mounted after switching tabs — never misses
   * history. Returns an unsubscribe fn.
   */
  subscribe(listener: EnvelopeListener): () => void {
    for (const env of this.history) listener(env);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Close and open a brand-new socket; the server replays full history. */
  reconnect() {
    this.socket?.close();
    this.open();
  }

  /** Send a control frame to the session stream when the backend supports it. */
  send(payload: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }

  close() {
    this.closed = true;
    this.socket?.close();
  }
}

/** Type-safe dispatch by event type, layered on subscribe(). */
export function onEnvelopeType<K extends EventType>(
  client: SessionWsClient,
  type: K,
  cb: (payload: EventPayloadMap[K], envelope: AnyEnvelope) => void,
): () => void {
  return client.subscribe((env) => {
    if (env.type === type) cb(env.payload as EventPayloadMap[K], env);
  });
}
