import { createStoreFromEnv } from "../core/store-factory.js";
import { OpenContinuityError } from "../shared/errors.js";

if ((process.env.OPEN_CONTINUITY_STORE || "postgres") !== "postgres") {
  throw new OpenContinuityError("CONFIGURATION_ERROR", "Database migration requires OPEN_CONTINUITY_STORE=postgres", 500);
}
process.env.OPEN_CONTINUITY_STORE = "postgres";
process.env.OPEN_CONTINUITY_PROFILE = "team";
process.env.OPEN_CONTINUITY_AUTO_MIGRATE = "true";
const runtime = await createStoreFromEnv();
await runtime.store.close?.();
process.stdout.write("OpenContinuity PostgreSQL migration complete\n");
