# Real-time Collaborative Code Editor — Phase 1: Collaboration Foundation

A production-grade, multi-user collaborative code editor built on **Yjs CRDTs**,
a binary **y-websocket** compatible gateway, **Monaco**, NestJS, PostgreSQL,
Redis and S3/MinIO.

Phase 1 delivers: authentication, projects/files, owner/editor/viewer roles,
the Monaco editor with live multi-cursor collaboration, online presence,
autosave (Postgres update log + S3 snapshots), reconnect handling and a full
test pyramid up to a two-browser Playwright E2E scenario.

---

## 1. Feature map

| Area | Implementation |
| --- | --- |
| Auth | Register / login (bcrypt), JWT bearer tokens, `GET /api/auth/me` |
| Projects | Create / list / rename / delete, owner derived, member management |
| Files | File tree (folders inferred from `path`), create / rename / delete, language inference |
| Permissions | `owner` > `editor` > `viewer`, enforced on REST **and** the WebSocket; UI disables forbidden actions |
| Editor | Monaco with TS/JS/JSON/CSS/HTML/Python/Go/… workers, syntax highlighting, read-only for viewers |
| Sync | Byte-compatible **y-websocket protocol** (sync step 1/2/update + awareness) on raw `ws` |
| CRDT | One server-side `Y.Doc` per file per instance; replicas converge over the bus; arbitrary concurrent edits merge |
| Scaling | Optional Redis backplane (`COLLAB_BUS=redis`): cross-instance CRDT + awareness fan-out, one lease-elected persistence leader per file |
| Cursors | Yjs **Awareness** (`y-monaco`) carries cursor/selection, user name + color, across instances |
| Presence | Online users derived from awareness, mirrored into **Redis** with TTL |
| Autosave | Merged Yjs updates appended to Postgres every `PERSIST_FLUSH_MS`; full snapshots compacted into S3 every `SNAPSHOT_INTERVAL_MS` |
| Reliability | y-websocket auto-reconnect with backoff, ws ping/pong dead-peer detection, room TTL eviction, flush-on-shutdown |
| Errors | 401/403 on upgrade and edit frames, viewer edit denials surfaced as toasts, connection/save indicators |

---

## 2. Repository layout

```
.
├── docker-compose.yml          # postgres + redis + minio + 2 backends + LB + frontend (+ e2e profile)
├── .env.example                # backend environment reference
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma       # User, Project, ProjectMember, File, DocumentUpdate, FileSnapshot
│   │   ├── migrations/          # SQL migration applied with `prisma migrate deploy`
│   │   └── seed.ts              # demo project with Alice(owner)/Bob(editor)/Carol(viewer)
│   ├── src/
│   │   ├── main.ts              # Nest bootstrap + WS gateway attachment
│   │   ├── auth/                # JWT, bcrypt, guard, current-user decorator
│   │   ├── projects/            # projects + members + PermissionService
│   │   ├── files/               # file CRUD, language inference, content reconstruction
│   │   ├── collaboration/
│   │   │   ├── collaboration.gateway.ts   # raw ws, y-websocket protocol, authz
│   │   │   ├── room-manager.ts            # Room (Y.Doc + awareness), leader, autosave
│   │   │   ├── presence.service.ts        # Redis presence hash + TTL
│   │   │   ├── collab.protocol.ts         # lib0/y-protocols frame builders
│   │   │   └── bus/                       # collaboration backplane
│   │   │       ├── collaboration-bus.ts            # abstract bus + framing/lease API
│   │   │       ├── local-collaboration-bus.ts      # no-op single-instance bus
│   │   │       ├── redis-collaboration-bus.ts      # pub/sub + Lua lease election
│   │   │       └── in-memory-collaboration-bus.ts  # test double w/ Redis semantics
│   │   ├── storage/             # S3/MinIO client
│   │   └── common/              # Prisma + Redis providers
│   └── test/                    # HTTP, WS and multi-instance integration tests
├── frontend/
│   ├── src/
│   │   ├── api/                 # REST client + WS URL helpers
│   │   ├── auth/                # Auth context
│   │   ├── editor/              # useYFile (Yjs+provider hook), Monaco workers
│   │   ├── components/          # MonacoEditor (y-monaco), FileTree, MembersPanel, TopBar, Toast
│   │   └── pages/               # Login, Register, Projects, Project
│   ├── Dockerfile + nginx.conf  # static build, proxies /api and /collab to backend
└── e2e/
    └── tests/collaboration.spec.ts  # Playwright two-browser collaboration scenarios
```

