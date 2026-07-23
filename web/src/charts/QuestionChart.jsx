import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { MAX_DONUT_SLICES, foldCategories, paletteFor } from './palette.js';
import { useTheme } from '../theme.jsx';

/**
 * Most rows any inline view shows.
 *
 * Beyond this the full breakdown moves into a dialog, so a question with many
 * distinct answers cannot stretch the page or bury the chart under its own
 * legend.
 */
const DISPLAY_LIMIT = 10;

/**
 * Formats a count as a share of the total.
 *
 * @param {number} count
 * @param {number} total
 * @returns {string} Percentage to one decimal place, or an em-free dash when
 *   there is nothing to divide by.
 */
const percent = (count, total) => (total ? `${((count / total) * 100).toFixed(1)}%` : '-');

/**
 * Tooltip shared by both chart forms.
 *
 * @param {object} props Recharts tooltip props.
 * @returns {JSX.Element|null} The tooltip, or null when nothing is hovered.
 */
function ChartTooltip({ active, payload, total }) {
  if (!active || !payload?.length) return null;
  const entry = payload[0].payload;

  return (
    <div className="tooltip">
      <span className="tooltip-swatch" style={{ background: entry.fill }} aria-hidden="true" />
      <span className="tooltip-label">{entry.label}</span>
      <span className="tooltip-value">
        {entry.count} · {percent(entry.count, total)}
      </span>
    </div>
  );
}

/**
 * A table of the same numbers the chart shows.
 *
 * Three light-mode palette slots sit below 3:1 contrast, so this view is a
 * requirement rather than a nicety: it is how the data stays readable when
 * colour cannot carry it.
 *
 * @param {{rows: Array<object>, total: number}} props
 * @returns {JSX.Element} The table.
 */
function CategoryTable({ rows, total }) {
  return (
    <table className="chart-table">
      <thead>
        <tr>
          <th scope="col">Answer</th>
          <th scope="col">Count</th>
          <th scope="col">Share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <th scope="row">
              <span className="swatch" style={{ background: row.fill }} aria-hidden="true" />
              {row.label}
            </th>
            <td>{row.count}</td>
            <td>{percent(row.count, total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Donut for part-to-whole at a glance.
 *
 * The centre carries the leading answer as a hero number, which is what makes a
 * two-category question readable without degenerating into a two-slice pie.
 *
 * @param {{rows: Array<object>, total: number}} props
 * @returns {JSX.Element} The chart.
 */
function Donut({ rows, total }) {
  // The centre names a real answer, so the collapsed "custom answers" bucket
  // is skipped - it is a count of many different wordings, not one of them.
  const leader = rows.find((row) => !row.custom && !row.folded) ?? null;

  return (
    <div className="donut">
      <ResponsiveContainer width="100%" height={240}>
        <PieChart>
          <Pie
            data={rows}
            dataKey="count"
            nameKey="label"
            innerRadius={68}
            outerRadius={100}
            // A 2px gap between segments keeps adjacent fills from reading as
            // one shape when their hues are close.
            paddingAngle={1.5}
            stroke="var(--surface-1)"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {rows.map((row) => (
              <Cell key={row.key} fill={row.fill} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip total={total} />} />
        </PieChart>
      </ResponsiveContainer>

      {leader ? (
        <div className="donut-center" aria-hidden="true">
          <strong>{percent(leader.count, total)}</strong>
          <span>{leader.label}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Horizontal bars, used once a donut would have too many slices to read.
 *
 * @param {{rows: Array<object>, total: number}} props
 * @returns {JSX.Element} The chart.
 */
function BarList({ rows, total }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, rows.length * 38)}>
      <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 32, top: 4, bottom: 4 }}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="label"
          width={160}
          tickLine={false}
          axisLine={false}
          tick={{ fill: 'var(--text-secondary)', fontSize: 13 }}
        />
        <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={<ChartTooltip total={total} />} />
        <Bar dataKey="count" radius={[0, 4, 4, 0]} barSize={18} isAnimationActive={false}>
          {rows.map((row) => (
            <Cell key={row.key} fill={row.fill} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Renders one question's results.
 *
 * Picks the form from the data rather than the question type: part-to-whole at
 * a glance gets a donut, and anything with more categories than a donut can
 * carry falls back to bars. Either way a table view is one click away.
 *
 * @param {object} props
 * @param {Array<{key: string, label: string, count: number, custom: boolean}>}
 *   props.categories Aggregated categories, already sorted by count.
 * @param {number} props.answered How many people answered the question.
 * @returns {JSX.Element} The chart block.
 */
export function QuestionChart({ categories, answered, maxSlices = MAX_DONUT_SLICES }) {
  const { dark } = useTheme();
  const [showTable, setShowTable] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => {
    const { series, other } = paletteFor(dark);
    return foldCategories(categories).map((category, index) => ({
      ...category,
      fill: category.folded ? other : series[index % series.length],
    }));
  }, [categories, dark]);

  if (rows.length === 0) {
    return <p className="empty">No answers yet.</p>;
  }

  // Multi-choice lets one person pick several options, so shares are of
  // respondents rather than of the total selections.
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const useDonut = rows.length <= maxSlices;

  // Every inline view is capped; the rest is read in the dialog.
  const shown = rows.slice(0, DISPLAY_LIMIT);
  const overflow = rows.length - shown.length;

  return (
    <div className="chart-block">
      {showTable ? (
        <CategoryTable rows={shown} total={total} />
      ) : useDonut ? (
        <Donut rows={shown} total={total} />
      ) : (
        <BarList rows={shown} total={total} />
      )}

      {/* Direct labels, always present: identity is never carried by colour alone. */}
      {useDonut && !showTable ? (
        <ul className="legend">
          {shown.map((row) => (
            <li key={row.key}>
              <span className="swatch" style={{ background: row.fill }} aria-hidden="true" />
              <span className="legend-label">{row.label}</span>
              <span className="legend-value">{percent(row.count, total)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="chart-foot">
        <span>
          {answered} answered
          {overflow > 0 ? ` · showing top ${DISPLAY_LIMIT} of ${rows.length}` : ''}
        </span>
        <span className="row" style={{ gap: '0.9rem' }}>
          {overflow > 0 ? (
            <button type="button" className="link" onClick={() => setShowAll(true)}>
              View all {rows.length}
            </button>
          ) : null}
          <button type="button" className="link" onClick={() => setShowTable((v) => !v)}>
            {showTable ? 'Show chart' : 'Show table'}
          </button>
        </span>
      </div>

      {showAll ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowAll(false);
          }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-label="Full breakdown">
            <div className="modal-head">
              <h2>All {rows.length} answers</h2>
              <button type="button" onClick={() => setShowAll(false)}>
                Close
              </button>
            </div>
            <div className="modal-body">
              <CategoryTable rows={rows} total={total} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
