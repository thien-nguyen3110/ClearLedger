# ClearLedger

ClearLedger reconciles payment-processor payouts against bank deposits. It compares
what each payout should have been (sales minus fees and refunds, in integer cents)
with what actually reached the bank, sorts every payout into a case, and helps a
reviewer investigate and record a decision with the source records as evidence.

| Case kind | Meaning |
| --- | --- |
| `matched` | The bank received exactly the expected net |
| `amount_mismatch` | A deposit arrived, but for a different amount |
| `awaiting_deposit` | Processor records exist, no deposit yet |
| `ambiguous_deposit` | More than one deposit for one payout |
| `unexpected_deposit` | A deposit with no processor records |

Principles: every amount on screen is calculated by the server from imported
records and traceable to them; reviews are notes, never financial corrections; the
optional local AI (Ollama on your own machine) only drafts a suggested next step
and is always labeled as a draft.

## Stack

- **Backend:** Go (`backend/`). HTTP API, reconciliation domain, event worker.
  Local-file storage for development, or PostgreSQL + Redis + Kafka via Docker Compose.
- **Frontend:** React bundled with esbuild (`web/`), served by the backend from
  `web/dist`. Orange-on-black terminal theme, keyboard triage, printable close report.
- **Investigation:** deterministic rules checklist by default, or a local Ollama
  model (`qwen3:4b-instruct-2507-q4_K_M`) through read-only tools.

## Run it locally (no Docker, no keys)

Requires Go and Node.js.

```powershell
cd web
npm ci
npm run build
cd ..
./scripts/start-local.ps1            # http://127.0.0.1:18080
```

Open the page and click **Load ReconRiver dataset**, or import your own CSV files
from the Imports page. The import format is:

```
id,payout,currency,date,gross_cents,fee_cents,description
```

Amounts are integer cents, processor refunds use a negative gross, and bank rows
have a zero fee. USD only in this release; up to 10,000 records per workspace.

## Run the full stack (Docker Compose)

Create a `.env` file next to `compose.yaml`:

```
POSTGRES_PASSWORD=<random hex, e.g. openssl rand -hex 24>
API_TOKEN=<a different random value, at least 24 characters>
CLEARLEDGER_PORT=8080
OLLAMA_URL=
```

Then:

```powershell
docker compose up -d --build
```

The API and UI listen on `http://127.0.0.1:${CLEARLEDGER_PORT}`. Leave `OLLAMA_URL`
empty for rules mode; `docker compose --profile ai up -d` starts an Ollama service.

## Tests

```powershell
cd backend
go test ./...                                  # unit, regression and dataset tests
docker compose --profile test run --rm backend-test   # service integration tests

cd ../web
npx playwright install chromium
npm run test:e2e                               # 80 browser tests, desktop and mobile
```

## Branches

| Branch | Contents | Based on |
| --- | --- | --- |
| `Frontend-dashboard` | The web UI and its Playwright tests | `main` |
| `Backend-reconciliation` | API, worker, config, Compose, scripts, backend tests | `main` |
| `Backend-dataset` | ReconRiver dataset, importer script, dataset tests | `Backend-reconciliation` |
| `Document-readme` | This README | `main` |

Merge `Backend-reconciliation` before `Backend-dataset`. New work follows the same
pattern: `Frontend-<feature>`, `Backend-<feature>`, `Document-<feature>`.

## Data and attribution

The bundled dataset is derived from "ReconRiver Synthetic Reconciliation Scenarios"
by heybadrinath
(https://huggingface.co/datasets/heybadrinath/reconriver-synthetic-reconciliation),
licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). It is entirely
synthetic: no genuine people, payments or accounts. The changes made are listed in
`backend/testdata/reconriver/ATTRIBUTION.txt`.

Fonts: VT323 and JetBrains Mono, both under the SIL Open Font License (licence
texts in `web/src/fonts/`).

## Licence

MIT. See [LICENSE](LICENSE).
