import { createRequire } from "node:module";
import { defineConfig } from "prisma/config";

type RequireLike = ReturnType<typeof createRequire>;
type LoadPrismaEnvOptions = {
  requireFn?: RequireLike;
  loadEnvFile?: ((path?: string) => void) | null | undefined;
};

export function loadPrismaEnv(options: LoadPrismaEnvOptions = {}) {
  const requireFn = options.requireFn ?? createRequire(import.meta.url);
  const loadEnvFile = options.loadEnvFile === undefined
    ? (process as NodeJS.Process & {
        loadEnvFile?: (path?: string) => void;
      }).loadEnvFile
    : options.loadEnvFile;

  if (typeof loadEnvFile === "function") {
    try {
      loadEnvFile(".env");
      return "node" as const;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw error;
    }
  }

  try {
    requireFn.resolve("dotenv/config");
    requireFn("dotenv/config");
    return "dotenv" as const;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "MODULE_NOT_FOUND") throw error;
    return "existing-env" as const;
  }
}

loadPrismaEnv();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "npx tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"],
  },
});
