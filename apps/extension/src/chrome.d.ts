declare namespace chrome {
  namespace runtime {
    interface MessageSender { id?: string; tab?: tabs.Tab; frameId?: number; documentId?: string; origin?: string; url?: string; }
    interface InstalledDetails { reason: string; }
    const id: string;
    const lastError: { message?: string } | undefined;
    const onInstalled: { addListener(callback: (details: InstalledDetails) => void): void };
    const onMessage: { addListener(callback: (message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | void): void };
    function sendMessage(message: unknown): Promise<unknown>;
    function getURL(path: string): string;
    function openOptionsPage(): Promise<void>;
  }
  namespace tabs {
    interface Tab { id?: number; url?: string; title?: string; active?: boolean; windowId?: number; }
    interface TabChangeInfo { status?: 'loading' | 'complete'; url?: string; }
    function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function sendMessage(tabId: number, message: unknown, options?: { documentId?: string; frameId?: number }): Promise<unknown>;
    const onUpdated: { addListener(callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void): void };
    const onRemoved: { addListener(callback: (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void): void };
  }
  namespace scripting {
    function executeScript(details: { target: { tabId: number; frameIds?: number[] }; files: string[] }): Promise<unknown[]>;
  }
  namespace permissions {
    function request(permissions: { origins?: string[] }): Promise<boolean>;
  }
  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      setAccessLevel?(options: { accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }): Promise<void>;
    }
    const local: StorageArea;
    const session: StorageArea & { setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }): Promise<void> };
  }
  namespace sidePanel {
    function setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
  }
}
