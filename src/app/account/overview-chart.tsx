'use client';

import {
  ResponsiveContainer,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Bar,
} from 'recharts';

// SpendingTrend — the compact "monthly send volume" chart on the customer
// Overview. Recharts can't read CSS custom properties, so colors are literal
// (mirroring the app's light --primary / muted grid). Data is computed
// server-side (one bucket per month, USD-equivalent) and passed in; this island
// is purely presentational — no data access, no PII.

const PRIMARY = '#533afd'; // matches the app's --primary in the light theme
const GRID = '#e8e8ec';
const TEXT = '#60646c';

const tickStyle = { fontSize: 10, fill: TEXT };

function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function SpendingTrend({
  data,
}: {
  data: { month: string; volumeUsd: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="month" tick={tickStyle} tickLine={false} axisLine={false} />
        <YAxis
          tick={tickStyle}
          tickLine={false}
          axisLine={false}
          width={48}
          tickFormatter={(v: number) => formatUsd(v)}
        />
        <Tooltip
          cursor={{ fill: 'rgba(83,58,253,0.06)' }}
          formatter={(v: number) => [formatUsd(v), 'Sent']}
        />
        <Bar dataKey="volumeUsd" fill={PRIMARY} radius={[4, 4, 0, 0]} maxBarSize={48} />
      </BarChart>
    </ResponsiveContainer>
  );
}
