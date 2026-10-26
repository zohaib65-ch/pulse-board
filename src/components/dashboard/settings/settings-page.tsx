"use client";

import { KeyRound, Lock, LockOpen, Monitor, Moon, Sun } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAdmin } from "@/lib/client/admin-token";
import { useStatus } from "@/lib/client/hooks";
import { describeGroup, describeKafkaPublish, describeWorkers, withStaleness } from "@/lib/client/status";
import { useNow } from "@/lib/client/use-now";
import { THEME_OPTIONS, useTheme, type ThemePreference } from "@/lib/client/theme-provider";
import { formatWhen } from "@/lib/format";
import type { StatusData } from "@/shared/api";
import { CONSUMER_GROUP_IDS, RETENTION, TOPIC_NAME, TOPIC_PARTITIONS } from "@/shared/constants";
import { PageHeader } from "../page-header";
import { CardSkeleton, Freshness, QueryBoundary } from "../states";
import { ToneBadge } from "../status-badge";

const THEME_META: Record<ThemePreference, { label: string; icon: typeof Sun }> = {
  light: { label: "Light", icon: Sun },
  dark: { label: "Dark", icon: Moon },
  system: { label: "System", icon: Monitor },
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[14rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

function AppearanceTab() {
  const { preference, resolved, setPreference } = useTheme();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Theme</CardTitle>
        <CardDescription>Stored in this browser only. System follows your device setting.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={preference}
          onValueChange={(value) => value && setPreference(value as ThemePreference)}
          aria-label="Theme"
          className="w-full sm:w-auto"
        >
          {THEME_OPTIONS.map((option) => {
            const { label, icon: Icon } = THEME_META[option];
            return (
              <ToggleGroupItem key={option} value={option} className="flex-1 sm:flex-none sm:px-4">
                <Icon /> {label}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        <p className="text-sm text-muted-foreground">
          Currently showing the {resolved} theme{preference === "system" ? " (from your device)" : ""}.
        </p>
      </CardContent>
    </Card>
  );
}

function ServiceRows({ data, stale }: { data: StatusData; stale: boolean }) {
  const now = useNow();
  const workers = describeWorkers(data.workers);
  const publish = describeKafkaPublish(data.kafka, now);
  const database = withStaleness({ label: "Connected", tone: "ok" }, stale);
  const publishState = withStaleness(publish, stale);
  const workersState = withStaleness(workers, stale);
  return (
    <dl className="divide-y">
      <Row label="Database">
        <ToneBadge tone={database.tone}>{database.label}</ToneBadge>
      </Row>
      <Row label="Kafka topic">
        <span className="font-mono text-xs">{data.kafka.topic || TOPIC_NAME}</span> · {data.kafka.partitions || TOPIC_PARTITIONS} partitions
      </Row>
      <Row label="Kafka publishing">
        <span className="mr-2">
          <ToneBadge tone={publishState.tone}>{publishState.label}</ToneBadge>
        </span>
        <span className="text-muted-foreground tabular-nums">
          {data.kafka.lastPublishAt ? `Last publish ${formatWhen(data.kafka.lastPublishAt, now)}` : "No publish since the service started"}
          {data.kafka.lastPublishError ? ` · last error ${formatWhen(data.kafka.lastPublishError.at, now)}: ${data.kafka.lastPublishError.message}` : ""}
        </span>
      </Row>
      <Row label="Workers">
        <ToneBadge tone={workersState.tone}>{workersState.label}</ToneBadge>
      </Row>
      {data.groups.map((group) => {
        const state = withStaleness(describeGroup(group), stale);
        return (
          <Row key={group.key} label={`${group.key === "analytics" ? "Analytics" : "Alerts"} consumer group`}>
            <span className="mr-2 font-mono text-xs break-all">{group.groupId}</span>
            <ToneBadge tone={state.tone}>{state.label}</ToneBadge>
          </Row>
        );
      })}
      <Row label="Event history retention">{data.retention.historyHours} hours</Row>
      <Row label="Newest stored event">{data.lastEventAt ? formatWhen(data.lastEventAt, now) : "None retained"}</Row>
    </dl>
  );
}

function ServicesTab() {
  const status = useStatus();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Services</CardTitle>
        <CardDescription>Non-sensitive status as reported by the API and the workers. No credentials are ever shown here.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Freshness query={status} />
        <QueryBoundary query={status} skeleton={<CardSkeleton rows={6} />} errorTitle="Couldn't load service status">
          {(data) => <ServiceRows data={data} stale={status.isStale} />}
        </QueryBoundary>
        <dl className="divide-y border-t pt-4">
          <Row label="Consumer group ids">
            <span className="font-mono text-xs break-all">
              {CONSUMER_GROUP_IDS.analytics}, {CONSUMER_GROUP_IDS.alerts}
            </span>
          </Row>
          <Row label="Retention (configured)">
            History {RETENTION.historyHours} h · de-duplication records {RETENTION.dedupeDays} days · alerts {RETENTION.alertDays} days
          </Row>
        </dl>
      </CardContent>
    </Card>
  );
}

function AccessTab() {
  const { isUnlocked, openDialog, lock, lockReason } = useAdmin();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Admin access</CardTitle>
        <CardDescription>
          Reading dashboards is public because the data is synthetic. Sending events, pausing consumers and starting replays need the admin token.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          {isUnlocked ? (
            <ToneBadge tone="ok">Unlocked</ToneBadge>
          ) : (
            <ToneBadge tone="unknown">Locked</ToneBadge>
          )}
          <p className="text-sm text-muted-foreground">Held in this tab&apos;s memory only; cleared on reload.</p>
        </div>
        {lockReason ? (
          <Alert variant="destructive">
            <AlertDescription>{lockReason}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={openDialog}>
            {isUnlocked ? <LockOpen /> : <KeyRound />}
            {isUnlocked ? "Manage access" : "Enter admin token"}
          </Button>
          {isUnlocked ? (
            <Button type="button" variant="outline" onClick={() => lock()}>
              <Lock /> Clear token
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Theme, service status and admin access." />
      <Tabs defaultValue="appearance" className="max-w-3xl gap-4">
        <TabsList aria-label="Settings sections" className="w-full sm:w-auto">
          <TabsTrigger value="appearance" className="px-3">Appearance</TabsTrigger>
          <TabsTrigger value="services" className="px-3">Services</TabsTrigger>
          <TabsTrigger value="access" className="px-3">Access</TabsTrigger>
        </TabsList>
        <TabsContent value="appearance">
          <AppearanceTab />
        </TabsContent>
        <TabsContent value="services">
          <ServicesTab />
        </TabsContent>
        <TabsContent value="access">
          <AccessTab />
        </TabsContent>
      </Tabs>
    </>
  );
}
