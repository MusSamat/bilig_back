/** bilig_back entrypoint — starts the HTTP server. */
import { buildServer } from './server.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

const app = buildServer();
app
  .listen({ port, host })
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`bilig_back listening on http://${host}:${port}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
