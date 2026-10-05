interface WorkerWebSocket extends WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

declare class WebSocketPair {
  0: WorkerWebSocket;
  1: WorkerWebSocket;
}
