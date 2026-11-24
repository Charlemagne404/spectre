import type { WorkspaceProps as BlackboxWorkspaceProps } from '../blackbox/Workspace';
import { Workspace as BlackboxWorkspace } from '../blackbox/Workspace';
import type { ReconWorkspaceProps } from '../recon/Workspace';
import { ReconWorkspace } from '../recon/Workspace';
import type { ModuleId } from './registry';

export function ModuleHost({ moduleId, blackbox, recon }: {
  moduleId: ModuleId;
  blackbox: BlackboxWorkspaceProps;
  recon: ReconWorkspaceProps;
}) {
  switch (moduleId) {
    case 'blackbox': return <BlackboxWorkspace {...blackbox} />;
    case 'recon': return <ReconWorkspace {...recon} />;
    case 'atlas':
    case 'ghost': return null;
  }
}
