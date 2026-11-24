import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent, WheelEvent } from 'react';
import type { ReconEntity, ReconRelationship } from './model';

export interface GraphSelection {
  type: 'entity' | 'relationship';
  id: string;
}

interface Point { x: number; y: number }
interface Transform { scale: number; x: number; y: number }
interface DragState { pointerId: number; start: Point; previous: Point; nodeId: string | null; moved: boolean }

const colors: Record<string, string> = {
  domain: '#edba74', hostname: '#b7b9b3', wildcard: '#a98d65', ip: '#91a4b2', prefix: '#728c8b',
  asn: '#a1b5a7', nameserver: '#c0a679', mailhost: '#aa8d72', registrar: '#ca9862',
};

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return result >>> 0;
}

function layoutGroup(kind: string): { angle: number; radius: number; spread: number } {
  switch (kind) {
    case 'domain': return { angle: 0, radius: 0, spread: 0 };
    case 'nameserver': return { angle: -2.6, radius: 205, spread: 1.2 };
    case 'mailhost': return { angle: 2.8, radius: 210, spread: 1.1 };
    case 'ip': return { angle: -0.15, radius: 225, spread: 1.1 };
    case 'prefix': return { angle: 0.45, radius: 345, spread: .8 };
    case 'asn': return { angle: 1.05, radius: 420, spread: .9 };
    case 'registrar': return { angle: 1.9, radius: 230, spread: .8 };
    default: return { angle: -2.15, radius: 290, spread: 1.35 };
  }
}

function nodeRadius(entity: ReconEntity): number { return entity.kind === 'domain' ? 8 : entity.kind === 'asn' ? 7 : 6; }

