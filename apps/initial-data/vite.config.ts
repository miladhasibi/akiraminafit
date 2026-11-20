import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/cli.ts'],
    platform: 'node',
    format: 'esm',
    unbundle: true,
    sourcemap: true,
    dts: false,
    deps: {
      neverBundle: ['@akiraminafit/contracts', '@akiraminafit/db'],
    },
  },
});
