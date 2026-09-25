"use client";

import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Filler,
} from "chart.js";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler);

export interface TrendSeries {
  label: string;
  color: string;
  values: (number | null)[];
  /** Render against the right axis (for a series on a different scale, e.g. speed vs. congestion). */
  rightAxis?: boolean;
}

/**
 * A single time-series line chart, styled to match CongestionChart's
 * instrument-panel look. Kept generic (labels + series) rather than
 * hard-coded to congestion or complaints, so both history views in
 * /analytics share one component instead of two near-identical ones.
 */
export default function TrendChart({
  labels,
  series,
  height = 220,
}: {
  labels: string[];
  series: TrendSeries[];
  height?: number;
}) {
  const data = {
    labels,
    datasets: series.map((s) => ({
      label: s.label,
      data: s.values,
      borderColor: s.color,
      backgroundColor: `${s.color}22`,
      pointRadius: 0,
      pointHoverRadius: 3,
      borderWidth: 1.75,
      tension: 0.3,
      fill: !s.rightAxis,
      yAxisID: s.rightAxis ? "y1" : "y",
    })),
  };

  const hasRightAxis = series.some((s) => s.rightAxis);

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index" as const, intersect: false },
    plugins: {
      legend: series.length > 1
        ? {
            position: "top" as const,
            align: "end" as const,
            labels: {
              color: "#EDEEE7",
              boxWidth: 10,
              boxHeight: 10,
              font: { family: "IBM Plex Mono", size: 10 },
            },
          }
        : { display: false },
      tooltip: {
        backgroundColor: "#0F2A47",
        titleFont: { family: "IBM Plex Mono", size: 10 },
        bodyFont: { family: "IBM Plex Mono", size: 10 },
        borderColor: "rgba(143,217,232,0.2)",
        borderWidth: 1,
      },
    },
    scales: {
      x: {
        grid: { color: "rgba(143,217,232,0.06)" },
        ticks: {
          color: "#EDEEE7",
          font: { family: "IBM Plex Mono", size: 9 },
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 8,
        },
      },
      y: {
        grid: { color: "rgba(143,217,232,0.1)" },
        ticks: { color: "#EDEEE7", font: { family: "IBM Plex Mono", size: 9 } },
      },
      ...(hasRightAxis
        ? {
            y1: {
              position: "right" as const,
              grid: { display: false },
              ticks: { color: "#EDEEE7", font: { family: "IBM Plex Mono", size: 9 } },
            },
          }
        : {}),
    },
  };

  return (
    <div style={{ height }}>
      <Line data={data} options={options as any} />
    </div>
  );
}
