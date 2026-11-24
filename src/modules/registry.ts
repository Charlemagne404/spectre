export type ModuleId = 'blackbox' | 'recon' | 'atlas' | 'ghost';

export interface SpectreModule {
  id: ModuleId;
  name: string;
  key: string;
  available: boolean;
  description: string;
}

export const MODULES: readonly SpectreModule[] = [
  { id: 'blackbox', name: 'BLACKBOX', key: '1', available: true, description: 'Binary analysis and file intelligence' },
  { id: 'recon', name: 'RECON', key: '2', available: true, description: 'Internet infrastructure reconnaissance' },
  { id: 'atlas', name: 'ATLAS', key: '3', available: false, description: 'Local network discovery' },
  { id: 'ghost', name: 'GHOST', key: '4', available: false, description: 'Digital identity intelligence' },
] as const;

export const AVAILABLE_MODULES = MODULES.filter((item) => item.available);

export function getModule(moduleId: ModuleId): SpectreModule {
  return MODULES.find((item) => item.id === moduleId)!;
}

export function moduleFromKey(key: string): ModuleId | undefined {
  return AVAILABLE_MODULES.find((item) => item.key === key)?.id;
}
