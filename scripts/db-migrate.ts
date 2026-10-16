/** npm run db:migrate — creates/updates data/app.sqlite and seeds default presets. */
import { openAppDb } from "../src/db/client";
import { structureProfiles } from "../src/db/schema";

const db = openAppDb();
console.log("profiles:", db.select().from(structureProfiles).all().map((p) => p.name));
console.log("OK → data/app.sqlite");
