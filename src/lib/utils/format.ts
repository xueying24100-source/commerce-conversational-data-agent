export type ClaimUnit = 'currency' | 'integer' | 'decimal' | 'percent' | 'hours';

/** Common commerce metric labels for display; falls back to the raw metric key. */
const METRIC_LABELS: Record<string, string> = {
  gmv: 'GMV',
  net_revenue: '净收入',
  paid_orders: '支付订单数',
  units: '销量',
  visits: '访问量',
  conversion_rate: '转化率',
  average_order_value: '客单价',
  refund_rate: '退款率',
  refund_amount: '退款金额',
  gross_profit: '毛利额',
  gross_margin: '毛利率',
  ad_spend: '广告消耗',
  roas: 'ROAS',
  new_customers: '新客数',
};

export function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric;
}

/** Formats a claim value by unit. Currency has no fixed currency code in the data model, so it is
 * rendered as a plain grouped number rather than guessing a currency symbol. */
export function formatClaimValue(value: number, unit: ClaimUnit): string {
  switch (unit) {
    case 'currency':
    case 'decimal':
      return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'integer':
      return Math.round(value).toLocaleString('zh-CN');
    case 'percent':
      return `${(value * 100).toFixed(1)}%`;
    case 'hours':
      return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} h`;
    default:
      return String(value);
  }
}
