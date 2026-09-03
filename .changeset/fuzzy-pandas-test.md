---
"@cloudflare/vitest-plugin": minor
---

Support testing container-backed Durable Objects

Projects with containers enabled in their Worker configuration now build or
pull the required images automatically. Tests can exercise the production
`ctx.container` interface without duplicating container configuration in the
Vitest config.
