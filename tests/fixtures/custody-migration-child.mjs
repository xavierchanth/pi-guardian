import { existsSync } from "node:fs";
import { migrateWorkspaceRegistry } from "../../packages/pi-tai/src/core/storage/custody-migration.ts";
import { resolveStoragePaths } from "../../packages/pi-tai/src/core/storage/paths.ts";
import { openDurableDatabase } from "../../packages/pi-tai/src/core/storage/sqlite.ts";

const [home, agentDir, barrier] = process.argv.slice(2);
while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 2));
const paths = resolveStoragePaths({}, home);
const db = openDurableDatabase({ paths });
try {
  const receipt = migrateWorkspaceRegistry(db, agentDir, paths);
  process.stdout.write(JSON.stringify({ receipt: receipt ?? null }));
} finally {
  db.close();
}
