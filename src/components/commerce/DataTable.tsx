import { cn } from '@/lib/utils/cn';

export type DataTableProps = {
  rows: Array<Record<string, unknown>>;
  totalRows?: number;
  className?: string;
  columnLabels?: Record<string, string>;
  formatValue?: (value: unknown, column: string) => string;
};

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return String(value);
}

export function DataTable({
  rows,
  totalRows,
  className,
  columnLabels = {},
  formatValue = (value) => formatCell(value),
}: DataTableProps) {
  const columns = Object.keys(rows[0] ?? {});
  if (!columns.length) return null;
  return (
    <div
      className={cn(
        'overflow-x-auto rounded-xl border border-violet-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50',
        className,
      )}
      tabIndex={0}
      role="region"
      aria-label="可横向滚动的数据表"
    >
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-violet-100">
            {columns.map((column) => (
              <th
                key={column}
                className="whitespace-nowrap px-3 py-2 font-medium uppercase tracking-wider text-violet-700"
              >
                {columnLabels[column] ?? column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-violet-50 last:border-b-0 hover:bg-violet-50/50">
              {columns.map((column) => (
                <td key={column} className="whitespace-nowrap px-3 py-2 tabular-nums text-indigo-800">
                  {formatValue(row[column], column)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {totalRows && totalRows > rows.length ? (
        <p className="border-t border-violet-50 px-3 py-1.5 text-[10px] text-violet-700">
          仅展示前 {rows.length} 行，共 {totalRows} 行
        </p>
      ) : null}
    </div>
  );
}
