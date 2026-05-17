import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,js}'],
  },
  resolve: {
    alias: {
      '@earendil-works/pi-coding-agent': path.resolve(__dirname, 'tests/__mocks__/pi-coding-agent.ts'),
      '@earendil-works/pi-tui': path.resolve(__dirname, 'tests/__mocks__/pi-tui.ts'),
      '@earendil-works/pi-ai': path.resolve(__dirname, 'tests/__mocks__/pi-tui.ts'),
      '@earendil-works/pi-agent-core': path.resolve(__dirname, 'tests/__mocks__/pi-tui.ts'),
      '@sinclair/typebox': path.resolve(__dirname, 'tests/__mocks__/@sinclair/typebox.ts'),
    },
  },
});