---

## 3. Quick start

### 3.1 One command (recommended)

Requires Docker + Docker Compose v2.

```bash
# from the repository root
cp .env.example .env          # optional; compose already carries safe defaults
docker compose up --build
```

Wait for healthchecks, then open:

| Service | URL | Credentials |
| --- | --- | --- |
| Frontend (via LB) | http://localhost:8080 | register your own, or seed users below |
| API/WS load balancer | http://localhost:8081 (`/api/health`, `/collab/<fileId>`) | — |
| Backend instance 1 (direct) | http://localhost:3001 | — |
| Backend instance 2 (direct) | http://localhost:3002 | — |
| MinIO console | http://localhost:9001 | `minioadmin` / `minioadmin` |

Both backends share one Postgres/Redis/MinIO and converge over the Redis
collaboration bus (`COLLAB_BUS=redis`). To verify scaling manually, point one
browser at `:3001` and another at `:3002`; the frontend normally uses the
load-balanced origin on :8080.

Every backend container runs `prisma migrate deploy` on boot and the
`minio-init` sidecar creates the `collab-snapshots` bucket.

Load demo data (run once, against either instance):

```bash
docker compose exec backend-1 npm run seed
# alice@example.com / password123  (owner)
# bob@example.com   / password123  (editor)
# carol@example.com / password123  (viewer)
```

Open the same project in **two browsers** (or one normal + one incognito
window), log in as Alice and Bob, open `src/index.ts` and type — you will see
live edits, remote cursors/selections and presence avatars.

Run the two-browser E2E suite inside Docker:

```bash
docker compose --profile e2e up --build --abort-on-container-exit --exit-code-from e2e
```

### 3.2 Local development (without Docker for the apps)

Start only the infrastructure:

```bash
docker compose up -d postgres redis minio minio-init
```

Backend (Node 20):

```bash
cd backend
cp .env.example .env                 # adjust DATABASE_URL/REDIS_URL/S3_* if needed
npm install
npx prisma migrate deploy
npm run seed                         # optional
npm run start:dev                    # http://localhost:8080
```

Frontend:

```bash
cd frontend
npm install
npm run dev                          # http://localhost:5173 (proxies to :8080)
```

Playwright E2E against a running stack:

```bash
cd e2e
npm install
npx playwright install chromium     # one-time browser download
E2E_BASE_URL=http://localhost:8080 npm test
# or against the Vite dev server:
E2E_BASE_URL=http://localhost:5173 npm test
```

---

## 4. Environment variables

