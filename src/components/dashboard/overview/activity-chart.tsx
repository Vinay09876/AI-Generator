"use client";

import { useId, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { BarChart3 } from "lucide-react";
import type { DailyActivity } from "@/features/generations/queries";
import { EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

const dayLabel = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const weekday = new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" });

const toDate = (key: string) => new Date(`${key}T00:00:00Z`);
const plural = (n: number) => `${n} generation${n === 1 ? "" : "s"}`;

/** Round axis ceiling (4, 8, 10, 15, 25, 150…) so gridline labels are readable numbers. */
function niceMax(max: number) {
  if (max <= 4) return 4;
  const unit = Math.max(2, 10 ** Math.floor(Math.log10(max)) / 2);
  return Math.ceil(max / unit) * unit;
}

/**
 * Single-series bar chart: generations per UTC day. Single series, so no legend box
 * (the title names it). Each bar column is a hover/focus target with a tooltip, and
 * an equivalent data table is available to screen readers.
 */
export function ActivityChart({ data }: { data: DailyActivity }) {
  const reduce = useReducedMotion();
  const tableId = useId();
  const [active, setActive] = useState<number | null>(null);

  const total = data.reduce((s, d) => s + d.count, 0);
  const max = niceMax(Math.max(0, ...data.map((d) => d.count)));
  const empty = total === 0;
  const lastIndex = data.length - 1;

  return (
    <section aria-labelledby="activity-heading" className="rounded-3xl border border-white/[0.08] bg-surface p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 id="activity-heading" className="text-sm font-medium">
            Generations per day
          </h2>
          <p className="mt-0.5 text-xs text-muted">Last 14 days · UTC</p>
        </div>
        <p className="text-sm text-muted">
          <span className="font-semibold text-foreground tabular-nums">{total}</span> in this period
        </p>
      </div>

      <div className="relative mt-6 h-44" aria-describedby={tableId}>
        {/* Recessive gridlines: baseline, midpoint and max */}
        <div aria-hidden className="pointer-events-none absolute inset-0 flex flex-col justify-between pl-7">
          {[max, max / 2, 0].map((v, i) => (
            <div key={i} className="relative border-t border-dashed border-white/[0.06] last:border-solid last:border-white/10">
              <span className="absolute -top-2 -left-7 w-6 text-right text-[10px] text-muted/70 tabular-nums">
                {empty && v !== 0 ? "" : Number.isInteger(v) ? v : ""}
              </span>
            </div>
          ))}
        </div>

        <div className="absolute inset-0 flex items-end gap-[2px] pl-7 sm:gap-1">
          {data.map((d, i) => {
            const pct = max > 0 ? (d.count / max) * 100 : 0;
            const isActive = active === i;
            const label = `${dayLabel.format(toDate(d.date))}: ${plural(d.count)}`;
            return (
              <button
                key={d.date}
                type="button"
                aria-label={label}
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className="group relative flex h-full flex-1 cursor-default items-end justify-center rounded-md outline-none focus-visible:bg-white/[0.04]"
              >
                {d.count > 0 && (
                  <motion.span
                    className={cn(
                      "block w-full max-w-7 rounded-t-[4px] bg-[#8b5cf6] transition-colors duration-150",
                      isActive && "bg-[#a78bfa]",
                    )}
                    style={{ height: `${pct}%`, transformOrigin: "bottom" }}
                    initial={reduce ? false : { scaleY: 0 }}
                    animate={{ scaleY: 1 }}
                    transition={{ duration: 0.7, delay: 0.15 + i * 0.03, ease: EASE_OUT }}
                  />
                )}
                {isActive && (
                  <span
                    role="tooltip"
                    className={cn(
                      "pointer-events-none absolute z-10 rounded-lg border border-white/10 bg-zinc-950/95 px-2.5 py-1.5 text-left text-xs whitespace-nowrap shadow-xl backdrop-blur",
                      // Keep edge tooltips inside the card.
                      i < 2 ? "left-0" : i > lastIndex - 2 ? "right-0" : "left-1/2 -translate-x-1/2",
                    )}
                    style={{ bottom: `calc(${pct}% + 8px)` }}
                  >
                    <span className="block text-muted">
                      {weekday.format(toDate(d.date))}, {dayLabel.format(toDate(d.date))}
                    </span>
                    <span className="font-medium text-foreground">{plural(d.count)}</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {empty && (
          <div className="absolute inset-0 grid place-items-center pl-7">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-background/80 px-3.5 py-1.5 text-xs text-muted backdrop-blur">
              <BarChart3 className="size-3.5" aria-hidden />
              No generations in the last 14 days
            </div>
          </div>
        )}
      </div>

      {/* X axis: first, middle and today, to avoid crowded labels */}
      <div aria-hidden className="mt-2 flex justify-between pl-7 text-[10px] text-muted/80">
        <span>{dayLabel.format(toDate(data[0].date))}</span>
        <span>{dayLabel.format(toDate(data[Math.floor(lastIndex / 2)].date))}</span>
        <span>Today</span>
      </div>

      <table id={tableId} className="sr-only">
        <caption>Generations per day, last 14 days (UTC)</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Generations</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.date}>
              <td>{dayLabel.format(toDate(d.date))}</td>
              <td>{d.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
