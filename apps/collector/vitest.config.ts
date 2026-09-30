import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'collector',
    environment: 'node',
  },
});
