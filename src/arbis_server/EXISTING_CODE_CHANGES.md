# Changes to existing OpenConnector code

Everything Arbis-specific lives in `src/arbis_server/`. This file lists every edit made
**outside** that folder, so they can be re-applied or reverted after an upstream merge.

Each edit is wrapped in `// arbis changes start` / `// arbis changes end` comments.
Find them all with:

```bash
grep -rn "arbis changes" src --include=*.ts
```

## Log

| # | File | What changed | Why |
|---|---|---|---|
| 1 | `src/server/index.ts` | Import `createArbisApp` from `../arbis_server/arbis-app.ts` | Needed to mount Arbis routes |
| 2 | `src/server/index.ts` | `app.route("/", createArbisApp((request) => runtime.fetch(request)));` right after `new Hono()` in `main()` | Registers Arbis routes (e.g. `POST /api/connect`) before the existing catch-all; unmatched requests fall through unchanged |

Pure additions: no existing line is modified.

## Revert

In `src/server/index.ts`, remove the import (#1) and the `app.route` line (#2).

## Adding a new change

Wrap the edit in `// arbis changes start` / `// arbis changes end` and add a row to the table above.
New Arbis HTTP routes do not need an existing-code change: add a factory to `arbisRouteRegistry` in
`arbis-app.ts`.
