import { ConfigError } from '../config-env.js';
import { configWarnings, getHttpConfig, type HttpConfig } from './http-helpers.js';
import { startHttpServer } from './http-server.js';
import { ApolloClient } from '../apollo/client.js';

async function main(): Promise<void> {
  let config: HttpConfig;
  try {
    config = getHttpConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Apollo MCP HTTP server not started: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  try {
    // Validate the upstream client configuration once at startup instead of
    // on every request.
    new ApolloClient();
  } catch (error) {
    console.error(`Apollo MCP HTTP server not started: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  for (const warning of configWarnings(config)) {
    console.error(warning);
  }

  const running = await startHttpServer(config);
  console.error(`Apollo MCP HTTP server listening on http://${config.host}:${running.port}/mcp`);

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down`);
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