Backend (see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP/WS port |
| `CORS_ORIGIN` | `http://localhost:5173,...` | comma-separated allowed origins |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | dev values | JWT signing |
| `DATABASE_URL` | local postgres | Prisma connection |
| `REDIS_URL` | `redis://localhost:6379` | presence store |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` | MinIO local | snapshot object store |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | `minioadmin` | S3 credentials |
| `S3_FORCE_PATH_STYLE` | `true` | required for MinIO |
| `PERSIST_FLUSH_MS` | `5000` | max delay before buffered updates hit Postgres |
| `SNAPSHOT_INTERVAL_MS` | `60000` | S3 compaction interval |
| `ROOM_TTL_MS` | `60000` | idle room eviction delay |
| `ROLE_CACHE_MS` | `3000` | how long a live socket's role is cached before re-checking the DB (downgrades take effect within this window) |
| `COLLAB_BUS` | `local` | `local` = single instance (exact phase-1 behaviour), `redis` = cross-instance pub/sub + leader election |
| `BUS_LEASE_MS` | `10000` | persistence-leader lease TTL; renewed each tick, expired leaders fail over within this window |
| `PRESENCE_TTL_SECONDS` | `30` | Redis presence key TTL |

The WebSocket endpoint authenticates with the same JWT, passed as a query
parameter (browsers cannot set headers on the WS handshake):

```
ws://<host>/collab/<fileId>?token=<JWT>
```

---

## 5. Key designs

### 5.1 Why the WebSocket is raw `ws`, not `@nestjs/websockets`

The collaboration channel speaks the **exact binary protocol of the official
[`y-websocket`](https://github.com/yjs/y-websocket) client**, so the browser
uses the stock, battle-tested provider (reconnect/backoff, sync handshake,
awareness, broadcast-channel cross-tab support included). Nest's socket.io
adapter uses a different envelope, so the gateway attaches a
`WebSocketServer({ noServer: true })` to the same Node HTTP server and handles
the `upgrade` event manually for auth + authorization before accepting.

Frame layout (lib0 encoding):

```
SYNC      [0][subtype][...]   subtypes: 0 = step1 (state vector), 1 = step2, 2 = update
AWARENESS [1][length-prefixed encoded awareness update]
QUERY     [3]                  client asks for current awareness states
DENIED    [4][varstring reason] custom: server-side edit rejection (viewers)
```

Flow for `ws://host/collab/:fileId?token=...`:

1. **Upgrade**: verify JWT → look up the file → resolve the caller's project
   role. `401`/`403` are returned as plain HTTP statuses on the handshake.
2. **Join room**: `RoomManager.getOrCreate(fileId)` lazily creates the room and
   loads its Yjs state. The newcomer immediately receives current awareness
   states; the client then sends sync-step-1 and gets the server state.
3. **Sync**: every client sync/update frame is `Y.applyUpdate`-ed into the
   room's `Y.Doc` with the socket as transaction origin. The doc's `update`
   event re-broadcasts the update to every *other* socket.
4. **Awareness**: client awareness updates are applied server-side and fanned
   out, yielding cursors/selections/name/color to all peers.
5. **Live re-authorization applies to EVERY inbound frame, not just
   writes.** Before processing a sync-step1 (document re-pull), a sync-update
   (mutation), an awareness-query or an awareness frame (cursor/presence), the
   gateway re-resolves the caller's current membership (a short per-document
   cache, `ROLE_CACHE_MS`, bounds DB load). An editor downgraded to viewer
   mid-session keeps read access but every mutation is answered with a `[4]`
   denial frame; a member **removed from the project** has their socket closed
   with code `1008` on their very next frame — they cannot silently re-pull the
   full document, keep receiving traffic, or publish cursor state from an idle
   connection. If the permission store is briefly unavailable the frame is
   dropped (fail closed) but the socket is not closed during a transient
   outage.
6. **Proactive kick on removal.** Because a passive connection sends no
   frames at all, role re-checks alone cannot evict a silent eavesdropper.
   Removing a project member in the REST API calls `LiveSessionService.kick`,
   which closes that user's sockets on the local instance immediately and
   publishes a `collab:kick:<userId>` event through the bus so every other
   backend closes the sockets it holds for the same user (no-op with the
   single-instance bus). Broadcast loops already skip non-OPEN sockets, so
   traffic to the victim stops the moment `close()` is issued.
7. **Leave**: on `close` (or ping timeout) the client's awareness ids are
   removed — peers instantly see the cursor disappear — Redis presence is
   deleted, and after `ROOM_TTL_MS` idle the room flushes, snapshots and is
   evicted from memory.

**Authorization is enforced on the data plane, not just the UI**: a viewer can
complete the handshake (needed to *read*) but every sync-update frame they send
is dropped and answered with a `[4]` denial frame instead of being applied or
broadcast. A non-member is closed with `1008` on any frame and on the upgrade.

### 5.2 Yjs persistence: Postgres update log + S3 snapshots

Each file owns one Yjs document whose text lives in `ydoc.getText('content')`.

```
Postgres
  DocumentUpdate(id BIGSERIAL, fileId, update BYTEA)     -- append-only ordered log
  FileSnapshot(fileId, version, s3Key, lastUpdateId)     -- pointer to newest S3 object
S3/MinIO
  snapshots/<fileId>/v<version>-<ts>.bin                 -- Y.encodeStateAsUpdate(doc)
```

- While a room is warm, `doc.on('update')` buffers binary updates in memory.
- Every `PERSIST_FLUSH_MS` the buffer is **merged** (`Y.mergeUpdates`) into one
  ordered row — a 50-keystroke typing burst is one INSERT, not fifty.
- Every `SNAPSHOT_INTERVAL_MS` (and on idle eviction / graceful shutdown) the
  whole doc is compacted with `Y.encodeStateAsUpdate` into one S3 object, a
  `FileSnapshot` row records `lastUpdateId`, and the now-incorporated update
  rows + previous snapshot object are pruned. Only the newest snapshot is
  retained. Snapshot scheduling is driven by a counter of *flushed bytes
  pending compaction* (`bytesAwaitingSnapshot`), **not** by the in-memory
  buffer — the tick empties that buffer first, so keying off it would starve
  snapshots for rooms that stay continuously active.
