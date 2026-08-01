import { existsSync, writeFileSync } from "node:fs";
import { migrateWorkspaceRegistry } from "../../packages/pi-tai/src/core/storage/custody-migration.ts";
import { resolveStoragePaths } from "../../packages/pi-tai/src/core/storage/paths.ts";
import { openDurableDatabase } from "../../packages/pi-tai/src/core/storage/sqlite.ts";

const [home, agentDir, barrier, ready] = process.argv.slice(2);
writeFileSync(ready, String(process.pid));
const deadline = Date.now() + 30_000;
while (!existsSync(barrier)) {
  if (Date.now() >= deadline) throw new Error("migration barrier timed out");
  await new Promise((resolve) => setTimeout(resolve, 5));
}
const paths = resolveStoragePaths({}, home);
const db = openDurableDatabase({ paths });
try {
  const receipt = migrateWorkspaceRegistry(db, agentDir, paths);
  process.stdout.write(JSON.stringify({ receipt: receipt ?? null }));
} finally {
  db.close();
}
