export interface TabState {
  readonly tabId?: number;
  readonly title?: string;
  readonly url?: string;
  readonly demoSite: boolean;
  readonly recording: boolean;
  readonly eventCount: number;
  readonly sessionId?: string;
  readonly grant?: Record<string, unknown>;
  readonly lastRun?: Record<string, unknown>;
}

export interface PageCapture {
  readonly text: string;
  readonly title?: string;
  readonly origin?: string;
  readonly url?: string;
  readonly characters: number;
  readonly source?: string;
  readonly truncated?: boolean;
  readonly warning?: string;
}
