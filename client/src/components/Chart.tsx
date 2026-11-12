import { useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { cn } from '../lib/util';

/**
 * Lightweight dependency-free charts (SVG). Series colours come from the shared accent palette
 * (brand by default; violet for AI/forecast data, emerald for money in, blue for volume).
 * Charts only ever draw the data they are given.
 */
type ChartAccent = 'brand' | 'blue' | 'emerald' | 'amber' | 'violet';
const FILL: Record<ChartAccent, string> = { brand: 'fill-brand', blue: 'fill-blue-500', emerald: 'fill-emerald-500', amber: 'fill-amber-500', violet: 'fill-violet-500' };
const BAR: Record<ChartAccent, string> = { brand: 'bg-brand', blue: 'bg-blue-500', emerald: 'bg-emerald-500', amber: 'bg-amber-500', violet: 'bg-violet-500' };

export function ChartEmpty({ text = 'No data for this period', height = 240 }: { text?: string; height?: number }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-stone-200 bg-stone-50/50 text-sm text-stone-400" style={{ height }}>
      <BarChart3 className="h-6 w-6 text-stone-300" aria-hidden />
      {text}
    </div>
  );
}

export function BarChart({ data, format = (n) => String(n), height = 260, label, accent = 'brand' }: { data: { label: string; value: number }[]; format?: (n: number) => string; height?: number; label?: string; accent?: ChartAccent }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return <ChartEmpty height={height} />;
  const max = Math.max(...data.map((d) => d.value), 1);
  const W = 640;
  const pad = { l: 8, r: 8, t: 18, b: 30 };
  const bw = (W - pad.l - pad.r) / data.length;
  const ih = height - pad.t - pad.b;
  const ticks = [0, 0.5, 1];
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 text-[13px] text-stone-500">
        <span className="flex items-center gap-2"><span className={cn('h-2.5 w-2.5 rounded-sm', BAR[accent])} aria-hidden />{label ?? 'Value'}</span>
        <span>Peak <b className="tabular font-semibold text-stone-800">{format(max)}</b> · Total <b className="tabular font-semibold text-stone-800">{format(total)}</b></span>
      </div>
      <div className="relative">
        {/* Axis labels sit outside the SVG so they keep a readable size at every width. */}
        <div className="pointer-events-none absolute inset-y-0 start-0 flex flex-col justify-between text-[11px] text-stone-400" style={{ paddingTop: (pad.t / height) * 100 + '%', paddingBottom: (pad.b / height) * 100 + '%' }} aria-hidden>
          {[...ticks].reverse().map((t) => <span key={t} className="tabular -translate-y-1/2 rounded bg-white/80 px-1">{format(Math.round(max * t))}</span>)}
        </div>
        <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label={label ?? 'Bar chart'}>
          {ticks.map((t) => (
            <line key={t} x1={pad.l} x2={W - pad.r} y1={pad.t + ih * (1 - t)} y2={pad.t + ih * (1 - t)} stroke="#E7E5E4" strokeDasharray={t === 0 ? '' : '3 5'} />
          ))}
          {data.map((d, i) => {
            const h = (d.value / max) * ih;
            const barW = Math.min(bw * 0.62, 40);
            const x = pad.l + i * bw + (bw - barW) / 2;
            return (
              <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <rect x={pad.l + i * bw} y={pad.t} width={bw} height={ih} fill="transparent" />
                <rect x={x} y={pad.t + ih - h} width={barW} height={Math.max(h, d.value > 0 ? 2 : 0)} rx={Math.min(6, barW * 0.25)} className={cn(FILL[accent], 'transition-opacity duration-200')} opacity={hover == null || hover === i ? 0.92 : 0.35} />
                {(data.length <= 14 || i % Math.ceil(data.length / 10) === 0) && (
                  <text x={pad.l + i * bw + bw / 2} y={height - 9} textAnchor="middle" className="fill-stone-500 text-[11px]">
                    {d.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {hover != null && (
          <div className="pointer-events-none absolute top-0 z-10 animate-fade-in whitespace-nowrap rounded-xl bg-ink-900 px-3 py-2 text-xs text-white shadow-lift" style={{ left: `${Math.min(88, Math.max(12, ((hover + 0.5) / data.length) * 100))}%`, transform: 'translateX(-50%)' }}>
            <div className="text-stone-300">{data[hover].label}</div>
            <div className="tabular mt-0.5 text-sm font-semibold">{format(data[hover].value)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Horizontal ranked bars, for top products / categories. */
export function RankBars({ rows, format, accent = 'brand' }: { rows: { label: string; value: number; sub?: string }[]; format: (n: number) => string; accent?: ChartAccent }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  if (!rows.length) return <ChartEmpty text="No sales in this period" height={160} />;
  return (
    <ol className="space-y-4">
      {rows.map((r, i) => (
        <li key={i} className="flex items-center gap-3">
          <span className={cn('tabular flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-semibold', i < 3 ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-500')}>{i + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex justify-between gap-3 text-sm">
              <span className="truncate font-medium text-stone-800">{r.label}</span>
              <span className="shrink-0 font-semibold tabular-nums text-stone-900">
                {format(r.value)}
                {r.sub && <span className="ms-2 text-xs font-normal text-stone-400">{r.sub}</span>}
              </span>
            </div>
            <div className="h-2 rounded-full bg-stone-100">
              <div className={cn('h-2 rounded-full opacity-90', BAR[accent])} style={{ width: `${Math.max(2, (Math.max(0, r.value) / max) * 100)}%` }} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