- Room load = apply newest S3 snapshot, then apply the tail of
  `DocumentUpdate` rows with `id > lastUpdateId`. Replay uses a private
  transaction origin so replayed updates are never persisted again.
- **Eviction never discards edits.** A room is destroyed and removed from
  memory only after its flush to Postgres succeeds (the minimum durable
  step). If flush or snapshot fails (DB/S3 outage), the room — with its
  `Y.Doc` and unflushed buffer intact — stays in memory and is retried after a
  cooldown; reconnecting clients cannot therefore revert to an older version.
  A failed S3 compaction alone does not block eviction: once updates are
  committed to Postgres they remain reconstructable and the next room
  instance compacts them.
- `GET /api/files/:id/content` reconstructs plain text the same way (used by
  tests/E2E to assert autosave); live editing never uses this endpoint.

This gives the standard "checkpoint + WAL" shape: bounded storage, cheap
steady-state writes, and full reconstruction from one object plus a short log.

### 5.3 Presence in Redis

For each open document there is one Redis hash:

```
presence:doc:<fileId>
  field = Yjs awareness clientId
  value = JSON { clientId, userId, name, color, cursor, lastSeen }
```

- Every awareness change writes/updates the hash field and refreshes a TTL
  (`PRESENCE_TTL_SECONDS`, default 30).
- Explicit disconnects delete the field; abnormal crashes rely on the TTL, so
  ghosts disappear within 30 s even if the backend dies.
- Because presence is keyed in Redis rather than in process memory, multiple
  backend instances share one view of "who is in this document".
- The browser UI itself derives its live avatar list from awareness (lowest
  latency); Redis is the durable/cross-instance source used for fan-out and
  cleanup.

### 5.4 Frontend collaboration model

`useYFile(fileId)` owns one `Y.Doc` + one `WebsocketProvider` per open file:

- Awareness local state = `{ user: { id, name, color } }`; `y-monaco` adds the
  cursor/selection field and renders remote selections with the user color.
- `MonacoEditor` binds `ydoc.getText('content')` to the Monaco model via
  `new MonacoBinding(...)`; viewers mount the same binding with Monaco
  `readOnly/domReadOnly`.
- Connection state (`connecting/connected/disconnected`) and a save indicator
  (`Saving… / All changes saved HH:MM:SS`) come from provider status events and
  a `server.savedAt` awareness timestamp the server publishes after each flush
  — no save polling.
- A raw socket listener decodes `[4]` denial frames into an error toast.
- y-websocket handles reconnect with exponential backoff automatically; the
  toolbar also exposes a manual reconnect button.

### 5.5 Horizontal scaling across multiple backends

Phase 1 kept a `Y.Doc` only in the process that owned a room. With more than
one backend replica a socket on instance A could not see updates typed on
instance B. Phase 2 adds an optional **collaboration backplane** behind the
`CollaborationBus` abstraction (`src/collaboration/bus/`), selected by
`COLLAB_BUS`:

| Mode | Behaviour |
| --- | --- |
| `local` (default) | In-process no-op bus. Identical to phase 1; zero overhead. |
| `redis` | Redis pub/sub cross-instance fan-out + Redis lease leader election. |

**Document channel.** Every instance subscribes to `collab:doc:<fileId>` when
a room is created (ref-counted; one SUBSCRIBE per file). Frames carry a 1-byte
kind, an instance-id header and the binary payload:

- `doc-update` — a Yjs update produced by a locally connected client.
- `awareness` — encoded awareness (cursor/selection/user state).
- `sync-step1` / `sync-step2` — targeted bootstrapping (see below).
- `persisted` — a state vector the leader broadcasts after every successful
  flush so followers can release their local safety buffers.

**No-loss persistence model (important).** Updates are buffered locally on
the instance that applies them **regardless of its current leadership state**,
tagged by origin:

- `local` entries come from a socket on this instance. They are buffered from
  the instant the update is applied — before any lease is acquired, through
  no-leader windows, and while a follower — so a keystroke can never live only
  in the transient `Y.Doc`. Local publishes go through an in-order retry
  queue: a failed `PUBLISH` does not drop the update (it is re-tried on every
  tick), and the update stays buffered until durability is confirmed.
- `bus` entries arrived from another instance. A leader buffers them so it can
  flush the fully converged document; a follower never flushes them.

