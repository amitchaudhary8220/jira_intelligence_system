import type React from 'react'
import { useState, type ReactNode } from 'react'

export type Tone = 'good' | 'warning' | 'critical' | 'info'
const TONE_ICON: Record<Tone, string> = { good: '✓', warning: '!', critical: '!!', info: 'i' }

/** Status is never colour alone: icon + label + colour. */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`status status-${tone}`}>
      <i aria-hidden>{TONE_ICON[tone]}</i>
      {children}
    </span>
  )
}

export function Kpi({ label, value, unit, foot, children, onClick }: {
  label: string; value: number | string; unit?: string; foot?: ReactNode; children?: ReactNode; onClick?: () => void
}) {
  return (
    <button className="kpi" onClick={onClick} type="button">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">
        {typeof value === 'number' ? value.toLocaleString() : value}
        {unit && <small>{unit}</small>}
      </span>
      <span className="kpi-viz">{children}</span>
      {foot && <span className="kpi-foot">{foot}</span>}
    </button>
  )
}

type Table = { columns: string[]; rows: (string | number)[][] }

/** A card: title, optional subtitle, Chart/Table toggle and an "Ask" shortcut. */
export function Card({ title, subtitle, children, table, onAsk, className = '' }: {
  title: string; subtitle?: ReactNode; children: ReactNode; table?: Table; onAsk?: () => void; className?: string
}) {
  const [showTable, setShowTable] = useState(false)
  return (
    <section className={`card ${className}`}>
      <header className="card-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p className="card-sub">{subtitle}</p>}
        </div>
        <div className="card-actions">
          {table && (
            <button className="chip" aria-pressed={showTable} onClick={() => setShowTable((v) => !v)}>
              {showTable ? 'Chart' : 'Table'}
            </button>
          )}
          {onAsk && <button className="chip chip-ask" onClick={onAsk}>Ask ↗</button>}
        </div>
      </header>
      {showTable && table ? (
        <div className="table-wrap">
          <table>
            <thead><tr>{table.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>{r.map((v, j) => <td key={j} className={typeof v === 'number' ? 'num' : ''}>{v}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : children}
    </section>
  )
}

export function Skeleton({ h = 120 }: { h?: number }) {
  return <div className="skeleton" style={{ height: h }} />
}

type Col<R> = { key: keyof R & string; label: string; num?: boolean; render?: (r: R) => React.ReactNode }

/** A table you can sort by clicking a column header. Optional row click (e.g. open that person's tickets). */
export function SortTable<R extends Record<string, unknown>>({ rows, cols, initial, onRow, rowLabel }: {
  rows: R[]; cols: Col<R>[]; initial: keyof R & string; onRow?: (r: R) => void; rowLabel?: (r: R) => string
}) {
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: initial, desc: true })
  const sorted = [...rows].sort((a, b) => {
    const x = a[sort.key], y = b[sort.key]
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
    return sort.desc ? -c : c
  })
  return (
    <div className="table-wrap">
      <table className="sort-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} className={c.num ? 'num' : ''} aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                <button type="button" onClick={() => setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : true }))}>
                  {c.label}{sort.key === c.key ? (sort.desc ? ' ↓' : ' ↑') : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={i}>
              {cols.map((c, j) => (
                <td key={c.key} className={c.num ? 'num' : ''}>
                  {j === 0 && onRow
                    ? <button type="button" className="linklike" onClick={() => onRow(r)} aria-label={rowLabel?.(r)}>{c.render ? c.render(r) : String(r[c.key])}</button>
                    : (c.render ? c.render(r) : String(r[c.key]))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
