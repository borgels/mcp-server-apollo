import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApolloClient, type ApolloClientOptions } from './apollo/client.js';
import { registerApolloTools } from './tools/apollo.js';

export interface CreateServerOptions {
  client?: ApolloClient;
  clientOptions?: ApolloClientOptions;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'apollo-io',
    version: '0.1.0',
  });

  const client = options.client ?? new ApolloClient(options.clientOptions);
  registerApolloTools(server, client);

  return server;
}