Flow:

1. A client on instance A sends an update → A applies it (the doc listener
   buffers it as `local`), broadcasts to its other local sockets, and
   publishes it to Redis via the retry queue.
2. Instances B/C receive the frame, skip their own instance id, and apply it
   with the `BUS` origin. That fans the update out to their local sockets but
   they never publish it back (no ping-pong). On the elected leader it is
   buffered as `bus`; on followers it only updates the in-memory document.
3. **Single persistence writer.** Each document has one elected leader, keyed
   `collab:lock:doc:<fileId>` (a Redis key with `PX` TTL set/renewed through a
   compare-value Lua script). The leader flushes its merged buffer (local +
   bus = converged state) to Postgres and compacts S3 snapshots exactly as in
   single-instance mode. Followers never write, so the log is never doubled.
4. After each successful flush the leader publishes a `persisted` frame with
   its state vector. A follower then drops its `bus` entries and the prefix of
   `local` entries whose clocks are covered by that vector; local entries not
   yet confirmed remain buffered.
5. Losing leadership **never clears the buffer**. The demoted instance simply
   becomes a follower: it waits for the new leader's `persisted` confirmation,
   or — if it still holds unconfirmed local edits while idle and cannot
   confirm them — its eviction path tries to take the lease back and flush
   itself rather than destroying the room and losing the edits.

**Leader election / failover.** A room campaigns for the lease immediately
when its first client connects (then again on every tick while unowned), so
the no-leader window is near zero; idle empty rooms do not campaign. The
leader renews on every tick well inside `BUS_LEASE_MS` (default 10s). A crashed
leader stops renewing, the key expires, and a follower acquires it. On
takeover the new leader enqueues one full-state checkpoint
(`Y.encodeStateAsUpdate`) for an immediate flush. That covers the edge where
the dead leader had relayed an update to peers but died within its flush
window: the converged state already lives in the new leader's buffer (local
edits are retained without a leader, bus edits since it joined are buffered
once it leads, and the startup sync-step1/2 exchange below fills any earlier
gap) and is persisted in one row. Snapshot/evict logic, including
"flush-failure keeps the room in memory and retries", is unchanged.

