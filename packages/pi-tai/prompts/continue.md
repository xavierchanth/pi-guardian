---
description: Reconcile private child contexts, then continue the previous objective
---
Call `reconcile_children` before resuming substantive work. Use its deterministic post-order report to restore the current objective, handle any pending child questions or incidents, and continue independently useful work. Call `await_child_event` only when no independent work remains. Do not recreate terminal, cancelled, mutation-stopped, or unquiesced writers.
