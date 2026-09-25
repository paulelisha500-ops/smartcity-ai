"use client";

import { Bar } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
} from "chart.js";
import type { Hotspot } from "@/lib/api";

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip);

export default function CongestionChart({ hotspots }: { hotspots: Hotspot[] }) {
  const data = {
    labels: hotspots.map((h) => h.intersection_name),
    datasets: [
      {
        label: "Congestion score",
        data: hotspots.map((h) => h.congestion_score),
        backgroundColor: hotspots.map((h) =>
          h.congestion_score >= 70 ? "#E2694F" : h.congestion_score >= 45 ? "#F2A65A" : "#6FBF8B"
        ),
        borderRadius: 2,
        barThickness: 22,
      },
    ],
  };

  const options = {
    indexAxis: "y" as const,
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: {
        min: 0,
        max: 100,
        grid: { color: "rgba(143,217,232,0.1)" },
        ticks: { color: "#EDEEE7", font: { family: "IBM Plex Mono", size: 10 } },
      },
      y: {
        grid: { display: false },
        ticks: { color: "#EDEEE7", font: { family: "IBM Plex Mono", size: 10 } },
      },
    },
  };

  return (
    <div style={{ height: hotspots.length * 40 + 40 }}>
      <Bar data={data} options={options} />
    </div>
  );
}