export function InfrastructureGraph({ entities, relationships, selection, onSelect, focusEntityId, fitVersion }: {
  entities: ReconEntity[];
  relationships: ReconRelationship[];
  selection: GraphSelection | null;
  onSelect: (selection: GraphSelection | null) => void;
  focusEntityId?: string;
  fitVersion: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const positions = useRef(new Map<string, Point>());
  const transform = useRef<Transform>({ scale: .78, x: 0, y: 0 });
  const drag = useRef<DragState | null>(null);
  const redraw = useRef<() => void>(() => {});
  const zoomLabel = useRef<HTMLSpanElement>(null);
  const userAdjusted = useRef(false);
  const lastFitVersion = useRef(fitVersion);

  const fit = useCallback(() => {
    if (!host.current || !entities.length) {
      transform.current = { scale: .78, x: 0, y: 0 };
      redraw.current();
      return;
    }
    const points = entities.map((entity) => positions.current.get(entity.id)).filter((point): point is Point => Boolean(point));
    const minX = Math.min(...points.map((point) => point.x)); const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y)); const maxY = Math.max(...points.map((point) => point.y));
    const width = Math.max(300, maxX - minX + 120); const height = Math.max(240, maxY - minY + 120);
    const scale = Math.max(.24, Math.min(1.5, Math.min((host.current.clientWidth - 48) / width, (host.current.clientHeight - 48) / height)));
    transform.current = { scale, x: -(minX + maxX) / 2 * scale, y: -(minY + maxY) / 2 * scale };
    userAdjusted.current = false;
    redraw.current();
  }, [entities]);

  useEffect(() => {
    const currentPositions = positions.current;
    const existingIds = new Set(entities.map((entity) => entity.id));
    for (const id of currentPositions.keys()) if (!existingIds.has(id) && currentPositions.size > 3_000) currentPositions.delete(id);
    for (const entity of entities) {
      if (currentPositions.has(entity.id)) continue;
      if (entity.kind === 'domain') { currentPositions.set(entity.id, { x: 0, y: 0 }); continue; }
      const group = layoutGroup(entity.kind);
      const key = hash(entity.id);
      let angle = group.angle + ((key % 1000) / 1000 - .5) * group.spread;
      let radius = group.radius + ((key >>> 10) % 3) * 46;
      let point = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
      for (let attempt = 0; attempt < 18; attempt++) {
        const collision = [...currentPositions.values()].some((other) => Math.hypot(other.x - point.x, other.y - point.y) < 74);
        if (!collision) break;
        radius += 28;
        angle += (attempt % 2 === 0 ? 1 : -1) * .17;
        point = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
      }
      currentPositions.set(entity.id, point);
    }

    const element = canvas.current;
    const container = host.current;
    if (!element || !container) return;
    const context = element.getContext('2d');
    if (!context) return;
    let frame = 0;
    let width = 0;
    let height = 0;
    const selectedEdge = selection?.type === 'relationship' ? selection.id : null;
    const selectedNode = selection?.type === 'entity' ? selection.id : null;

    const draw = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        width = container.clientWidth;
        height = container.clientHeight;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        if (element.width !== Math.floor(width * dpr) || element.height !== Math.floor(height * dpr)) {
          element.width = Math.floor(width * dpr);
          element.height = Math.floor(height * dpr);
          element.style.width = `${width}px`;
          element.style.height = `${height}px`;
        }
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, width, height);
        context.fillStyle = '#090909';
        context.fillRect(0, 0, width, height);
        const { scale, x, y } = transform.current;
        const cx = width / 2 + x;
        const cy = height / 2 + y;
        context.save();
        context.translate(cx, cy);
        context.scale(scale, scale);

        context.strokeStyle = '#171715';
        context.lineWidth = 1 / scale;
        context.setLineDash([2 / scale, 7 / scale]);
        for (const radius of [180, 360, 540]) {
          context.beginPath(); context.arc(0, 0, radius, 0, Math.PI * 2); context.stroke();
        }
        context.setLineDash([]);

        const visibleIds = new Set(entities.map((entity) => entity.id));
        for (const relation of relationships) {
          if (!visibleIds.has(relation.from) || !visibleIds.has(relation.to)) continue;
          const from = currentPositions.get(relation.from);
          const to = currentPositions.get(relation.to);
          if (!from || !to) continue;
          const active = relation.id === selectedEdge
            || relation.evidenceIds.some((id) => id === selection?.id)
            || Boolean(selectedNode && (relation.from === selectedNode || relation.to === selectedNode));
          context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y);
          context.strokeStyle = active ? '#d49a4a' : '#37332c';
          context.globalAlpha = active ? .95 : .72;
          context.lineWidth = (active ? 1.8 : 1) / scale;
          if (relation.kind.startsWith('certificate')) context.setLineDash([5 / scale, 4 / scale]);
          context.stroke(); context.setLineDash([]); context.globalAlpha = 1;
        }

        const priority = [...entities].sort((left, right) => {
          const leftScore = (left.id === selectedNode ? -10 : 0) + (left.kind === 'domain' ? -8 : 0) + (left.kind === 'ip' || left.kind === 'nameserver' ? -2 : 0);
          const rightScore = (right.id === selectedNode ? -10 : 0) + (right.kind === 'domain' ? -8 : 0) + (right.kind === 'ip' || right.kind === 'nameserver' ? -2 : 0);
          return leftScore - rightScore || left.id.localeCompare(right.id);
        });
        const labelLimit = scale < .48 ? 2 : Math.max(18, Math.min(140, Math.floor(115 / scale)));
        const labels = new Set(priority.slice(0, labelLimit).map((entity) => entity.id));
        if (selectedNode) labels.add(selectedNode);

        for (const entity of entities) {
          const point = currentPositions.get(entity.id);
          if (!point) continue;
          const radius = nodeRadius(entity);
          const selected = entity.id === selectedNode;
          context.beginPath(); context.arc(point.x, point.y, (radius + (selected ? 3 : 0)) / scale, 0, Math.PI * 2);
          context.fillStyle = colors[entity.kind] ?? '#aaa9a5';
          context.globalAlpha = selected ? 1 : .88;
          context.fill();
          context.globalAlpha = 1;
          context.beginPath(); context.arc(point.x, point.y, (radius + 4) / scale, 0, Math.PI * 2);
          context.strokeStyle = selected ? '#edba74' : entity.kind === 'domain' ? '#9f7541' : '#282725';
          context.lineWidth = 1 / scale; context.stroke();
          if (labels.has(entity.id) && (scale > .46 || selected || entity.kind === 'domain')) {
            context.font = `${(entity.kind === 'domain' ? 12 : 10) / scale}px "JetBrains Mono Variable", monospace`;
            context.fillStyle = selected ? '#f0d0a0' : entity.kind === 'domain' ? '#e8e8e5' : '#a6a39a';
            context.textAlign = 'left'; context.textBaseline = 'middle';
            context.fillText(entity.label, point.x + (radius + 8) / scale, point.y, 220 / scale);
          }
        }
        context.restore();
        if (zoomLabel.current) zoomLabel.current.textContent = `${Math.round(scale * 100)}%`;
      });
    };
    redraw.current = draw;
    const observer = new ResizeObserver(() => {
      draw();
      if (entities.length && !userAdjusted.current) fit();
    });
    observer.observe(container);
    draw();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [entities, fit, relationships, selection, fitVersion]);

  useEffect(() => {
    if (!entities.length) return;
    if (lastFitVersion.current !== fitVersion) {
      lastFitVersion.current = fitVersion;
      fit();
    } else if (!userAdjusted.current) {
      fit();
    }
  }, [entities, fit, fitVersion]);

  useEffect(() => {
    if (!focusEntityId) return;
    const point = positions.current.get(focusEntityId);
    if (!point || !host.current) return;
    transform.current.x = -point.x * transform.current.scale;
    transform.current.y = -point.y * transform.current.scale;
    redraw.current();
  }, [focusEntityId]);

  const localPoint = (event: PointerEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const toWorld = (point: Point): Point => {
    const scale = transform.current.scale;
    return { x: (point.x - ((host.current?.clientWidth ?? 0) / 2 + transform.current.x)) / scale,
      y: (point.y - ((host.current?.clientHeight ?? 0) / 2 + transform.current.y)) / scale };
  };
  const findNode = (point: Point): ReconEntity | undefined => [...entities].reverse().find((entity) => {
    const location = positions.current.get(entity.id);
    return location && Math.hypot(location.x - point.x, location.y - point.y) < 16 / transform.current.scale;
  });
  const findEdge = (point: Point): ReconRelationship | undefined => relationships.find((relation) => {
    const from = positions.current.get(relation.from); const to = positions.current.get(relation.to);
    if (!from || !to) return false;
    const dx = to.x - from.x; const dy = to.y - from.y;
    const span = dx * dx + dy * dy;
    const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / span));
    return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy)) < 8 / transform.current.scale;
  });

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const screen = localPoint(event);
    const world = toWorld(screen);
    const node = findNode(world);
    drag.current = { pointerId: event.pointerId, start: screen, previous: screen, nodeId: node?.id ?? null, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const point = localPoint(event);
    const delta = { x: point.x - state.previous.x, y: point.y - state.previous.y };
    if (Math.hypot(point.x - state.start.x, point.y - state.start.y) > 3) state.moved = true;
    if (state.moved) {
      userAdjusted.current = true;
      if (state.nodeId) positions.current.set(state.nodeId, toWorld(point));
      else { transform.current.x += delta.x; transform.current.y += delta.y; }
      redraw.current();
    }
    state.previous = point;
  };
  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const point = toWorld(localPoint(event));
    if (!state.moved) {
      const node = findNode(point);
      if (node) onSelect({ type: 'entity', id: node.id });
      else {
        const edge = findEdge(point);
        onSelect(edge ? { type: 'relationship', id: edge.id } : null);
      }
    }
    drag.current = null;
  };
  const onWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    userAdjusted.current = true;
    const point = localPoint(event);
    const before = toWorld(point);
    const nextScale = Math.max(.24, Math.min(3.2, transform.current.scale * Math.exp(-event.deltaY * .0012)));
    const center = { x: (host.current?.clientWidth ?? 0) / 2, y: (host.current?.clientHeight ?? 0) / 2 };
    transform.current.scale = nextScale;
    transform.current.x = point.x - center.x - before.x * nextScale;
    transform.current.y = point.y - center.y - before.y * nextScale;
    redraw.current();
  };
  return <div className="recon-graph" ref={host}>
    <canvas ref={canvas} className="recon-graph-canvas" aria-label="Infrastructure graph. Select an entity or relationship to inspect its evidence. Use the entity navigator for keyboard access."
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { drag.current = null; }} onWheel={onWheel} />
    <div className="recon-graph-hud"><span>TOPOLOGY / OBSERVED RELATIONSHIPS</span><span ref={zoomLabel}>78%</span></div>
    <div className="recon-graph-controls">
      <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => { userAdjusted.current = true; transform.current.scale = Math.min(3.2, transform.current.scale * 1.2); redraw.current(); }}>+</button>
      <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => { userAdjusted.current = true; transform.current.scale = Math.max(.24, transform.current.scale / 1.2); redraw.current(); }}>−</button>
      <button type="button" title="Fit investigation" aria-label="Fit investigation" onClick={fit}>FIT</button>
      <button type="button" title="Reset graph view" aria-label="Reset graph view" onClick={() => { userAdjusted.current = true; transform.current = { scale: .78, x: 0, y: 0 }; redraw.current(); }}>RESET</button>
    </div>
    {entities.length === 0 && <div className="recon-graph-empty"><span>NO OBSERVATIONS YET</span><p>Start a passive investigation to reveal evidence-backed relationships.</p></div>}
  </div>;
}

