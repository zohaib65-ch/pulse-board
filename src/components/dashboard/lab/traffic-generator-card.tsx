"use client";

import { Controller, useForm, useWatch } from "react-hook-form";
import { Play, Square } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAdmin } from "@/lib/client/admin-token";
import { zodResolver } from "@/lib/client/zod-resolver";
import {
  GENERATOR_MODES,
  GENERATOR_MODE_LABELS,
  SPIKE_MIN_RATE,
  generatorFormSchema,
  type GeneratorForm,
  type GeneratorState,
} from "@/lib/client/traffic-generator";
import { formatNumber, formatOffset, shortId } from "@/lib/format";
import { SIMULATOR_LIMITS, SPIKE_RULE } from "@/shared/constants";
import { AdminRequired } from "../admin-button";

const STATUS_TEXT: Record<GeneratorState["status"], string> = {
  idle: "Ready",
  running: "Running",
  completed: "Completed",
  stopped: "Stopped",
  failed: "Stopped after an error",
};

/** Browser-driven simulator. Limits are enforced again by the server per run id and per second. */
export function TrafficGeneratorCard({
  state,
  onStart,
  onStop,
}: {
  state: GeneratorState;
  onStart: (form: GeneratorForm) => void;
  onStop: () => void;
}) {
  const { isUnlocked } = useAdmin();
  const form = useForm<GeneratorForm>({
    resolver: zodResolver(generatorFormSchema),
    defaultValues: { events: 30, ratePerSecond: 5, mode: "random" },
  });
  const mode = useWatch({ control: form.control, name: "mode" });
  const running = state.status === "running";
  const finishedCount = state.accepted + state.failed;
  const percent = state.planned > 0 ? Math.min(100, Math.round((finishedCount / state.planned) * 100)) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Traffic generator</CardTitle>
        <CardDescription>
          Sends synthetic events from this tab: at most {SIMULATOR_LIMITS.maxEventsPerRun} events per run and {SIMULATOR_LIMITS.maxEventsPerSecond} per second.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <AdminRequired id="generator-locked">Starting a run needs the admin token.</AdminRequired>

        <form onSubmit={form.handleSubmit((values) => onStart(values))} noValidate className="grid gap-4" aria-describedby={isUnlocked ? undefined : "generator-locked"}>
          <Controller
            control={form.control}
            name="mode"
            render={({ field }) => (
              <Field>
                <FieldLabel id="generator-mode-label">Mode</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={field.value}
                  onValueChange={(value) => value && field.onChange(value)}
                  aria-labelledby="generator-mode-label"
                  disabled={running}
                  className="w-full"
                  spacing={0}
                >
                  {GENERATOR_MODES.map((option) => (
                    <ToggleGroupItem key={option} value={option} className="flex-1">
                      {GENERATOR_MODE_LABELS[option]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <FieldDescription>
                  {mode === "spike"
                    ? `Sends ${SIMULATOR_LIMITS.spikeBurstSize} events from one session, all stamped inside the same minute, so the alert rule (more than ${SPIKE_RULE.eventsPerSessionPerWindow} events per session per minute) fires once.`
                    : "Page views, product clicks and cart additions from a handful of sessions."}
                </FieldDescription>
              </Field>
            )}
          />

          <div className="grid gap-3 sm:grid-cols-2">
            {mode === "spike" ? (
              <Field>
                <FieldLabel>Events</FieldLabel>
                <p className="flex h-8 items-center text-sm tabular-nums touch:h-11">{SIMULATOR_LIMITS.spikeBurstSize} (fixed for a spike)</p>
              </Field>
            ) : (
              <Controller
                control={form.control}
                name="events"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="generator-events">Events (1–{SIMULATOR_LIMITS.maxEventsPerRun})</FieldLabel>
                    <Input
                      id="generator-events"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={SIMULATOR_LIMITS.maxEventsPerRun}
                      step={1}
                      disabled={running}
                      aria-invalid={fieldState.invalid}
                      aria-describedby="generator-events-error"
                      value={Number.isNaN(field.value) ? "" : field.value}
                      onChange={(event) => field.onChange(event.target.value === "" ? Number.NaN : event.target.valueAsNumber)}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                    />
                    <div id="generator-events-error">
                      <FieldError errors={[fieldState.error]} />
                    </div>
                  </Field>
                )}
              />
            )}
            <Controller
              control={form.control}
              name="ratePerSecond"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="generator-rate">Events per second (1–{SIMULATOR_LIMITS.maxEventsPerSecond})</FieldLabel>
                  <Input
                    id="generator-rate"
                    type="number"
                    inputMode="numeric"
                    min={mode === "spike" ? SPIKE_MIN_RATE : 1}
                    max={SIMULATOR_LIMITS.maxEventsPerSecond}
                    step={1}
                    disabled={running}
                    aria-invalid={fieldState.invalid}
                    aria-describedby="generator-rate-error"
                    value={Number.isNaN(field.value) ? "" : field.value}
                    onChange={(event) => field.onChange(event.target.value === "" ? Number.NaN : event.target.valueAsNumber)}
                    onBlur={field.onBlur}
                    name={field.name}
                    ref={field.ref}
                  />
                  <div id="generator-rate-error">
                    <FieldError errors={[fieldState.error]} />
                  </div>
                </Field>
              )}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!isUnlocked || running}>
              <Play /> Start run
            </Button>
            <Button type="button" variant="outline" onClick={onStop} disabled={!running}>
              <Square /> Stop
            </Button>
          </div>
        </form>

        {state.status !== "idle" ? (
          <div className="space-y-3 rounded-xl border p-3" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">
                {STATUS_TEXT[state.status]}
                <span className="ml-2 font-normal text-muted-foreground tabular-nums">
                  {formatNumber(finishedCount)} of {formatNumber(state.planned)}
                </span>
              </p>
              {state.runId ? <Badge variant="outline" className="font-mono">run {shortId(state.runId)}</Badge> : null}
            </div>
            <Progress value={percent} aria-label="Run progress" className="h-2" />
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Counter label="Accepted by Kafka" value={state.accepted} />
              <Counter label="Failed" value={state.failed} />
              <Counter label="Retried" value={state.retries} />
              <div>
                <dt className="text-xs text-muted-foreground">Last acknowledgement</dt>
                <dd className="font-medium tabular-nums">
                  {state.lastAck ? `p${state.lastAck.partition} · ${formatOffset(state.lastAck.baseOffset)}` : "—"}
                </dd>
              </div>
            </dl>
            {state.error ? (
              <Alert variant="destructive">
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            ) : null}
            {state.retries > 0 ? (
              <p className="text-xs text-muted-foreground">Retried requests resend the same event ids, so Kafka consumers deduplicate them and counts never inflate.</p>
            ) : null}
            <p className="text-xs text-muted-foreground">Accepted events are not necessarily processed yet. Watch the consumer lag fall to zero below.</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{formatNumber(value)}</dd>
    </div>
  );
}
