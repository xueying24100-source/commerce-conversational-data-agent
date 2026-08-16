'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const SERIES_COLORS = ['#8B5CF6', '#6366F1', '#38BDF8'];

export type BarChartCardProps = {
  data: Array<Record<string, unknown>>;
  xKey: string;
  series: string[];
};

export function BarChartCard({ data, xKey, series }: BarChartCardProps) {
  return (
    <div className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <defs>
            {series.map((key, index) => (
              <linearGradient key={key} id={`bar-${key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={SERIES_COLORS[index % SERIES_COLORS.length]} stopOpacity={0.95} />
                <stop offset="100%" stopColor={SERIES_COLORS[index % SERIES_COLORS.length]} stopOpacity={0.35} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} stroke="#EDE9FE" />
          <XAxis dataKey={xKey} tick={{ fontSize: 10, fill: '#A5B4FC' }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 10, fill: '#A5B4FC' }} axisLine={false} tickLine={false} width={40} />
          <Tooltip
            contentStyle={{
              borderRadius: 12,
              border: '1px solid rgba(139,92,246,0.2)',
              fontSize: 12,
            }}
            cursor={{ fill: 'rgba(139,92,246,0.06)' }}
          />
          {series.map((key, index) => (
            <Bar key={key} dataKey={key} fill={`url(#bar-${key})`} radius={[6, 6, 0, 0]} maxBarSize={28} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
