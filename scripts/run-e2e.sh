#!/bin/bash
# End-to-end SSE verification against a local OpenAI-compatible streaming stub.
#
#   npm run verify:e2e                     # build + verify against the stub
#   ELYSIAN_CREDENTIALS_PATH=<real> bash scripts/run-e2e.sh   # verify against a real relay
#
# The stub streams reply deltas (120ms apart) and answers the affect-analysis
# call with canned JSON, so the whole real-code path is exercised: pi-ai HTTP
# streaming -> text_delta subscription -> SSE frames -> host persistence.
set -u
cd "$(dirname "$0")/.."

export STUB_PORT="${STUB_PORT:-4330}"
if [ -z "${E2E_HOST_PORT:-}" ]; then
  E2E_HOST_PORT="$(node --input-type=module -e 'import net from "node:net"; const server = net.createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });')"
fi
export E2E_HOST_PORT

node tests/e2e/llm-stub.mjs > /tmp/elysian-e2e-stub.log 2>&1 &
STUB_PID=$!
cleanup() {
  kill "$STUB_PID" 2>/dev/null
}
trap cleanup EXIT
sleep 1

node tests/e2e/verify-sse.mjs
