# ChatGPT setup

This project uses **OpenAI Secure MCP Tunnel** as the default ChatGPT connection path. The adapter remains a local stdio MCP server; no public endpoint is required.

## 1. Runtime prerequisites

- Node.js 20+
- Git 2.41+
- current `ocr` CLI with Delegation Mode JSON output
- target repository checked out locally
- OpenAI `tunnel-client`
- Secure MCP Tunnel ID + runtime API key

```bash
npm install -g @alibaba-group/open-code-review
ocr --version
ocr delegate preview --help
ocr delegate rule --help
```

Both delegation commands must support `--format json`. OCR LLM configuration is unnecessary.

## 2. Install and validate the adapter

```bash
git clone https://github.com/yohn-jp/open-code-review-chatgpt.git
cd open-code-review-chatgpt
npm install
npm test
npm run check
npm run doctor -- --repo /absolute/path/to/target-repository
```

You can also inspect the CLI entry point:

```bash
node adapter/src/server.js --help
```

## 3. Configure Secure MCP Tunnel

See [`SECURE_MCP_TUNNEL.md`](SECURE_MCP_TUNNEL.md). Use the official stdio sample and set the MCP command to:

```text
node /absolute/path/to/open-code-review-chatgpt/adapter/src/server.js --repo /absolute/path/to/target-repository
```

## 4. Create the ChatGPT app

In ChatGPT Developer Mode, create a custom MCP app using **Connection: Tunnel**, and select/enter the configured tunnel ID. Keep `tunnel-client run --profile ocr-chatgpt` running while discovering and using the app.

## 5. First validation

Run these cases in order:

1. `adapter_health`
2. workspace review with one tracked edit and one untracked file
3. `main` → feature branch range review
4. single-commit review
5. malicious path/ref inputs to confirm fail-closed validation

A valid review must complete without OCR model credentials and account for every OCR preview `(path,status)` entry.
