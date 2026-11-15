// Small hand-made charts (plain HTML/CSS, no chart library).
// Rules followed: bars <= 24px with 4px rounded data-ends, 2px surface gaps between
// stacked parts, a legend whenever there are 2+ series, hover tooltips on every mark,
// text in text colours (never the series colour), and a table view on every card.

import type React from 'react'
import { useState, type ReactNode } from 'react'

type Tip = { x: number; y: number; content: ReactNode } | null

/** A tooltip that follows the mouse inside a `position: relative` chart. */
function useTip() {
  const [tip, setTip] = useState<Tip>(null)
  const show = (e: React.MouseEvent, content: ReactNode) => {
    const box = (e.currentTarget.closest('.chart') as HTMLElement).getBoundingClientRect()
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, content })
  }
  const el = tip && (
    <div className="tip" style={{ left: tip.x, top: tip.y }} role="status">
      {tip.content}
    </div>
  )
  return { show, hide: () => setTip(null), el }
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.label}>
          <i style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  )
}

/** Horizontal bars, one series. Value printed at the bar tip. */
export function BarList({
  rows, color = 'var(--series-1)', highlight, format = (n) => n.toLocaleString(), tipLabel, onSelect,
}: {
  rows: { label: string; value: number; note?: string; id?: string }[]
  color?: string
  highlight?: string // label to emphasise (the others get a lighter step)
  format?: (n: number) => string
  tipLabel?: (r: { label: string; value: number; note?: string }) => ReactNode
  onSelect?: (r: { label: string; value: number; id?: string }) => void   // click a bar -> list its tickets
}) {
  const t = useTip()
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <div className="chart barlist">
      {rows.map((r) => {
        const Row = onSelect ? 'button' : 'div'
        return (
        <Row
          key={r.label}
          type={onSelect ? 'button' : undefined}
          className={`barrow ${onSelect ? 'clickable' : ''}`}
          onClick={onSelect ? () => onSelect(r) : undefined}
          aria-label={onSelect ? `${r.label}: ${format(r.value)}. Show tickets` : undefined}
          onMouseMove={(e: React.MouseEvent) => t.show(e, <>{tipLabel ? tipLabel(r) : <><b>{r.label}</b><br />{format(r.value)}</>}{onSelect && <><br /><span className="dim">Click to see tickets</span></>}</>)}
          onMouseLeave={t.hide}
        >
          <span className="barlabel" title={r.label}>{r.label}</span>
          <span className="bartrack">
            <span
              className="bar"
              style={{
                width: `calc((100% - 40px) * ${r.value / max})`,
                background: highlight && r.label !== highlight ? 'var(--series-1-soft)' : color,
              }}
            />
            <span className="barvalue">{format(r.value)}</span>
          </span>
        </Row>
        )
      })}
      {t.el}
    </div>
  )
}

/** Horizontal stacked bars: several parts per row, separated by 2px gaps. */
export function StackedBars<K extends string>({
  rows, series, onSelect,
}: {
  rows: ({ label: string } & Record<K, number>)[]
  series: { key: K; label: string; color: string }[]
  onSelect?: (label: string, key: K | null) => void          // key null = the whole row
}) {
  const t = useTip()
  const totals = rows.map((r) => series.reduce((s, x) => s + r[x.key], 0))
  const max = Math.max(1, ...totals)
  return (
    <>
      <Legend items={series} />
      <div className="chart barlist">
        {rows.map((r, idx) => (
          <div key={r.label} className="barrow">
            {onSelect
              ? <button type="button" className="barlabel linklike" title={`All bugs in ${r.label}`}
                  onClick={() => onSelect(r.label, null)}>{r.label}</button>
              : <span className="barlabel" title={r.label}>{r.label}</span>}
            <span className="bartrack">
              <span className="stack" style={{ width: `calc((100% - 40px) * ${totals[idx] / max})` }}>
                {series.filter((s) => r[s.key] > 0).map((s) => {
                  const Seg = onSelect ? 'button' : 'span'
                  return (
                    <Seg
                      key={s.key}
                      type={onSelect ? 'button' : undefined}
                      className={`seg ${onSelect ? 'clickable' : ''}`}
                      style={{ flexGrow: r[s.key], background: s.color }}
                      onClick={onSelect ? () => onSelect(r.label, s.key) : undefined}
                      aria-label={onSelect ? `${r.label}, ${s.label}: ${r[s.key]}. Show tickets` : undefined}
                      onMouseMove={(e: React.MouseEvent) => t.show(e, (
                        <><b>{r.label}</b><br />{s.label}: {r[s.key]}<br /><span className="dim">of {totals[idx]} reported{onSelect ? ' · click to list' : ''}</span></>
                      ))}
                      onMouseLeave={t.hide}
                    />
                  )
                })}
              </span>
              <span className="barvalue">{totals[idx]}</span>
            </span>
          </div>
        ))}
        {t.el}
      </div>
    </>
  )
}

