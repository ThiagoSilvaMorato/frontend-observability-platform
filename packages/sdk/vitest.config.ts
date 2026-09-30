import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'sdk',
    environment: 'happy-dom',
    restoreMocks: true,
    unstubGlobals: true,
  },
});
