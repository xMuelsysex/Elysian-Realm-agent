#!/bin/bash
set -euo pipefail
# 正确性门禁：npm test 全量（build + 测试编译 + node --test）。
# 只让错误通过，抑制成功输出。
cd "$(dirname "$0")/.."
npm test 2>&1 | grep -E "^(not ok|# fail|✖|TypeError|Error:)" | head -40
if npm test >/dev/null 2>&1; then
  exit 0
fi
exit 1