/** Vertical columns over time (one series). The latest column is labelled. */
export function Columns({ rows, onSelect, unit = 'bugs reported', action = 'Show tickets' }: {
  rows: { label: string; value: number; tip: string; id?: string }[]
  onSelect?: (r: { label: string; value: number; id?: string }) => void
  unit?: string
  action?: string          // what a click does, for screen readers and the tooltip
}) {
  const t = useTip()
  const max = Math.max(1, ...rows.map((r) => r.value))
  const ticks = niceTicks(max)
  const top = ticks[ticks.length - 1]
  return (
    <div className="chart columns">
      <div className="cols-plot">
        {ticks.map((v) => (
          <div key={v} className="gridline" style={{ bottom: `${(v / top) * 100}%` }}>
            <span>{v}</span>
          </div>
        ))}
        {rows.map((r, i) => {
          const Slot = onSelect ? 'button' : 'div'
          return (
            <Slot
              key={r.label}
              type={onSelect ? 'button' : undefined}
              className={`colslot ${onSelect ? 'clickable' : ''}`}
              onClick={onSelect ? () => onSelect(r) : undefined}
              aria-label={onSelect ? `${r.tip}: ${r.value} ${unit}. ${action}` : undefined}
              onMouseMove={(e: React.MouseEvent) => t.show(e, <><b>{r.tip}</b><br />{r.value} {unit}{onSelect && <><br /><span className="dim">Click: {action.toLowerCase()}</span></>}</>)}
              onMouseLeave={t.hide}
            >
              <span className="col" style={{ height: `${(r.value / top) * 100}%` }}>
                {i === rows.length - 1 && <span className="colvalue">{r.value}</span>}
              </span>
            </Slot>
          )
        })}
      </div>
      <div className="cols-axis">
        {/* every other label (counted from the newest) so short labels never collide */}
        {rows.map((r, i) => <span key={r.label}>{(rows.length - 1 - i) % 2 === 0 ? r.label : ''}</span>)}
      </div>
      {t.el}
    </div>
  )
}

/** One whole split into parts (28px tall), share printed inside when it fits. */
export function SegmentedBar({ parts, onSelect, unit = 'people' }: {
  parts: { label: string; value: number; color: string; ink?: string }[]
  onSelect?: (label: string) => void          // click a part -> list who is in it
  unit?: string
}) {
  const t = useTip()
  const total = parts.reduce((s, p) => s + p.value, 0) || 1
  return (
    <>
      <div className="chart segbar" role={onSelect ? 'group' : 'img'}
        aria-label={parts.map((p) => `${p.label}: ${p.value}`).join(', ')}>
        {parts.filter((p) => p.value > 0).map((p) => {
          const share = p.value / total
          const Part = onSelect ? 'button' : 'span'
          return (
            <Part
              key={p.label}
              type={onSelect ? 'button' : undefined}
              className={`segpart ${onSelect ? 'clickable' : ''}`}
              style={{ flexGrow: p.value, background: p.color, color: p.ink ?? '#fff' }}
              onClick={onSelect ? () => onSelect(p.label) : undefined}
              aria-label={onSelect ? `${p.label}: ${p.value} ${unit}. Show them` : undefined}
              onMouseMove={(e: React.MouseEvent) => t.show(e, <><b>{p.label}</b><br />{p.value} {unit} ({Math.round(share * 100)}%){onSelect && <><br /><span className="dim">Click to see who</span></>}</>)}
              onMouseLeave={t.hide}
            >
              {share >= 0.12 ? p.value : ''}
            </Part>
          )
        })}
        {t.el}
      </div>
      <Legend items={parts} />
    </>
  )
}

function niceTicks(max: number): number[] {
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find((s) => max / s <= 4) ?? 1000
  const out: number[] = []
  for (let v = 0; v <= max + step - 1; v += step) out.push(v)
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step)
  return out
}

/** Tiny trend line for a tile: 2px line, soft area wash, labelled end dot. Hover shows each point. */
export function Sparkline({ values, labels }: { values: number[]; labels: string[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...values)
  const pts = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * 100, 100 - (v / max) * 88 - 6])
  const line = pts.map((p) => p.join(',')).join(' ')
  const i = hover ?? values.length - 1
  return (
    <div className="spark" onMouseLeave={() => setHover(null)}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        <polygon points={`0,100 ${line} 100,100`} className="spark-area" />
        <polyline points={line} className="spark-line" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="spark-dot" style={{ left: `${pts[i][0]}%`, top: `${pts[i][1]}%` }} />
      <div className="spark-hits">
        {values.map((_, j) => <span key={j} onMouseEnter={() => setHover(j)} />)}
      </div>
      <span className="spark-label">{labels[i]}: <b>{values[i]}</b></span>
    </div>
  )
}

/** Progress / share meter: 8px, track is a lighter step of the same hue. */
export function Meter({ value, max, label }: { value: number; max: number; label?: string }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="meter" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
      <span style={{ width: `${pct}%` }} />
    </div>
  )
}
