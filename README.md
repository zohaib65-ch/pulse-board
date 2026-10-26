# Pulseboard

A live website-analytics dashboard that teaches Kafka by doing it for real: events enter through an HTTP API, travel through **Apache Kafka**, are consumed by **independent consumer groups**, and end up in **MongoDB**, where the dashboard reads them. You can pause a consumer while ingestion continues, watch lag build and drain, start a second worker to see partitions rebalance, and **replay** retained events into an isolated result set.

All activity is synthetic: you generate it yourself from the Kafka Lab.

```
Browser ──POST /api/events──▶ Next.js route ──produce (key = sessionId)──▶ Kafka topic "website-events" (2 partitions)
   ▲                         (admin token,                                      │
   │                          validation,                      ┌────────────────┴────────────────┐
   │                          rate limits)           group pulseboard-analytics-v1     group pulseboard-alerts-v1
   │                                                            │                                │
   │                                                  Worker (Vercel Daemon / Docker / local)    │
   │                                                  one Mongo transaction per message:         │
   │                                                  dedupe record + result updates, THEN       │
   │                                                  commit the Kafka offset                    │
   │                                                            ▼                                ▼
   └──GET /api/…  (polling every 5 s)◀──────────────── MongoDB Atlas: events, buckets, products, sessions, alerts,
                                                        worker heartbeats, sampled offsets, replay jobs
```

* **Web** – Next.js App Router: pages, and Route Handlers for ingestion, queries and controls. It only *produces* to Kafka and reads/writes MongoDB.
* **Worker** – a separate Node.js process (`workers/`) that consumes Kafka, runs replays, and publishes heartbeats. Consumers never run inside Route Handlers or Server Actions.
* **Shared code** – `src/shared` (event schema, constants, API types; browser-safe) and `src/lib/server` (config, MongoDB, Kafka, processing; used by both the routes and the worker).

## Quick start

Requirements: Node.js 24+, an Aiven Kafka service, and a MongoDB Atlas cluster (setup guides below).

```bash
npm install
cp .env.example .env.local        # fill in the six values
npm run dev                       # web app on http://localhost:3000
npm run dev:worker                # in a second terminal: the Kafka worker
npm run dev:worker                # optional third terminal: a SECOND worker (watch partitions rebalance)
```

Open the app, go to **Settings** (or click “Admin locked”), enter your `ADMIN_TOKEN`, then use the **Kafka Lab**.

| Script | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server |
| `npm run dev:worker` | Worker with file watching (`tsx`); loads `.env` then `.env.local` |
| `npm run build` | Production build of the web app (needs no credentials) |
| `npm run build:worker` | Bundles the worker and its shared code into `dist/worker.cjs` |
| `npm run start` / `npm run start:worker` | Run the built web app / the built worker |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (also enforces that browser code cannot import Kafka, MongoDB, or `src/lib/server`) |
| `npm test` | Vitest (starts an in-memory MongoDB replica set; no Kafka or credentials needed; the first run downloads a MongoDB binary, so it needs network access) |

## The six environment variables

The same six names are used locally (`.env.local`) and in production. Nothing else is configurable by environment: topic name, consumer group ids, polling intervals, thresholds and limits are typed constants in [`src/shared/constants.ts`](src/shared/constants.ts), and the database name is read from `MONGODB_URI`.

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | Atlas connection string **including the database name** (`…mongodb.net/pulseboard?…`). |
| `KAFKA_BROKERS` | Comma-separated Aiven broker `host:port` addresses. |
| `KAFKA_CA_CERT` | Aiven CA certificate (PEM). |
| `KAFKA_CLIENT_CERT` | Aiven service (client) certificate (PEM). |
| `KAFKA_CLIENT_KEY` | Aiven service access key (PEM private key). |
| `ADMIN_TOKEN` | Long random secret (≥ 24 characters) protecting ingestion, the traffic generator, pause/resume, and replay. `openssl rand -base64 32` |

Checklist before first run:

- [ ] `MONGODB_URI` has a database name after the host and the Atlas IP access list allows your machine (and Vercel, see below).
- [ ] `KAFKA_BROKERS` is the host and port Aiven shows for **client-certificate (SSL)** connections.
- [ ] The three PEM values are pasted with real line breaks **or** on one line with `\n` escapes. Both work, as do CRLF, wrapping quotes, and newlines flattened to spaces. Certificate verification is always enabled.
- [ ] `ADMIN_TOKEN` is long and random, and is not committed anywhere.

