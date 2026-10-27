// puppeteer downloads a Chrome on install for local development. A build that brings its own browser
// (Vercel: @sparticuz/chromium; the Docker image: PBCP_CHROMIUM_PATH=/usr/bin/chromium) skips it.
module.exports = { skipDownload: Boolean(process.env.VERCEL || process.env.PBCP_CHROMIUM_PATH) };
