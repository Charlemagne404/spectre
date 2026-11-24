import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { InfrastructureGraph } from '../src/recon/InfrastructureGraph';
import type { ReconEntity, ReconRelationship } from '../src/recon/model';
import '../src/styles.css';

declare global {
  interface Window {
    __graphStartedAt: number;
    __graphRenderMs?: number;
  }
}

const count = Math.max(1, Math.min(2_000, Number(new URLSearchParams(location.search).get('nodes')) || 20));
const rootId = 'domain:benchmark.example.com';
const entities: ReconEntity[] = [
  { id: rootId, kind: 'domain', label: 'benchmark.example.com', attributes: { scope: 'syntheticTestOnly' } },
];
for (let index = 1; index < count; index++) {
  const kind = index % 20 === 0 ? 'asn' : index % 5 === 0 ? 'ip' : 'hostname';
  const label = kind === 'asn' ? `AS${64500 + index}` : kind === 'ip' ? `198.51.${Math.floor(index / 254)}.${index % 254 + 1}` : `node-${index}.benchmark.example.com`;
  entities.push({ id: `${kind}:${label}`, kind, label, attributes: { generated: true } });
}
const relationships: ReconRelationship[] = entities.slice(1).map((entity, index) => ({
  id: `relation:${index}`,
  from: index === 0 ? rootId : entities[index].id,
  to: entity.id,
  kind: entity.kind === 'asn' ? 'announcedBy' : 'resolvesTo',
  label: entity.kind === 'asn' ? 'announced by' : 'resolves to',
  evidenceIds: [],
}));

function Harness() {
  useEffect(() => {
    let frame = 0;
    const check = () => {
      const canvas = document.querySelector('canvas');
      if (canvas && canvas.width > 0) {
        frame = requestAnimationFrame(() => requestAnimationFrame(() => {
          window.__graphRenderMs = performance.now() - window.__graphStartedAt;
          document.documentElement.dataset.graphReady = 'true';
        }));
        return;
      }
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <main style={{ width: '100vw', height: '100vh', background: '#090909' }}>
    <div className="recon-graph-region" style={{ width: '100%', height: '100%', minHeight: 240 }}>
      <InfrastructureGraph entities={entities} relationships={relationships} selection={null} onSelect={() => undefined} fitVersion={0} />
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Harness />);
