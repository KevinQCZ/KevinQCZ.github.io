import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)) },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            fileURLToPath(new URL('./migrations', import.meta.url))
          )
        }
      }
    }))
  ],
  test: { include: ['worker/test/**/*.test.ts'] }
});
