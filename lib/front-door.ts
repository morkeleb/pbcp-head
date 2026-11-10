// The head's front door (app/about, served at GET / to a browser; proxy.ts negotiates on Accept, RFC §7.5).

/** Where the protocol is documented. One constant, so a deployment can point it elsewhere. */
export const DOCS_URL = process.env.PBCP_DOCS_URL || 'https://morkeleb.github.io/pbcp';

/** This head's source, and the guide to running it yourself. */
export const GITHUB_URL = 'https://github.com/morkeleb/pbcp-head';
/** What the head keeps, encrypted and not, and who may read it (docs/trust.md). */
export const TRUST_URL = `${GITHUB_URL}/blob/main/docs/trust.md`;
export const DEPLOY_GUIDE_URL = `${GITHUB_URL}/blob/main/docs/deploy.md`;
