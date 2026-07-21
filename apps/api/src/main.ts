import { createApplication } from './app.js';
import { resolveOptions } from './config.js';

async function bootstrap(): Promise<void> {
  const options = resolveOptions();
  const app = await createApplication(options);
  await app.listen(options.port, options.host);
  // Do not print credentials. The bootstrap username is enough for local diagnostics.
  console.log(`Content Agent API listening on http://${options.host}:${options.port}`);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
