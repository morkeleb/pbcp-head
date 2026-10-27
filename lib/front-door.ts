// The head's front door (app/about, served at GET / to a browser; proxy.ts negotiates on Accept, RFC §7.5).

/** Where the protocol is documented. One constant, so a deployment can point it elsewhere. */
export const DOCS_URL = process.env.PBCP_DOCS_URL || 'https://pbcp.dev';
