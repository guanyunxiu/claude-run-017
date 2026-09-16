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
| CRDT | One server-side `Y.Doc` per file = source of truth; arbitrary concurrent edits merge |
| Cursors | Yjs **Awareness** (`y-monaco`) carries cursor/selection, user name + color |
| Presence | Online users derived from awareness, mirrored into **Redis** with TTL |
| Autosave | Merged Yjs updates appended to Postgres every `PERSIST_FLUSH_MS`; full snapshots compacted into S3 every `SNAPSHOT_INTERVAL_MS` |
| Reliability | y-websocket auto-reconnect with backoff, ws ping/pong dead-peer detection, room TTL eviction, flush-on-shutdown |
| Errors | 401/403 on upgrade and edit frames, viewer edit denials surfaced as toasts, connection/save indicators |

---

## 2. Repository layout

```
.
├── docker-compose.yml          # postgres + redis + minio + backend + frontend (+ e2e profile)
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
│   │   │   ├── room-manager.ts            # Room (Y.Doc + awareness), autosave, snapshots
│   │   │   ├── presence.service.ts        # Redis presence hash + TTL
│   │   │   └── collab.protocol.ts         # lib0/y-protocols frame builders
│   │   ├── storage/             # S3/MinIO client
│   │   └── common/              # Prisma + Redis providers
│   └── test/                    # HTTP integration + WebSocket integration tests
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
| Frontend | http://localhost:8080 | register your own, or seed users below |
| Backend API | http://localhost:8080/api/health | — |
| MinIO console | http://localhost:9001 | `minioadmin` / `minioadmin` |

The backend container runs `prisma migrate deploy` on boot and the
`minio-init` sidecar creates the `collab-snapshots` bucket.

Load demo data (run once):

```bash
docker compose exec backend npm run seed
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
5. **Leave**: on `close` (or ping timeout) the client's awareness ids are
   removed — peers instantly see the cursor disappear — Redis presence is
   deleted, and after `ROOM_TTL_MS` idle the room flushes, snapshots and is
   evicted from memory.

**Authorization is enforced on the data plane, not just the UI**: a viewer can
complete the handshake (needed to *read*) but every sync-update frame they send
is dropped and answered with a `[4]` denial frame instead of being applied or
broadcast.

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
  retained.
- Room load = apply newest S3 snapshot, then apply the tail of
  `DocumentUpdate` rows with `id > lastUpdateId`. Replay uses a private
  transaction origin so replayed updates are never persisted again.
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

### 7.1 Backend (43 tests)

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
  disconnect awareness cleanup, Postgres + S3 persistence.

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
- [x] Monaco opens files with syntax highlighting and correct language
- [x] WS join/leave/sync/broadcast per `documentId` room
- [x] Yjs is the source of truth; concurrent clients converge (CRDT)
- [x] Remote cursors/selections + colored user names via awareness
- [x] Online user list; Redis-backed presence with TTL
- [x] Autosave: merged updates → Postgres, compacted snapshots → S3/MinIO
- [x] Reconnect with backoff, dead-peer ping/pong, save/connection indicators,
      permission and sync error toasts
- [x] Backend unit + HTTP integration + real WebSocket integration tests pass
      (43/43)
- [x] Playwright two-browser E2E provided and Docker-runnable
- [x] `docker compose up --build` starts the entire stack with migrations and
      bucket creation automated

### Phase 2 ideas (out of scope here)

Directory CRUD/move, comments & suggestions, conflict-free file rename
awareness, per-room horizontal scaling with a Redis/Yjs pub/sub backplane,
full-deletion snapshots retention/version history UI, JWT refresh tokens,
operational metrics.
