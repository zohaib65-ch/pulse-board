"use client";

import { Clock } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useRange } from "@/lib/client/range-provider";
import { RANGE_KEYS, RANGES, type RangeKey } from "@/shared/constants";

/** The global time-range filter. One shared value drives every chart, metric and table. */
export function RangeSelect() {
  const { range, setRange } = useRange();
  return (
    <Select value={range} onValueChange={(value) => setRange(value as RangeKey)}>
      <SelectTrigger aria-label="Time range" className="w-full min-w-44 sm:w-auto">
        <Clock aria-hidden className="text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        {RANGE_KEYS.map((key) => (
          <SelectItem key={key} value={key}>
            {RANGES[key].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
