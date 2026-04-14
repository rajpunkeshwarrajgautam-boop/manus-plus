type MetricPoint = { name: string; value: number; tags?: Record<string, string>; ts: string };

export const metrics: MetricPoint[] = [];

export function emitMetric(name: string, value: number, tags?: Record<string, string>) {
  metrics.push({ name, value, tags, ts: new Date().toISOString() });
}

export function summarizeMetrics() {
  const byName = new Map<string, number>();
  let totalEstimatedCost = 0;
  for (const metric of metrics) {
    byName.set(metric.name, (byName.get(metric.name) || 0) + metric.value);
    if (metric.name === "task_cost_estimate") {
      totalEstimatedCost += metric.value;
    }
  }
  return {
    totalEvents: metrics.length,
    counters: Object.fromEntries(byName.entries()),
    economics: {
      totalEstimatedCost: Number(totalEstimatedCost.toFixed(4)),
      avgEstimatedCostPerTask: Number(((byName.get("task_completed") || 0) > 0 ? totalEstimatedCost / (byName.get("task_completed") || 1) : 0).toFixed(4))
    },
    lastEventAt: metrics.length > 0 ? metrics[metrics.length - 1].ts : null
  };
}
