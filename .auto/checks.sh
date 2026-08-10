#!/bin/bash
set -euo pipefail
# 正确性门禁：npm test 全量（build + 测试编译 + node --test）。
# 成功时静默；失败时把失败输出尾部传给 agent。
cd "$(dirname "$0")/.."

if npm test >/tmp/elysian-check.log 2>&1; then
  exit 0
fi
tail -60 /tmp/elysian-check.log
exit 1
