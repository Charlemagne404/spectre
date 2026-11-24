import { useId, useState } from 'react';
import { address, byteSize, contains, hex } from './model';
import type { ByteRange, EntropyBin, Region } from './model';

const plotWidth = 800;
const plotHeight = 176;

export function EntropyPlot({ bins, size, selection, emptyMessage, select }: {
  bins: EntropyBin[];
  size: number;
  selection: ByteRange | null;
  emptyMessage: string;
  select: (range: ByteRange) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const gradient = useId();
  const current = selection ? bins.findIndex((bin) => contains(bin, selection.offset)) : -1;
  const active = hover ?? Math.max(current, 0);
  const point = bins[active];
  const x = (offset: number) => offset / size * plotWidth;
  const y = (value: number) => plotHeight - value / 8 * plotHeight;
  const center = (bin: EntropyBin) => x(bin.offset + bin.length / 2);
  const points = bins.map((bin) => center(bin) + ',' + y(bin.value));
  const line = point ? 'M0,' + y(bins[0].value) + 'L' + points.join('L') + 'L' + plotWidth + ',' + y(bins[bins.length - 1].value) : '';
  const plotIndex = (ratio: number) => {
    const offset = Math.max(0, Math.min(size - 1, Math.floor(size * ratio)));
    return bins.findIndex((bin) => contains(bin, offset));
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  if (!bins.length) return <div className="entropy-empty" role="status">{emptyMessage}</div>;

  return <div className="entropy-body">
    <div className="entropy-axis" aria-hidden="true">{[8, 6, 4, 2, 0].map((value) => <span key={value}>{value}</span>)}</div>
    <div className="entropy-plot">
      <div className="plot-hitbox"
        role={bins.length ? 'slider' : undefined}
        tabIndex={bins.length ? 0 : undefined}
        aria-label="Entropy region"
        aria-valuemin={bins.length ? 0 : undefined}
        aria-valuemax={bins.length ? bins.length - 1 : undefined}
        aria-valuenow={bins.length ? Math.max(current, 0) : undefined}
        aria-valuetext={bins.length ? address(bins[Math.max(current, 0)].offset) + ', ' + bins[Math.max(current, 0)].value.toFixed(2) + ' bits per byte' : undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: 1, ArrowDown: -1 }[event.key];
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? bins.length - 1
            : step === undefined ? null : Math.max(0, Math.min(bins.length - 1, Math.max(current, 0) + step));
          if (next === null || !bins[next]) return;
          event.preventDefault();
          setHover(null);
          select(bins[next]);
        }}
        onPointerMove={(event) => {
          if (!bins.length) return;
          const box = event.currentTarget.getBoundingClientRect();
          setHover(plotIndex((event.clientX - box.left) / box.width));
        }}
        onPointerLeave={() => setHover(null)}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const bin = bins[plotIndex((event.clientX - box.left) / box.width)];
          if (bin) select(bin);
        }}>
        <svg viewBox={'0 0 ' + plotWidth + ' ' + plotHeight} preserveAspectRatio="none" aria-hidden="true">
          <defs><linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1" gradientUnits="objectBoundingBox">
            <stop stopColor="var(--accent)" stopOpacity=".25" /><stop offset="1" stopColor="var(--accent)" stopOpacity=".025" />
          </linearGradient></defs>
          {ticks.flatMap((tick) => [
            <line key={'v' + tick} className="plot-grid" x1={tick * plotWidth} y1={0} x2={tick * plotWidth} y2={plotHeight} />,
            <line key={'h' + tick} className="plot-grid" x1={0} y1={tick * plotHeight} x2={plotWidth} y2={tick * plotHeight} />,
          ])}
          {point && <g className="plot-trace">
            <path d={line + 'V' + plotHeight + 'H0Z'} fill={'url(#' + gradient + ')'} />
            <path d={line} className="plot-line" />
            <circle key={bins.at(-1)?.offset} className="plot-arrival" cx={center(bins.at(-1)!)} cy={y(bins.at(-1)!.value)} r="2.5" />
          </g>}
          {current >= 0 && <rect className="plot-selected" x={x(bins[current].offset)} width={Math.max(2, x(bins[current].length))} height={plotHeight} />}
          {point && (hover !== null || focused) && <g>
            <line className="plot-crosshair" x1={center(point)} y1="0" x2={center(point)} y2={plotHeight} />
            <circle cx={center(point)} cy={y(point.value)} r="3.5" className="plot-point" />
          </g>}
        </svg>
        {point && (hover !== null || focused) && <div className="plot-tooltip"
          style={{ left: Math.max(9, Math.min(91, center(point) / plotWidth * 100)) + '%' }}>
          {address(point.offset)} · {point.value.toFixed(2)} bits/B
        </div>}
      </div>
      <div className="entropy-offsets" aria-hidden="true">
        {ticks.filter((tick) => size > 4 || tick === 0 || tick === 1).map((tick) =>
          <span key={tick}>{address(Math.floor(tick * Math.max(size - 1, 0)), 4)}</span>)}
      </div>
    </div>
  </div>;
}

