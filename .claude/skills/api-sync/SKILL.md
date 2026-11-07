---
name: api-sync
description: Synchronize mobile client resource catalog with gateway OpenAPI specs
disable-model-invocation: true
---

# API Sync Skill

Synchronize mobile client resource catalog (`lib/api/resources.ts`, `lib/screens/catalog.ts`) with gateway OpenAPI specifications.

## Instructions
1. Run `npm run api:test` to verify all resource assertions.
2. Check that all new gateway endpoints are covered by native views.
