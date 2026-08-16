'use client';

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const SERIES_COLORS = ['#8B5CF6', '#6366F1', '#38BDF8'];

export type LineChartCardProps = {
  data: Array<Record<string, unknown>>;
  xKey: string;
  series: string[];
};

export function LineChartCard({ data, xKey, series }: LineChartCardProps) {
  return (
    <div className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <defs>
            {series.map((key, index) => (
              <linearGradient key={key} id={`line-${key}`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={SERIES_COLORS[index % SERIES_COLORS.length]} stopOpacity={0.9} />
                <stop offset="100%" stopColor={SERIES_COLORS[index % SERIES_COLORS.length]} stopOpacity={0.5} />
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
          />
          {series.map((key, index) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={`url(#line-${key})`}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: SERIES_COLORS[index % SERIES_COLORS.length] }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
