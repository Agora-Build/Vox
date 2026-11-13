import { pool } from "./storage";
import { CoreRouting, coreOrigin } from "./core-routing";
import { PgCoreDirectory } from "./core-routing-store";

const origin = process.env.VOX_CORE_INTERNAL_URL ? coreOrigin(process.env.VOX_CORE_INTERNAL_URL) : null;
export const coreRouting = new CoreRouting(new PgCoreDirectory(pool), origin, process.env.VOX_CORE_ROUTING_SECRET ?? null);