export function StructureMap({ regions, size, selection, select, parser, limitation, emptyLabel }: {
  regions: Region[];
  size: number;
  selection: ByteRange | null;
  select: (range: ByteRange) => void;
  parser?: string;
  limitation?: string;
  emptyLabel?: string;
}) {
  const [hover, setHover] = useState<Region | null>(null);
  const current = selection && regions.find((region) => contains(region, selection.offset));
  const detail = hover || current;
  return <div className="structure">
    <div className="structure-heading"><h3>Structure</h3><span title={limitation}>{parser ?? (regions.length + (regions.length === 1 ? ' region' : ' regions'))}</span></div>
    {regions.length > 0 ? <>
      <div className="structure-map" aria-hidden="true">
        {regions.map((region, index) => <div key={region.offset} className={'region-fill region-' + region.kind + (region === detail ? ' region-active' : '') + (index === regions.length - 1 ? ' region-revealed' : '')}
          style={{ flexBasis: region.length / size * 100 + '%' }}
          title={region.label + ' · ' + byteSize(region.length)}
          onPointerEnter={() => setHover(region)} onPointerLeave={() => setHover(null)} onClick={() => select(region)} />)}
        {detail && <span className="region-marker" style={{ left: detail.offset / size * 100 + '%' }} />}
      </div>
      <div className="structure-labels" aria-label="File regions">
        {regions.map((region) => <button key={region.offset}
          type="button" className={'region-label region-' + region.kind}
          title={region.label + ' · ' + address(region.offset) + ' · ' + byteSize(region.length)}
          aria-pressed={region === current}
          onPointerEnter={() => setHover(region)} onPointerLeave={() => setHover(null)}
          onClick={() => select(region)}>{region.label}</button>)}
      </div>
      <div className="structure-detail">{detail ? address(detail.offset) + ' · ' + byteSize(detail.length) : 'Select a region'}</div>
    </> : <div className="structure-detail">{emptyLabel ?? 'No bytes to map'}</div>}
  </div>;
}

export function ByteHistogram({ histogram, firstOffsets, firstByte, selectByte, emptyMessage }: {
  histogram: number[];
  firstOffsets: number[];
  firstByte?: number;
  emptyMessage: string;
  selectByte: (byte: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [keyboard, setKeyboard] = useState<number | null>(null);
  const value = hover ?? keyboard ?? firstByte;
  const maximum = Math.max(1, ...histogram);
  const count = (byte: number) => '0x' + hex(byte) + ' · ' + histogram[byte].toLocaleString('en') + ' hits';
  if (!histogram.some((amount) => amount > 0)) return <div className="histogram">
    <div className="histogram-head"><h3>Byte frequency</h3></div>
    <div className="histogram-empty" role="status">{emptyMessage}</div>
  </div>;
  return <div className="histogram">
    <div className="histogram-head">
      <h3>Byte frequency</h3>
      <span>{value === undefined ? '256 values' : count(value)}</span>
    </div>
    <div className="histogram-plot" role="slider" tabIndex={0}
      aria-label="Byte frequency, square-root scale" aria-valuemin={0} aria-valuemax={255}
      aria-valuenow={keyboard ?? firstByte ?? 0} aria-valuetext={count(keyboard ?? firstByte ?? 0)}
      onBlur={() => setKeyboard(null)}
      onKeyDown={(event) => {
        const current = keyboard ?? firstByte ?? 0;
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: 1, ArrowDown: -1 }[event.key];
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 255 : step === undefined ? null : current + step;
        if (next === null) return;
        event.preventDefault();
        setHover(null);
        const value = Math.max(0, Math.min(255, next));
        setKeyboard(value);
        if (event.key !== 'Home' && event.key !== 'End' && firstOffsets[value] >= 0) selectByte(value);
      }}
      onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        setHover(Math.min(255, Math.max(0, Math.floor((event.clientX - box.left) / box.width * 256))));
      }}
      onPointerLeave={() => setHover(null)}
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const selected = Math.min(255, Math.max(0, Math.floor((event.clientX - box.left) / box.width * 256)));
        setKeyboard(selected);
        selectByte(selected);
      }}
      onKeyUp={(event) => {
        if (event.key === 'Enter' || event.key === ' ') selectByte(keyboard ?? firstByte ?? 0);
      }}>
      <svg viewBox="0 0 768 29" preserveAspectRatio="none" aria-hidden="true">
        {histogram.map((count, index) => {
          const height = count ? Math.max(0.7, Math.sqrt(count / maximum) * 28) : 0;
          return <rect key={index} x={index * 3} y={29 - height} width="2" height={height}
            className={index === value ? 'histogram-bar active' : 'histogram-bar'} />;
        })}
      </svg>
    </div>
    <div className="histogram-ticks" aria-hidden="true"><span>00</span><span>40</span><span>80</span><span>C0</span><span>FF</span></div>
  </div>;
}