**Bootstrap join.** A room loads the durable state (S3 snapshot + Postgres
tail) on creation, then publishes a bus `sync-step1` carrying an empty state
vector a few times (0/100/350/800 ms) to defeat the race where two instances
create rooms for the same new file simultaneously. Any peer with a warm room
answers with a unicast `sync-step2` (targeted via the header's instance id);
the reply is applied with the bus origin. The browser's own y-websocket
handshake is untouched.

**Presence ownership.** The existing `presence:doc:<fileId>` Redis hash is
unchanged, but an instance now writes/removes only fields whose awareness
clientIds belong to sockets it owns (`clientId -> socket` map). A bus-received
awareness change on instance B never overwrites or deletes a heartbeat written
by instance A, and disconnects delete only that instance's owned ids.

**Topology.** `docker compose up` starts `backend-1` and `backend-2` sharing
one Postgres/Redis/MinIO, an internal nginx `gateway` that load-balances both
`/api/` and the `/collab/` WebSocket upgrade (ip_hash for stickiness, though
correctness does not rely on it), and the frontend nginx pointing at that
gateway. You can reach a single instance directly on host ports 3001/3002 to
force a browser onto a chosen backend.

---

## 6. API reference

Auth (public where noted):

```
POST /api/auth/register     { email, name, password }
POST /api/auth/login        { email, password }
GET  /api/auth/me           Authorization: Bearer <token>
```

Projects / members / files (all require the bearer token):

```
POST   /api/projects
GET    /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id                 { name }              (editor+)
DELETE /api/projects/:id                                      (owner)
GET    /api/projects/:id/members
POST   /api/projects/:id/members         { email, role }       (owner)
PATCH  /api/projects/:id/members/:mid    { role }              (owner)
DELETE /api/projects/:id/members/:mid                         (owner)

GET    /api/projects/:projectId/files
POST   /api/projects/:projectId/files    { name, path?, language? }  (editor+)
GET    /api/files/:id
PATCH  /api/files/:id                    { name, path? }       (editor+)
DELETE /api/files/:id                                         (editor+)
GET    /api/files/:id/content            reconstructed plain text
WS     /collab/:fileId?token=...         owner/editor may write, viewer read-only
```

---

## 7. Tests

### 7.1 Backend (71 tests)

```bash
cd backend && npm test
```

- **Unit**: `AuthService` (register/duplicate/login/bcrypt), `PermissionService`
  (role hierarchy, file-role resolution), `FilesService` (CRUD authz, language
  inference, content reconstruction), `PresenceService` (Redis hash/TTL),
  language + color utilities.
- **Room/persistence unit**: update buffering/merge → Postgres, S3 snapshot
  compaction + tail pruning + reload, divergent-client CRDT convergence.
- **HTTP integration** (`test/api.integration.spec.ts`): boots the real Nest
  app with in-memory Prisma/Redis/S3 doubles and exercises register → login →
  project → member → file permission flows end to end.
- **WebSocket integration** (`test/collab.gateway.integration.spec.ts`): real
  HTTP server upgraded by the gateway with **two stock `y-websocket` clients**
  (`disableBc` so traffic really crosses the server) — handshake rejection,
  bidirectional merge, awareness propagation, viewer read-only enforcement,
  disconnect awareness cleanup, Postgres + S3 persistence, live role
  downgrade on an already-open socket, and flush-failure room retention.
- **Bus framing unit** (`bus/collaboration-bus.spec.ts`): binary frame
  round-trip for every message kind, unicode headers, malformed-frame rejection.
- **Multi-instance integration** (`test/collab.multi-instance.integration.spec.ts`):
  TWO fully wired gateways on separate ports sharing one persistence world and
  one `InMemoryCollaborationBus` (which faithfully emulates Redis pub/sub
  publisher-exclusion + TTL leases). Stock y-websocket clients connect to
  *different backends* and assert cross-instance text CRDT convergence,
  cross-instance awareness visibility, viewer denial on a follower instance,
  exactly one elected leader (no doubled `DocumentUpdate` rows), identical
  reconstructed content via the REST endpoint, and leader failover after the
  current leader loses its lease.

### 7.2 Two-browser E2E (Playwright)

`e2e/tests/collaboration.spec.ts` spins up independent browser contexts (so
JWT/sessions are isolated like two real browsers) and asserts:

1. Browser registration + JWT surviving a reload.
2. Owner and editor converge on the same text within milliseconds, each sees
   the other's presence avatar, and autosave is observable via the REST content
   endpoint.
3. Viewer's Monaco is hard read-only, file-management controls are absent, yet
   the viewer still receives the owner's live keystrokes; a viewer REST write
   returns 403.

---

## 8. Acceptance checklist

- [x] Register, login, JWT-protected `/auth/me`
- [x] Create/list projects; file tree; create/rename/delete/read files
- [x] owner/editor/viewer enforced in backend (REST + WS) and reflected in UI
- [x] Removing a member closes their live sockets (locally and across
      instances) and every WS frame re-checks membership, so a stale
      connection can neither re-pull the document nor publish awareness
- [x] Monaco opens files with syntax highlighting and correct language
- [x] WS join/leave/sync/broadcast per `documentId` room
- [x] Yjs is the source of truth; concurrent clients converge (CRDT)
- [x] Remote cursors/selections + colored user names via awareness
- [x] Online user list; Redis-backed presence with TTL
- [x] Autosave: merged updates → Postgres, compacted snapshots → S3/MinIO
- [x] Reconnect with backoff, dead-peer ping/pong, save/connection indicators,
      permission and sync error toasts
- [x] Backend unit + HTTP integration + real WebSocket integration tests pass
      (71/71), including a two-instance cross-backend convergence suite,
      cross-instance kick, and removed-member read/awareness rejection tests
- [x] Playwright two-browser E2E provided and Docker-runnable
- [x] `docker compose up --build` starts TWO backends, an internal load balancer,
      Postgres/Redis/MinIO and the frontend, with migrations and bucket
      creation automated
- [x] Horizontal scaling: same-file edits converge across backend instances via
      Redis pub/sub; awareness/cursors cross instances; one lease-elected
      leader per file persists (no duplicated/lost update rows); leader
      failover reconstructs from S3 snapshot + Postgres tail; `COLLAB_BUS=local`
      preserves exact phase-1 single-instance behaviour

### Possible follow-ups (out of scope here)

Directory CRUD/move, comments & suggestions, conflict-free file rename
awareness, full-deletion snapshot retention / version history UI, JWT refresh
tokens, operational metrics, Redis-cluster/streams as an alternative to
pub/sub for very large rooms.
