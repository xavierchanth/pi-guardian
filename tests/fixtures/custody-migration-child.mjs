import { migrateWorkspaceRegistry } from "../../packages/pi-tai/src/core/storage/custody-migration.ts";
import { resolveStoragePaths } from "../../packages/pi-tai/src/core/storage/paths.ts";
import { openDurableDatabase } from "../../packages/pi-tai/src/core/storage/sqlite.ts";

const [home, agentDir] = process.argv.slice(2);
const paths = resolveStoragePaths({}, home);
const db = openDurableDatabase({ paths });
try {
  // Open the shared database before declaring readiness. The parent releases
  // both processes through IPC only after both are at the migration boundary.
  process.send?.({ type: "ready", pid: process.pid });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("migration start barrier timed out")), 120_000);
    timer.unref();
    process.once("message", (message) => {
      if (!message || message.type !== "start") {
        reject(new Error(`unexpected migration barrier message: ${JSON.stringify(message)}`));
        return;
      }
      clearTimeout(timer);
      resolve();
    });
  });
  const receipt = migrateWorkspaceRegistry(db, agentDir, paths);
  process.stdout.write(JSON.stringify({ receipt: receipt ?? null, pid: process.pid }));
} finally {
  db.close();
}
