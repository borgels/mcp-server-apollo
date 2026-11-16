import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApolloClient, type ApolloClientOptions } from './apollo/client.js';
import { registerApolloTools } from './tools/apollo.js';
import { PACKAGE_VERSION } from './version.js';

export interface CreateServerOptions {
  client?: ApolloClient;
  clientOptions?: ApolloClientOptions;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'apollo-io',
    version: PACKAGE_VERSION,
  });

  const client = options.client ?? new ApolloClient(options.clientOptions);
  registerApolloTools(server, client);

  return server;
}
