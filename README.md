# Harmony_Evo Server

This branch contains the server-side Harmony_Evo asset hub.

It manages HarmonyOS DebugCase assets, scraped raw candidates, dev-signal review queues, feedback, and GEP promotion into Gene/Capsule assets. Client adapters live on the `client` branch; the full monorepo lives on `main`.

## Current Snapshot

| Item | Status |
| --- | --- |
| Local API | `http://localhost:3456` |
| DebugCases | 187 valid cases |
| Raw Candidates | 213 |
| Dev Signals | 40 |
| Harmony Genes | 3 |
| Evolver | connected |

## Start

```bash
npm install
npm run server
```

Open:

```text
http://localhost:3456
```

## Verify

```bash
npm test
npm run test:functional
npm run quality
npm run status
```

## Main APIs

- `GET /api/stats`
- `GET /api/search?q=...`
- `GET /api/cases`
- `GET /api/cases/:id`
- `POST /api/cases/:id/match`
- `POST /api/feedback/:id`
- `GET /api/scrape/status`
- `POST /api/scrape`
- `GET /api/evolver`
- `POST /api/promote/:id`
- `POST /api/submissions`
- `GET /api/submissions`
- `POST /api/dev-signals`
- `GET /api/dev-signals`
- `GET /api/health`

## Documentation

- `USAGE_SERVER.md`: server operation guide.
- `PRODUCT.md`: product design and roadmap.
- `docs/HARMONY_EVO_STATUS_REVIEW.md`: status review.
- `docs/SERVER_CLIENT_ASSET_HUB_PLAN.md`: server/client asset hub plan.

## Data Safety

Runtime credentials are intentionally not tracked:

- `.env`
- `.forum_session_storage.json`
- `opencode.jsonc`
- `.opencode/`
- `node_modules/`

Uploaded submissions and dev-signals are stored as review queues and are not automatically promoted into the official case library.
