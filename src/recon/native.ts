import type { ReconEvent } from './model';
import type { NormalizedTarget } from './target';

export function nativeReconAvailable(): boolean {
  return Boolean(window.__TAURI__?.core?.invoke && window.__TAURI__?.core?.Channel);
}

export async function startNativeRecon(jobId: string, target: string, onEvent: (event: ReconEvent) => void): Promise<NormalizedTarget> {
  const core = window.__TAURI__?.core;
  if (!core?.invoke || !core.Channel) throw new Error('Native RECON is available in the Spectre desktop application. Browser preview supports only the explicit fixture.');
  const channel = new core.Channel<ReconEvent>();
  channel.onmessage = onEvent;
  return core.invoke<NormalizedTarget>('start_recon', { jobId, target, onEvent: channel });
}

export async function cancelNativeRecon(jobId: string): Promise<boolean> {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return false;
  return invoke<boolean>('cancel_recon', { jobId });
}