Configuration is validated lazily with Zod. `next build` never needs credentials; the worker validates everything at startup and refuses to start, naming the bad variables (never their values), if something is wrong. The API answers `503 server_misconfigured` without revealing which variable.

## Creating the services

### Aiven for Apache Kafka (free tier)

Facts from the [Aiven free-tier page](https://aiven.io/docs/products/kafka/free-tier/kafka-free-tier): up to 5 topics with 2 partitions each, 250 KiB/s in and out, fixed retention, one free Kafka service per organization, no SLA, creation only through the Aiven Console, and **the service powers off automatically when there is no ongoing Kafka activity** (you get a notification and can power it on again in the Console). A new service with no usage can also power off within its first hours.

1. In the [Aiven Console](https://console.aiven.io) create a service → **Apache Kafka** → **Free** plan.
2. Open the service → **Topics** → create **`website-events`** with **2 partitions**. (If the topic is missing, the worker tries to create it with 2 partitions; if your user may not create topics it logs how to create it manually.)
3. Open **Quick connect** → **Node.js** → **Client certificate** (mutual TLS). Choose a service user (the default admin user is simplest, because the worker also reads group offsets and deletes its temporary replay groups) and download:
   * **CA certificate** → `KAFKA_CA_CERT`
   * **Service certificate** → `KAFKA_CLIENT_CERT`
   * **Service access key** → `KAFKA_CLIENT_KEY`
4. From the service **Overview**, copy the host and port for SSL/client-certificate connections → `KAFKA_BROKERS` (e.g. `kafka-xxxx-yourproject.aivencloud.com:12345`).

> If the service is powered off, nothing can be produced or consumed: the UI will show “Kafka did not acknowledge” and workers as disconnected until you power it on.

### MongoDB Atlas (free cluster)

Facts from the [Atlas free-cluster limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/): 0.5 GB storage, 500 connections, **100 operations per second** (Atlas throttles above that), a 3-node replica set, one free cluster per project, and automatic pause after 30 days with zero connections.

1. Create a free cluster, then **Database Access** → add a database user with password (read/write on the `pulseboard` database is enough).
2. **Network Access** → allow your development IP. For Vercel, either allow `0.0.0.0/0` (the free tier has no private networking; the user password is then your protection, so make it long and unique) or restrict as your plan allows.
3. **Connect** → Drivers → copy the connection string and add the database name: `mongodb+srv://USER:PASSWORD@cluster0.xxxx.mongodb.net/pulseboard?retryWrites=true&w=majority`. URL-encode special characters in the password.
4. Indexes and TTLs are created automatically by the first request or worker start.

The worker writes with multi-document **transactions**, which require a replica set (Atlas clusters are). Atlas’s documentation lists no transaction restriction for free clusters, but this project has only been exercised against a local replica set (see *Verification*).

At the maximum generator rate (10 events/s) the two consumer groups perform roughly 100 database operations per second, which is right at the free tier’s throttle. Hitting it only slows processing (lag grows, then drains); no data is lost.

### Running Kafka and MongoDB locally instead

Pulseboard requires mutual TLS, so a local broker needs an SSL listener with `ssl.client.auth=required` and certificates whose subject alternative names include the broker hostname. Any broker/replica-set pair works; the project itself ships no local Kafka setup.

## Running locally

```bash
npm run dev            # terminal 1
npm run dev:worker     # terminal 2
```

* The worker loads `.env` and then `.env.local` (later wins, like Next.js) through Node’s `--env-file-if-exists`.
* `tsx` resolves the `@/…` alias from `tsconfig.json`, so the worker and the web app share the same source files.
* **A second worker instance:** run `npm run dev:worker` again in another terminal. After a few seconds the **Kafka Lab → Workers** card shows two instances, and each owns one of the two partitions in each group. Stop one with Ctrl+C and the other takes over both partitions.

To test the production artifact locally:

```bash
npm run build && npm run build:worker
npm run start          # terminal 1
npm run start:worker   # terminal 2
docker build -f Dockerfile.worker -t pulseboard-worker .
docker run --rm --env-file .env.docker pulseboard-worker
```

`docker --env-file` takes values literally (quotes are kept, no multi-line values), so for `.env.docker` write unquoted values and put the PEMs on one line with `\n` escapes. The worker accepts that format.

## Deploying on Vercel

Documentation used: [Daemons](https://vercel.com/docs/daemons), [limits](https://vercel.com/docs/daemons/limits), [configuration reference](https://vercel.com/docs/daemons/config-reference), [managing daemons](https://vercel.com/docs/daemons/managing-daemons). **Vercel Daemons are in public beta**, so check those pages again before depending on them.

Current facts from those pages:

* Daemons are available on all plans, **including Hobby**, but the Hobby quota is **5 Active CPU-hours per month for the whole team**. Active CPU counts only time your code spends executing, not waiting, yet a Kafka consumer is never fully idle (heartbeats, long polls, TLS, the worker’s own timers). 5 hours is about 0.7 % of one CPU running around the clock. **When the quota is reached Vercel stops your daemons until the first of the next month (UTC)** or until you upgrade. Watch the daemon’s CPU chart in the dashboard, and scale the daemon to 0 when you are not using the project.
* **Daemons run only in production deployments**: no preview deployments, and `vercel dev` does not run them (use Docker or `npm run dev:worker`).
* The project’s Root Directory must be the repository root (a subfolder such as `apps/web` is not supported yet), which is what this repo uses.
* Instances are Linux `amd64`, 1 Gi or 2 Gi on Hobby, no inbound traffic, no persistent disk, and no autoscaling (instance counts are set manually).
* `SIGTERM` is sent on rollouts and scaling; the default grace period is 30 s. The worker finishes the current message, stops, releases its replay lease, and exits within a second or two.
* Vercel passes the project’s environment variables to the image build as **build arguments**. `Dockerfile.worker` declares no `ARG` and no `ENV`, so no credential can end up in an image layer; the variables are only present at run time.

### Configuration

[`vercel.json`](vercel.json):

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "daemons": {
    "worker": {
      "root": "./",
      "entrypoint": "Dockerfile.worker",
      "instances": { "iad1": 1 },
      "resources": { "requests": { "memory": "1Gi" } },
      "terminationGracePeriodSeconds": 30
    }
  }
}
```

It was validated against Vercel’s published schema (`https://openapi.vercel.sh/vercel.json`), and an invented field is rejected by the same check. Notes:

* Vercel uses **the directory that contains the Dockerfile as the build context**. The worker imports `src/shared` and `src/lib/server`, so the Dockerfile lives at the repository root (`Dockerfile.worker`, `root: "./"`) rather than inside `workers/`. A `.dockerignore` keeps `.env*`, certificates, `node_modules`, tests, and `.git` out of the context.
* The Dockerfile bundles the worker with esbuild in a build stage; the final image is just Node plus one `worker.cjs` file (no `node_modules`).
* `iad1` is only the default; pick the region closest to your Aiven and Atlas regions (valid ids are in the schema and the [region list](https://vercel.com/docs/regions)).

### Steps

1. Push the repository to GitHub/GitLab/Bitbucket and **Import** it in Vercel. Framework: Next.js. Root Directory: the repository root.
2. Add the six variables under **Settings → Environment Variables** for **Production** (daemons only run there). For the PEMs, either paste them with line breaks or use the CLI: `vercel env add KAFKA_CA_CERT production < ca.pem`.
3. Deploy to production. Vercel builds the Next.js app and the daemon image, then starts the daemon.
4. Check the logs: dashboard → **Daemons** → `worker`, or `vercel logs --query 'source:daemon'`. You should see `worker running` and `joined group` for both groups.
5. Open the site → Settings → enter the admin token → Kafka Lab.

Changing `Dockerfile.worker`, the worker code, or environment variables requires a new production deployment (instance counts do not).

### Starting a second worker on Vercel

```bash
vercel daemons scale worker iad1=2      # CLI 64.3.0 or later; sets an override that survives deployments
vercel daemons scale worker --reset     # go back to the counts in vercel.json
vercel daemons scale worker iad1=0      # stop the worker (no CPU usage)
```

or use **Daemons → worker → Scale** in the dashboard. A scaling override beats `instances` in `vercel.json` until you clear it. Two instances also double the idle CPU usage, which matters on Hobby.

## Learning Kafka with the Lab

Each Kafka idea has a visible counterpart:

| Concept | Where to see it | Where it lives in the code |
| --- | --- | --- |
| **Partitions & keys** – messages with the same key always land in the same partition, in order. | Lab → send an event; the acknowledgement shows `partition` and `baseOffset`. All events of one session share a partition. | `publishEvents` in [`src/lib/server/kafka.ts`](src/lib/server/kafka.ts) (key = `sessionId`) |
| **Accepted vs processed** – Kafka acknowledged the write ≠ a consumer handled it. | The Lab labels an event “Accepted by Kafka” until it appears in the dashboard data, then “Processed by analytics”. | [`src/lib/server/ingest.ts`](src/lib/server/ingest.ts), `202` only after `producer.send` resolves with `acks: -1` |
| **Consumer groups** – each group gets every message and keeps its own offsets. | Two groups, two lag tables. Pause one; the other keeps moving. | [`workers/group-consumer.ts`](workers/group-consumer.ts), group ids in `constants.ts` |
| **Offsets & commit-after-work** – the committed offset is “last processed + 1”. | Lab → partition table: committed / latest / lag. | [`consumeBatch`](src/lib/server/processing/consume.ts): apply to MongoDB → resolve → commit, one message at a time |
| **At-least-once + idempotency** – redelivery must not change results. | Send the same event repeatedly (same `eventId`): counted once. | [`claim`](src/lib/server/processing/shared.ts) + [`processAnalyticsMessage`](src/lib/server/processing/analytics.ts): dedupe record and results commit in **one transaction** |
| **Lag** – how far a group is behind the log end. | Pause analytics, press “Product clicked” a few times: lag grows; resume: it drains. | [`workers/offsets.ts`](workers/offsets.ts) samples Kafka; the UI shows the sampling time because lag is approximate |
| **Pause vs rebalance** – a paused consumer stays in the group (still heartbeating), so partitions do not move. | Pause, then watch Workers: still assigned. Start a second worker: partitions split. | `desiredPaused` + `reconcilePause` in the group consumer; desired state is stored in MongoDB so every instance obeys it |
| **Poison messages** – a malformed message must not block a partition. | n/a from the UI (the API validates). Covered by tests. | `recordRejection`: recorded as rejected, offset committed, processing continues |
| **Retention & replay** – a new group can re-read what Kafka still holds. | Lab → Replay retained events. Results are shown next to unchanged live totals. | [`workers/replay-runner.ts`](workers/replay-runner.ts), [`src/lib/server/replay-jobs.ts`](src/lib/server/replay-jobs.ts) |

### Spike alerts

The alerts group raises an in-app alert when **more than 50 events** arrive from **one session** in **one tumbling one-minute window** (by event timestamp). There is exactly one alert per session and window (its id is derived from both, and it is written with `$setOnInsert`). The Lab’s **Spike burst** mode sends 60 events from one session to trigger it.

### Replay in detail

`POST /api/replays` only inserts a job document. A worker claims it atomically (a unique partial index allows one active job at a time), keeps a renewable 30 s lease, and then:

1. creates a unique consumer group `pulseboard-replay-v1-<runId>`,
2. captures each partition’s end offset (and the earliest retained offset),
3. reads from the earliest retained offset up to those captured end offsets (empty partitions finish immediately),
4. writes results under `scope = <runId>` with its own deduplication,
5. reports progress, completes, disconnects, and deletes the temporary group.

It never touches the live groups’ offsets, live totals, or alerts, and triggers nothing external. **Events that Kafka has already expired cannot be replayed.** A job reads at most 50,000 messages (the oldest are skipped and the job is marked truncated). If the worker dies, the lease expires and another worker resumes the job (already-written events are skipped by the run’s own dedupe records); after three failed attempts the job is marked failed. Replay results are deleted after 24 hours.

## HTTP API

All responses are `{ "ok": true, "data": … }` or `{ "ok": false, "error": { code, message, issues?, retryAfterSeconds? } }`. Read endpoints are public (the data is synthetic). Every write needs `Authorization: Bearer <ADMIN_TOKEN>`; the token is compared in constant time, failed attempts are rate limited per client in MongoDB, and authentication happens before the body is read.

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `POST /api/events` | admin | `{ events: Event[1..10], runId? }`, body ≤ 16 KiB. `202` only after Kafka acknowledges. `runId` is required for `source: "simulator"`. |
| `GET /api/events` | – | `range`, `type`, `page`, `productId`, `cursor`, `limit ≤ 50`; newest first, keyset pagination. `ids=<uuid,…>` (≤ 20) looks specific events up directly. |
| `GET /api/metrics/overview` | – | `range=15m\|1h\|24h`: totals, series, breakdown, top products, active sessions (fixed 5-minute window). |
| `GET /api/products` | – | `range`, `q`, `sort`, `order`, `page`, `pageSize`. |
| `GET /api/alerts` | – | `limit ≤ 50`. |
| `GET /api/status` | – | Database, Kafka publish state, worker heartbeats, per-group desired/effective state, sampled offsets. |
| `POST /api/consumers/{analytics\|alerts}` | admin | `{ action: "pause" \| "resume" }`, persisted for all workers. |
| `POST /api/admin/verify` | admin | `200` only for the correct token. |
| `POST /api/replays` | admin | `202` with the job; `409` if one is already active. |
| `GET /api/replays`, `GET /api/replays/{id}` | – | Job status, per-partition progress, isolated result statistics. |

Event contract (`src/shared/event-schema.ts`): `eventId` (UUID, preserved on retries), `type` (`page_view`/`product_click`/`add_to_cart`), `timestamp` (ISO, not older than 24 h or more than 5 min in the future), `sessionId` (pseudonymous UUID, also the Kafka key), `page` (pathname only, no query string or fragment, ≤ 200 chars), `productId` (required for clicks and cart adds), `source` (`playground`/`simulator`).

Rate limits (MongoDB-backed fixed windows, shared by every instance): 10 wrong tokens / 5 min per client, 20 events/s and 300 events/min overall, the generator at 10 events/s and 100 per run id, 20 control actions / min per client.

## Data and retention

| Collection | Purpose | Retention (TTL) |
| --- | --- | --- |
| `events` | Raw events stored by the analytics group (Live events) | 48 h |
| `metric_buckets`, `product_buckets`, `session_activity` | One-minute buckets, per-product counts, session last-seen; `scope` is `live` or a replay run id | 48 h (replay: 24 h) |
| `processed_messages` | Deduplication records per `(group, eventId)` and rejected offsets | 7 days |
| `rejected_messages`, `alerts` | Malformed messages, spike alerts | 7 / 14 days |
| `worker_instances` | Heartbeats (an instance is *stale* after 20 s without one) | 1 h after the last heartbeat |
| `consumer_offsets`, `consumer_commands` | Sampled committed/latest offsets, persisted pause state (one small document per group) | kept |
| `replay_jobs`, `rate_limits`, `service_state` | Replay jobs, limiter counters, last publish result | 24 h / seconds / – |

Dedupe records outlive both Kafka’s retention and any replay, so a redelivery after an offset reset cannot inflate totals.

## Testing and verification

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

The test suite uses a real in-memory MongoDB replica set (so transactions, unique indexes and write conflicts are real); Kafka is replaced by small fakes (a scripted producer, and fake consumers/admin that record every call). It covers: invalid events and server-side validation, unauthorized writes on every control endpoint, brute-force lockout, duplicate and concurrent delivery, per-group deduplication, exactly-one spike alert, poison messages, pause/resume with backlog recovery and commit ordering, crash-between-apply-and-commit redelivery, persisted pause state, honest worker staleness, replay isolation and job leases, rate-limit atomicity and refunds, the auth lockout under a 200-request burst, spike counters surviving TTL while a group lags, the worker lifecycle (stop during startup, cleanup after a failed start, pause halting a batch mid-way, replay completion, interruption at every stage, resume without progress regressing, sanitized public errors), producer teardown identity, query semantics (range filters, zero-denominator ratios, pagination, id lookup), configuration and PEM handling, the traffic generator and poller, and the `.env.example` contract. Tests were also checked by breaking the code on purpose (dedupe, auth, replay scope, commit ordering, late abort listeners, progress regression) and confirming they fail. Two independent read-only code reviews of the backend and frontend found real defects (lost spike counters under TTL, missed aborts, an auth race, leaked hostnames in public errors, stale pagination, and others); each was fixed and given a regression test.

### What was verified live (local stack, not Aiven/Atlas)

With no Aiven, Atlas, or Vercel access available, the real pipeline was exercised on a local stack: an **Apache Kafka 4.3.1** broker with an SSL listener requiring client certificates (so the mTLS code path, CA verification with hostname checking, and escaped-newline PEMs were real), a **MongoDB 8.2 replica set**, the **production Next.js build**, and the **worker Docker image** (`Dockerfile.worker`).

| Check | Result |
| --- | --- |
| 1. Event reaches Kafka, then MongoDB and the dashboard | ✅ `202` with partition/offset; committed offset advanced to last-processed + 1; overview, events and products reflected it |
| 2. Pause analytics while ingestion continues, then catch up | ✅ lag grew to 10 while alerts stayed at 0; dashboard frozen; after resume totals exact and lag 0 |
| 3. Duplicate delivery leaves totals unchanged | ✅ same `eventId` sent 3×: counted once; both groups rewound to offset 0 (15 messages re-read): totals unchanged |
| 4. Replay creates a separate result set | ✅ boundaries captured per partition, 13 distinct events written under the run id, live totals/alerts byte-identical, temporary group deleted from the broker |
| 5. Two workers share partitions | ✅ `[0]` / `[1]` per group, 20 events during the rebalance counted exactly, `docker stop` handed everything to the survivor, exit code 0 |
| 6. Infrastructure failures give honest states | ✅ frozen broker: `503 kafka_unavailable` in ~8 s with a sanitized message, worker reported “Kafka not connected” after 15 s and recovered by itself; frozen MongoDB: `503 database_unavailable`, worker logged and survived, no loss |
| Bonus: crash recovery | ✅ a worker SIGKILLed mid-replay (MongoDB stalled at the time): its lease expired, the other worker took the job over (attempt 2) and finished with exact counts; SIGTERM during startup exits 0 in about 1.3 s |
| 7. Usable at 360 / 768 / 1280 / 1440 px | ✅ all five pages in light and dark: no horizontal overflow and no console errors; every interactive control measured ≥ 44 px at 360 and 768 px (compact 32 px controls from 1024 px up); 24 scripted interaction checks in Chrome passed (admin dialog, send, generator, pause/resume, replay, filters, pagination, details, search, theme, keyboard focus) |

Also confirmed: the worker image starts without credentials only to refuse with a variable-name list, contains no `ENV`/`ARG` secrets or `.env` files, and the browser bundle contains no Kafka/MongoDB code, credentials, or connection strings.

### Not verified (blocked on access)

* **Aiven Free Kafka**: real credentials, the actual Kafka version, ACLs for a non-admin service user, and whether the idle-shutdown logic counts a consumer’s heartbeats as activity. KafkaJS 2.2.4 (the latest stable release, last published in 2023) worked against Kafka 4.3.1 locally.
* **MongoDB Atlas Free**: transactions and the 100 ops/s throttle on a real M0 cluster; connectivity from Vercel.
* **Vercel Daemons deployment**: the daemon image build and rollout. In particular the repo-root build context (`root: "./"` with `Dockerfile.worker`) follows the documented rule that the Dockerfile’s directory is the build context, but the docs do not describe a project whose daemon `root` is the project root; if Vercel rejects it, the fallback is to move `Dockerfile.worker` into `workers/` and bundle the worker (`npm run build:worker`) into that directory before the image build. Also unverified: the Hobby CPU quota actually consumed by an idle worker.

## Troubleshooting

* **`server_misconfigured`**: a required variable is missing or malformed; the server log names it (never the value). Locally the worker prints the same list at startup.
* **`database_unavailable` / `kafka_unavailable`**: check Atlas network access and that the Aiven service is powered on. Ingestion retries are safe (same `eventId`s are ignored by consumers).
* **Lag never drains**: the group is paused (Kafka Lab shows “Paused”), or no worker is running (“No workers reporting”), or the worker lost Kafka.
* **Workers listed as “stale”**: the instance stopped heartbeating (crashed or killed). Gracefully stopped workers remove themselves.
* **Nothing shows up after sending**: the Lab shows “Accepted by Kafka” immediately, but the dashboard only changes once the analytics consumer has processed the event.
* **`TimeoutNegativeWarning`**: KafkaJS 2.2.4 passes a negative delay to `setTimeout` on current Node versions; Node clamps it to 1 ms. The scripts and Dockerfile suppress exactly this warning.

## Project layout

```
src/app/                 pages and Route Handlers (api/)
src/components/ui/       shadcn/ui components (Radix)
src/components/dashboard/ screens and dashboard components
src/lib/client/          browser-only: API client, polling, admin token (memory only), theme, traffic generator
src/lib/server/          Kafka, MongoDB, config, auth, rate limiting, processing, queries (never imported by browser code)
src/shared/              event schema, constants, catalog, API types (browser-safe)
workers/                 the Kafka worker: consumers, heartbeat, offset sampling, replay runner
tests/                   Vitest suites and helpers
Dockerfile.worker        worker image for Vercel Daemons (build context = repo root)
vercel.json              daemon definition
```

Security notes: the admin token lives only in browser memory (never in `localStorage`, cookies, URLs, or source) and is sent only in the `Authorization` header; it is entered through the dialog in the header or Settings, which verifies it with the server before accepting it. Infrastructure credentials are read only on the server and never logged or returned by any endpoint.
