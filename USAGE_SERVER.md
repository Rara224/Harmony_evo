# Harmony_Evo Server Usage

## 1. Run The Server

```bash
npm install
npm run server
```

Dashboard:

```text
http://localhost:3456
```

Health check:

```bash
curl http://localhost:3456/api/health
```

## 2. Search Cases

```bash
curl "http://localhost:3456/api/search?q=hvigor%20signingConfigs%20Failed%20to%20find%20signature%20file"
```

The expected top result for that query is:

```text
dc_hm_004 - Hvigor 编译报错：Failed to find signature file
```

## 3. Run Scraping And Extraction

Run an incremental scrape:

```bash
npm run scrape -- --count 30
```

Check scraper status:

```bash
curl http://localhost:3456/api/scrape/status
```

Extract raw candidates into DebugCase records:

```bash
npm run extract
```

## 4. Quality And Promotion

Quality report:

```bash
npm run quality
```

Evolver bridge status:

```bash
npm run status
```

Promote eligible cases:

```bash
npm run promote -- --auto
```

Manually inject a case:

```bash
npm run inject -- --as-gene dc_hm_004
npm run inject -- --as-capsule dc_hm_004
```

## 5. Client Upload Endpoints

The server accepts two review-queue upload types:

```text
POST /api/submissions
POST /api/dev-signals
```

Use `HARMONY_EVO_UPLOAD_TOKEN` if the deployment should require a bearer token:

```bash
export HARMONY_EVO_UPLOAD_TOKEN=your-token
npm run server
```

Submissions and dev-signals are second-pass redacted by the server. High-risk records are quarantined instead of being published directly.

## 6. Current Known Limits

- There are 187 valid DebugCases, but the quality report still flags 539 quality issues.
- The review queue is file-backed JSONL; a full review UI is still a next step.
- `dev-signals -> DebugCase -> Capsule` is not fully automatic yet; it still needs review and structure extraction.
