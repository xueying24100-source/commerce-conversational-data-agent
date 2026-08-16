'use client';

import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

const SLICE_COLORS = ['#8B5CF6', '#A78BFA', '#6366F1', '#818CF8', '#38BDF8', '#C4B5FD'];

export type PieChartCardProps = {
  data: Array<Record<string, unknown>>;
  nameKey: string;
  valueKey: string;
};

export function PieChartCard({ data, nameKey, valueKey }: PieChartCardProps) {
  return (
    <div className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          <Pie data={data} dataKey={valueKey} nameKey={nameKey} innerRadius={32} outerRadius={56} paddingAngle={2}>
            {data.map((_, index) => (
              <Cell key={index} fill={SLICE_COLORS[index % SLICE_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              borderRadius: 12,
              border: '1px solid rgba(139,92,246,0.2)',
              fontSize: 12,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 10, color: '#6366F1' }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
