# Agent concurrency benchmark

This is an opt-in harness-improvement benchmark, not a correctness or merge gate.

Validate case schemas and deterministic Real-JJ fixture setup without invoking a model:

```bash
npm run eval:agent-concurrency
```

Explicitly run live model cases:

```bash
npm run eval:agent-concurrency:live
```

Live execution loads only this distribution with `pi -ne -e <distribution>`. Reports are written beneath `reports/` and ignored by version control. Deterministic domain, executor, Real-JJ operation, and fake-model SDK tests remain the correctness suite.
