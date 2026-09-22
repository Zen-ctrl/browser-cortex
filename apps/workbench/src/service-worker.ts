export type WorkbenchServiceWorkerState = 'ready' | 'update-available' | 'error';

declare global {
  interface WindowEventMap {
    'browser-cortex:service-worker': CustomEvent<{ state: WorkbenchServiceWorkerState }>;
  }
}

let registration: ServiceWorkerRegistration | undefined;
let reloading = false;
let reloadOnControllerChange = false;

function announce(state: WorkbenchServiceWorkerState): void {
  window.dispatchEvent(new CustomEvent('browser-cortex:service-worker', { detail: { state } }));
}

function watchInstalling(worker: ServiceWorker | null): void {
  if (!worker) return;
  worker.addEventListener('statechange', () => {
    if (worker.state === 'installed' && navigator.serviceWorker.controller) announce('update-available');
    if (worker.state === 'activated') announce('ready');
  });
}

export async function registerWorkbenchServiceWorker(): Promise<void> {
  const loopback = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '[::1]';
  if (
    !import.meta.env.PROD
    || !('serviceWorker' in navigator)
    || (location.protocol !== 'https:' && !loopback)
  ) return;
  try {
    reloadOnControllerChange = Boolean(navigator.serviceWorker.controller);
    registration = await navigator.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' });
    if (registration.waiting) announce('update-available');
    else announce('ready');
    watchInstalling(registration.installing);
    registration.addEventListener('updatefound', () => watchInstalling(registration?.installing ?? null));
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloadOnControllerChange || reloading) {
        announce('ready');
        return;
      }
      reloading = true;
      location.reload();
    });
  } catch {
    announce('error');
  }
}

export function activateWorkbenchUpdate(): void {
  reloadOnControllerChange = true;
  registration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
}
