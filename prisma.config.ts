import "dotenv/config";
import { defineConfig } from "prisma/config";
import { resolvePrismaCliDatabaseUrl } from "./prisma/cli-database-url";

// The CLI's database URL (MIGRATE_DATABASE_URL vs DATABASE_URL, fail-closed on mismatch, optional
// at `prisma generate` time) is resolved in prisma/cli-database-url.ts — see the rules there.
export default defineConfig({
    schema: "prisma/schema.prisma",

    migrations: {
        path: "prisma/migrations",
    },

    datasource: {
        url: resolvePrismaCliDatabaseUrl(process.env),
    },
});
