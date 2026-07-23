---
description: Collect fresh status reports from the complete active subagent tree
---

Call `collect_status` now. Present its aggregated tree, including any descendants that timed out after 30 seconds. Do not treat this as terminal result collection. After reporting the snapshot, continue the prior orchestration and return to `wait_for_children` while any owned child remains outstanding.
