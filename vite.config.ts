import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: {
    singleQuote: true,
    semi: true,
    overrides: [
      {
        files: ['**/*.md'],
        options: { proseWrap: 'always' },
      },
    ],
  },
  lint: {
    plugins: ['typescript'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    overrides: [
      {
        files: ['apps/web/**'],
        plugins: ['typescript', 'react'],
      },
      {
        files: ['apps/api/**', 'apps/initial-data/**', 'packages/db/**'],
        env: { node: true },
        rules: { 'no-console': 'off' },
      },
    ],
  },
});
