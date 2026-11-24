interface TauriCore {
  invoke<T>(command: string, arguments_?: Record<string, unknown>): Promise<T>;
}

declare global {
  interface Window {
    __TAURI__?: { core?: TauriCore };
  }
}

export function saveNativeReport(fileName: string, contents: string): Promise<string> | null {
  const invoke = window.__TAURI__?.core?.invoke;
  return invoke ? invoke<string>('save_report', { fileName, contents }) : null;
}
