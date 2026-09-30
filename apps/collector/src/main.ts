import { createCollector } from './server.ts';
import { createMemoryStore } from './store.ts';

const port = Number(process.env.PORT ?? 4318);
const server = createCollector({ store: createMemoryStore() });

server.listen(port, () => {
  console.log(`[collector] listening on http://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  });
}
