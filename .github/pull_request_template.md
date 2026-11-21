## Summary
<!-- What changed and why, in 2-3 lines. -->

## Area
- [ ] apps/web (frontend)
- [ ] apps/api (backend)
- [ ] packages/
- [ ] infra/ (Docker, Compose, deploy)
- [ ] .github/ or scripts/

## Tests run
- [ ] `npm run test:api` (go vet + go test in apps/api)
- [ ] `npm run build:web`
- [ ] `docker compose -f infra/docker/compose.yaml config --quiet`
- [ ] Other:

## Before merge
- [ ] Docs and secrets audit: no `.env`, tokens, private docs or `coordination/` files in the diff
- [ ] Roadmap entry updated (ROADMAP.jsonl / roadmap/ROADMAP.md)
