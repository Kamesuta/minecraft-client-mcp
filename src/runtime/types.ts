export type ScreenshotResult = {
  screenshotPath: string;
  screenshotBase64: string;
  renderText: string;
  message: string;
  meta?: Record<string, unknown>;
};

export type RuntimeResult = {
  message: string;
  meta?: Record<string, unknown>;
};

export type BatchOperation =
  | { type: 'command'; command: string }
  | { type: 'key'; key: string };

export type BatchResult = {
  message: string;
  results: Array<{
    index: number;
    type: BatchOperation['type'];
    ok: boolean;
    message: string;
    meta?: Record<string, unknown>;
  }>;
};

export interface MinecraftClientRuntime {
  launch(): Promise<RuntimeResult>;
  logs(lines?: number): Promise<RuntimeResult>;
  connect(ip: string): Promise<RuntimeResult>;
  viewAs(player: string): Promise<ScreenshotResult>;
  viewAt(target: { x: number; y: number; z: number; yaw: number; pitch: number }): Promise<ScreenshotResult>;
  command(command: string): Promise<RuntimeResult>;
  key(key: string): Promise<RuntimeResult>;
  batchExecute(operations: BatchOperation[]): Promise<BatchResult>;
}
