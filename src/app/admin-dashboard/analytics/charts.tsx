'use client';

import {
  ResponsiveContainer,
  BarChart,
  AreaChart,
  PieChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  Bar,
  Area,
  Pie,
  Cell,
} from 'recharts';

const COLORS = {
  primary: '#635bff',
  success: '#16a34a',
  warning: '#f0c000',
  danger: '#df1b41',
  info: '#635bff',
  neutral: '#697386',
  bgGrid: '#e6ebf1',
  text: '#697386',
};

const STATUS_COLORS: Record<string, string> = {
  delivered: COLORS.success,
  paid: COLORS.primary,
  awaiting_payment: COLORS.neutral,
  cancelled: COLORS.warning,
  blocked: COLORS.danger,
};

const COMPLIANCE_COLORS: Record<string, string> = {
  cleared: COLORS.success,
  flagged: COLORS.warning,
  blocked: COLORS.danger,
};

const FUNDING_LABELS: Record<string, string> = {
  credit_card: 'Credit card',
  debit_card: 'Debit card',
  bank_transfer: 'Bank transfer',
};

const tickStyle = { fontSize: 10, fill: COLORS.text };

function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

// ─── Daily transfers (bar) ────────────────────────────────────────────

export function DailyTransfers({
  data,
}: {
  data: { date: string; count: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={COLORS.bgGrid} />
        <XAxis dataKey="date" tick={tickStyle} />
        <YAxis tick={tickStyle} allowDecimals={false} />
        <Tooltip />
        <Bar dataKey="count" fill={COLORS.primary} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Daily volume (area) ──────────────────────────────────────────────

export function DailyVolume({
  data,
}: {
  data: { date: string; volumeUsd: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={COLORS.bgGrid} />
        <XAxis dataKey="date" tick={tickStyle} />
        <YAxis tick={tickStyle} tickFormatter={(v: number) => formatUsd(v)} />
        <Tooltip formatter={(v: number) => formatUsd(v)} />
        <Area
          type="monotone"
          dataKey="volumeUsd"
          stroke={COLORS.primary}
          fill={COLORS.primary}
          fillOpacity={0.2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── Daily commission (area) ──────────────────────────────────────────

export function DailyCommission({
  data,
}: {
  data: { date: string; commissionUsd: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={COLORS.bgGrid} />
        <XAxis dataKey="date" tick={tickStyle} />
        <YAxis tick={tickStyle} tickFormatter={(v: number) => formatUsd(v)} />
        <Tooltip formatter={(v: number) => formatUsd(v)} />
        <Area
          type="monotone"
          dataKey="commissionUsd"
          stroke={COLORS.success}
          fill={COLORS.success}
          fillOpacity={0.2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── Status distribution (donut) ──────────────────────────────────────

export function StatusDonut({
  data,
}: {
  data: { status: string; count: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie
          data={data}
          dataKey="count"
          nameKey="status"
          innerRadius={50}
          outerRadius={80}
          paddingAngle={2}
        >
          {data.map((d) => (
            <Cell key={d.status} fill={STATUS_COLORS[d.status] ?? COLORS.neutral} />
          ))}
        </Pie>
        <Tooltip />
        <Legend
          formatter={(value: string) => value.replaceAll('_', ' ')}
          wrapperStyle={{ fontSize: 11 }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

// ─── Compliance distribution (donut) ──────────────────────────────────

export function ComplianceDonut({
  data,
}: {
  data: { status: string; count: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie
          data={data}
          dataKey="count"
          nameKey="status"
          innerRadius={50}
          outerRadius={80}
          paddingAngle={2}
        >
          {data.map((d) => (
            <Cell
              key={d.status}
              fill={COMPLIANCE_COLORS[d.status] ?? COLORS.neutral}
            />
          ))}
        </Pie>
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 11 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

// ─── Funding method mix (horizontal bar) ──────────────────────────────

export function FundingMix({
  data,
}: {
  data: { method: string; count: number }[];
}) {
  const display = data.map((d) => ({
    label: FUNDING_LABELS[d.method] ?? d.method,
    count: d.count,
  }));
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart
        data={display}
        layout="vertical"
        margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={COLORS.bgGrid} />
        <XAxis type="number" tick={tickStyle} allowDecimals={false} />
        <YAxis dataKey="label" type="category" tick={tickStyle} width={110} />
        <Tooltip />
        <Bar dataKey="count" fill={COLORS.primary} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Top recipients (horizontal bar) ──────────────────────────────────

export function TopRecipients({
  data,
}: {
  data: { name: string; count: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(180, data.length * 32 + 40)}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={COLORS.bgGrid} />
        <XAxis type="number" tick={tickStyle} allowDecimals={false} />
        <YAxis dataKey="name" type="category" tick={tickStyle} width={140} />
        <Tooltip />
        <Bar dataKey="count" fill={COLORS.primary} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
