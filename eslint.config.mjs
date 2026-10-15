import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // The calculation engine must stay pure: no I/O, no DB, no network.
    files: ["src/engine/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/db/*", "@/esi/*", "@/sde/*", "../db/*", "../esi/*", "../sde/*"], message: "engine must stay pure (no db/esi/sde imports)" },
            { group: ["fs", "node:*", "better-sqlite3"], message: "engine must stay pure (no I/O)" },
          ],
        },
      ],
      "no-restricted-globals": ["error", { name: "fetch", message: "engine must stay pure (no network)" }],
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "data/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
