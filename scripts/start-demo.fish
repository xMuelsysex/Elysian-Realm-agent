#!/usr/bin/env fish

set -l script_dir (dirname (status --current-filename))
set -l root_dir "$script_dir/.."
cd "$root_dir"
or exit 1

set -l realm_dir /tmp/elysian-demo-realm
set -l stub_pid_file /tmp/elysian-demo-stub.pid
set -l host_pid_file /tmp/elysian-demo-host.pid
set -l stub_log /tmp/elysian-demo-stub.log
set -l host_log /tmp/elysian-demo-host.log

function stop_group
    set -l pid_file $argv[1]
    if test -f "$pid_file"
        set -l pid (cat "$pid_file")
        if test -n "$pid"
            kill -- "-$pid" 2>/dev/null
        end
    end
end

stop_group "$host_pid_file"
stop_group "$stub_pid_file"
rm -f "$host_pid_file" "$stub_pid_file"

npm run build
or exit $status

mkdir -p "$realm_dir"

setsid nohup node tests/e2e/llm-stub.mjs >"$stub_log" 2>&1 </dev/null &
set stub_pid $last_pid
echo $stub_pid >"$stub_pid_file"

env ELYSIAN_CREDENTIALS_PATH="$root_dir/tests/e2e/stub-credentials.json" ELYSIAN_REALM_DATA="$realm_dir" ELYSIAN_AGENT_HOST=127.0.0.1 ELYSIAN_AGENT_PORT=4322 setsid nohup npm run host >"$host_log" 2>&1 </dev/null &
set host_pid $last_pid
echo $host_pid >"$host_pid_file"

for attempt in (seq 1 20)
    if curl -fsS http://127.0.0.1:4322/healthz >/dev/null 2>&1
        echo "Demo ready: http://127.0.0.1:4322/chat"
        echo "Host log: $host_log"
        echo "Stub log: $stub_log"
        exit 0
    end
    sleep 1
end

echo "Demo failed to become ready."
tail -n 40 "$host_log"
stop_group "$host_pid_file"
stop_group "$stub_pid_file"
exit 1
