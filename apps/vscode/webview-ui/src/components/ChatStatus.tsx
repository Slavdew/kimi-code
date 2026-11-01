import { useQuery } from "@tanstack/react-query";
import { useChatStore } from "@/stores";
import { cn } from "@/lib/utils";
import { bridge } from "@/services";
import { IconArrowUp, IconArrowDown, IconBrandSpeedtest, IconGauge, IconRefresh } from "@tabler/icons-react";
import type { ManagedQuota, ManagedQuotaEntry } from "shared/types";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function TokenInfo() {
  const { lastStatus, tokenUsage, activeTokenUsage } = useChatStore();

  const inputTotal =
    tokenUsage.input_other +
    tokenUsage.input_cache_read +
    tokenUsage.input_cache_creation +
    activeTokenUsage.input_other +
    activeTokenUsage.input_cache_read +
    activeTokenUsage.input_cache_creation;

  const outputTotal = tokenUsage.output + activeTokenUsage.output;

  const contextPercent = lastStatus?.context_usage ? Math.round(lastStatus.context_usage * 1000) / 10 : 0;

  return (
    <div className="space-y-2">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Token Usage</div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="flex flex-col">
          <span className="text-muted-foreground text-[10px]">Context</span>
          <span className={cn(contextPercent > 80 && "text-amber-500", contextPercent > 95 && "text-destructive")}>{contextPercent}%</span>
        </div>
        <div className="flex flex-col">
          <span className="text-muted-foreground text-[10px]">Input</span>
          <span>{inputTotal.toLocaleString()}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-muted-foreground text-[10px]">Output</span>
          <span>{outputTotal.toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}

export function ChatStatus() {
  const { lastStatus, tokenUsage, activeTokenUsage } = useChatStore();

  if (!lastStatus) {
    return null;
  }

  const { context_usage } = lastStatus;
  const retrying = lastStatus.retrying;

  const inputTotal =
    tokenUsage.input_other +
    tokenUsage.input_cache_read +
    tokenUsage.input_cache_creation +
    activeTokenUsage.input_other +
    activeTokenUsage.input_cache_read +
    activeTokenUsage.input_cache_creation;

  const outputTotal = tokenUsage.output + activeTokenUsage.output;

  const contextPercent = context_usage ? Math.round(context_usage * 1000) / 10 : 0;

  return (
    <div className="flex items-center gap-3 text-[10px] text-muted-foreground border border-border/40 rounded-full px-2 py-0.5 select-none h-6 box-border mr-2 @max-[240px]:hidden">
      {retrying && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1 text-amber-500">
              <IconRefresh className="size-3" />
              Retry {retrying.next_attempt}/{retrying.max_attempts}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            Retrying in {Math.ceil(retrying.delay_ms / 1000)}s: {retrying.message}
          </TooltipContent>
        </Tooltip>
      )}
      {retrying && <div className="w-px h-3 bg-border/50" />}
      <div className="flex items-center gap-1.5" title="Context Window Usage">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1.5">
              <IconBrandSpeedtest className="size-3 opacity-70" />
              <span className={cn(contextPercent > 80 && "text-amber-500", contextPercent > 95 && "text-destructive")}>{contextPercent}%</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>Context Window Usage</TooltipContent>
        </Tooltip>
      </div>
      <div className="w-px h-3 bg-border/50 @max-[440px]:hidden" />
      <div className="flex items-center gap-1.5 @max-[440px]:hidden" title="Total Input Tokens">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1.5">
              <IconArrowUp className="size-3 opacity-70" />
              <span>{inputTotal.toLocaleString()}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>Total Input Tokens</TooltipContent>
        </Tooltip>
      </div>
      <div className="w-px h-3 bg-border/50 @max-[440px]:hidden" />
      <div className="flex items-center gap-1.5 @max-[440px]:hidden" title="Output Tokens">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1.5">
              <IconArrowDown className="size-3 opacity-70" />
              <span>{outputTotal.toLocaleString()}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>Total Output Tokens</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

interface ManagedQuotaRow {
  label: string;
  shortLabel: string;
  entry: ManagedQuotaEntry;
}

function managedQuotaRows(quota: ManagedQuota): ManagedQuotaRow[] {
  const rows: ManagedQuotaRow[] = [];
  const add = (label: string, shortLabel: string, entry?: ManagedQuotaEntry) => {
    if (entry !== undefined) rows.push({ label, shortLabel, entry });
  };
  add("5-hour limit", "5h", quota.usages.limit5h);
  add("Weekly limit", "Week", quota.usages.limit7d);
  add("Monthly limit", "Month", quota.usages.monthTotal);
  return rows;
}

function remainingPercent(entry: ManagedQuotaEntry): number {
  const usedRatio = Number.isFinite(entry.usedRatio) ? Math.max(0, Math.min(1, entry.usedRatio)) : 1;
  return Math.floor((1 - usedRatio) * 100);
}

function resetLabel(resetAt?: string): string | null {
  if (resetAt === undefined) return null;
  const date = new Date(resetAt);
  return Number.isNaN(date.getTime()) ? null : `Resets ${date.toLocaleString()}`;
}

export function ManagedUsageStatus() {
  const { data, isFetching, refetch } = useQuery({
    queryKey: ["managedUsage"],
    queryFn: () => bridge.getManagedUsage(),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });

  if (data?.kind !== "ok") return null;
  const rows = managedQuotaRows(data.quota);
  const primary = rows[0];
  if (primary === undefined) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" className="gap-1 h-6 text-xs" aria-label="Subscription limits">
          <IconGauge className="size-3.5" />
          <span className="@max-[500px]:hidden">{primary.shortLabel} {remainingPercent(primary.entry)}% left</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-medium">Subscription limits</div>
          <Button variant="ghost" size="icon-xs" aria-label="Refresh subscription limits" onClick={() => void refetch()}>
            <IconRefresh className={cn("size-3.5", isFetching && "animate-spin")} />
          </Button>
        </div>
        <div className="space-y-2">
          {rows.map((row) => {
            const reset = resetLabel(row.entry.resetAt);
            return (
              <div key={row.label} className="text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span>{row.label}</span>
                  <span className="font-medium">{remainingPercent(row.entry)}% left</span>
                </div>
                {reset && <div className="text-[10px] text-muted-foreground">{reset}</div>}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
