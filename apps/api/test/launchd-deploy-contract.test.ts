import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const runtimePaths = [
  'apps/api/dist',
  'apps/web/dist',
  'packages/agent-core/dist',
  'packages/agent-harness-core/dist',
  'node_modules',
  'apps/api/node_modules',
  'apps/web/node_modules',
];

type DeployFailureMode =
  | 'success'
  | 'typecheck-fails'
  | 'ci-red'
  | 'restart-fails'
  | 'listener-missing'
  | 'old-health-fails'
  | 'preflight-not-loaded'
  | 'service-changed-before-restart'
  | 'old-pid-still-listening'
  | 'listener-job-mismatch'
  | 'smoke-fails'
  | 'verify-fails'
  | 'signal'
  | 'bootout-race';

function writeExecutable(path: string, source: string) {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o700);
}

function runDeployFailure(mode: DeployFailureMode) {
  const work = mkdtempSync(join(tmpdir(), 'content-agent-deploy-rollback-'));
  const home = join(work, 'home');
  const bin = join(work, 'bin');
  const commandLog = join(work, 'commands.log');
  const launchdState = join(work, 'launchd-state');
  const listenerState = join(work, 'listener-state');
  const processState = join(work, 'process-state');
  const kickstartCount = join(work, 'kickstart-count');
  const bootoutCount = join(work, 'bootout-count');
  const printCount = join(work, 'print-count');
  const apiPlist = join(work, 'com.xhsai.api.plist');
  const launchdBin = join(home, 'Library/Application Support/xhsai/bin');

  mkdirSync(bin, { recursive: true });
  mkdirSync(join(work, 'scripts'), { recursive: true });
  mkdirSync(join(work, 'ops/launchd'), { recursive: true });
  mkdirSync(launchdBin, { recursive: true });
  mkdirSync(processState, { recursive: true });
  if (mode !== 'preflight-not-loaded') {
    writeFileSync(launchdState, '4100\n', 'utf8');
    writeFileSync(listenerState, '4100\n', 'utf8');
    writeFileSync(join(processState, '4100'), 'start-old\n', 'utf8');
  }
  writeFileSync(apiPlist, '<plist/>\n', 'utf8');
  writeFileSync(commandLog, '', 'utf8');

  for (const path of runtimePaths) {
    mkdirSync(join(work, path), { recursive: true });
    writeFileSync(join(work, path, 'marker.txt'), 'old\n', 'utf8');
  }
  mkdirSync(join(work, 'data/knowledge'), { recursive: true });
  mkdirSync(join(work, 'data/images'), { recursive: true });
  writeFileSync(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
  writeFileSync(join(work, 'package.json'), '{"name":"fixture","private":true}\n', 'utf8');
  const fixtureDatabase = new DatabaseSync(join(work, 'data/app.db'));
  fixtureDatabase.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('installed-helper-ran');");
  fixtureDatabase.close();
  writeExecutable(join(work, 'scripts/backup-production.sh'), '#!/bin/sh\nexit 0\n');
  writeExecutable(join(work, 'scripts/health-watch.sh'), '#!/bin/sh\n# new\nexit 0\n');
  writeFileSync(join(work, 'scripts/prepare-backup.mjs'), read('scripts/prepare-backup.mjs'), 'utf8');
  writeFileSync(join(work, 'scripts/backup-manifest.mjs'), read('scripts/backup-manifest.mjs'), 'utf8');
  writeFileSync(join(work, 'scripts/storage-paths.mjs'), read('scripts/storage-paths.mjs'), 'utf8');
  writeExecutable(
    join(work, 'ops/launchd/verify.sh'),
    [
      '#!/bin/sh',
      `printf "verify\\n" >> ${JSON.stringify(commandLog)}`,
      'if [ "$FIXTURE_MODE" = "verify-fails" ]; then',
      `  ${JSON.stringify(process.execPath)} ${JSON.stringify(join(launchdBin, 'prepare-backup.mjs'))} --prepare "$FIXTURE_ROOT" "$FIXTURE_ROOT/installed-backup-stage" || exit $?`,
      '  exit 23',
      'fi',
      'if [ "$FIXTURE_MODE" = "signal" ]; then kill -TERM "$PPID"; fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  for (const name of ['backup-production.sh', 'health-watch.sh', 'prepare-backup.mjs', 'backup-manifest.mjs', 'storage-paths.mjs']) {
    writeFileSync(join(launchdBin, name), `old ${name}\n`, 'utf8');
  }

  const shellValue = (value: string) => JSON.stringify(value);
  writeExecutable(
    join(bin, 'git'),
    [
      '#!/bin/sh',
      `LOG=${shellValue(commandLog)}`,
      'printf "git %s\\n" "$*" >> "$LOG"',
      'if [ "${1:-}" = "branch" ]; then printf "main\\n"; exit 0; fi',
      'if [ "${1:-}" = "status" ]; then exit 0; fi',
      'if [ "${1:-}" = "remote" ]; then printf "https://github.com/fixture/xiaohongshu.git\\n"; exit 0; fi',
      'if [ "${1:-}" = "rev-parse" ]; then printf "fixture-revision\\n"; exit 0; fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  writeExecutable(join(bin, 'node'), '#!/bin/sh\nprintf "v24.19.0\\n"\n');
  writeExecutable(
    join(bin, 'npm'),
    [
      '#!/bin/sh',
      `LOG=${shellValue(commandLog)}`,
      'printf "npm %s\\n" "$*" >> "$LOG"',
      'if [ "${1:-}" = "ci" ]; then',
      '  for path in apps/api/dist apps/web/dist packages/agent-core/dist packages/agent-harness-core/dist node_modules apps/api/node_modules apps/web/node_modules; do',
      '    mkdir -p "$path"',
      '    printf "new\\n" > "$path/marker.txt"',
      '  done',
      'fi',
      'if [ "${1:-} ${2:-}" = "run typecheck" ] && [ "$FIXTURE_MODE" = "typecheck-fails" ]; then',
      '  exit 11',
      'fi',
      'if [ "${1:-} ${2:-}" = "run smoke:production" ] && { [ "$FIXTURE_MODE" = "smoke-fails" ] || [ "$FIXTURE_MODE" = "bootout-race" ]; }; then',
      '  exit 17',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  writeExecutable(
    join(bin, 'npx'),
    `#!/bin/sh\nprintf "npx %s\\n" "$*" >> ${shellValue(commandLog)}\nexit 0\n`,
  );
  writeExecutable(
    join(bin, 'sudo'),
    `#!/bin/sh\nprintf "sudo %s\\n" "$*" >> ${shellValue(commandLog)}\nexec "$@"\n`,
  );
  writeExecutable(
    join(bin, 'launchctl'),
    [
      '#!/bin/sh',
      `LOG=${shellValue(commandLog)}`,
      `STATE=${shellValue(launchdState)}`,
      `LISTENER=${shellValue(listenerState)}`,
      `PROCESSES=${shellValue(processState)}`,
      `COUNT=${shellValue(kickstartCount)}`,
      `BOOTOUT_COUNT=${shellValue(bootoutCount)}`,
      `PRINT_COUNT=${shellValue(printCount)}`,
      'printf "launchctl %s\\n" "$*" >> "$LOG"',
      'case "${1:-}" in',
      '  print)',
      '    if printf "%s" "$*" | grep -q "gui/"; then exit 113; fi',
      '    [ -f "$STATE" ] || exit 113',
      '    prints=0',
      '    [ ! -f "$PRINT_COUNT" ] || prints="$(cat "$PRINT_COUNT")"',
      '    prints=$((prints + 1))',
      '    printf "%s\\n" "$prints" > "$PRINT_COUNT"',
      '    if [ "$FIXTURE_MODE" = "service-changed-before-restart" ] && [ "$prints" -eq 2 ]; then',
      '      old_pid="$(cat "$STATE")"',
      '      rm -f "$PROCESSES/$old_pid"',
      '      printf "4150\\n" > "$STATE"',
      '      printf "4150\\n" > "$LISTENER"',
      '      printf "start-4150\\n" > "$PROCESSES/4150"',
      '    fi',
      '    printf "state = running\\npid = %s\\n" "$(cat "$STATE")"',
      '    ;;',
      '  bootout)',
      '    old_pid=""',
      '    [ ! -f "$STATE" ] || old_pid="$(cat "$STATE")"',
      '    [ -z "$old_pid" ] || rm -f "$PROCESSES/$old_pid"',
      '    rm -f "$STATE" "$LISTENER"',
      '    bootouts=0',
      '    [ ! -f "$BOOTOUT_COUNT" ] || bootouts="$(cat "$BOOTOUT_COUNT")"',
      '    bootouts=$((bootouts + 1))',
      '    printf "%s\\n" "$bootouts" > "$BOOTOUT_COUNT"',
      '    if [ "$FIXTURE_MODE" = "bootout-race" ] && [ "$bootouts" -eq 1 ]; then exit 3; fi',
      '    ;;',
      '  bootstrap)',
      '    old_pid=""',
      '    [ ! -f "$STATE" ] || old_pid="$(cat "$STATE")"',
      '    [ -z "$old_pid" ] || rm -f "$PROCESSES/$old_pid"',
      '    printf "4250\\n" > "$STATE"',
      '    printf "4250\\n" > "$LISTENER"',
      '    printf "start-4250\\n" > "$PROCESSES/4250"',
      '    ;;',
      '  kickstart)',
      '    count=0',
      '    [ ! -f "$COUNT" ] || count="$(cat "$COUNT")"',
      '    count=$((count + 1))',
      '    printf "%s\\n" "$count" > "$COUNT"',
      '    if { [ "$FIXTURE_MODE" = "restart-fails" ] || [ "$FIXTURE_MODE" = "old-health-fails" ]; } && [ "$count" -eq 1 ]; then',
      '      exit 9',
      '    fi',
      '    if [ "$FIXTURE_MODE" = "old-pid-still-listening" ] && [ "$count" -eq 1 ]; then',
      '      exit 0',
      '    fi',
      '    old_pid=""',
      '    [ ! -f "$STATE" ] || old_pid="$(cat "$STATE")"',
      '    [ -z "$old_pid" ] || rm -f "$PROCESSES/$old_pid"',
      '    if [ "$count" -eq 1 ]; then new_pid=4200; else new_pid=4300; fi',
      '    printf "%s\\n" "$new_pid" > "$STATE"',
      '    printf "start-%s\\n" "$new_pid" > "$PROCESSES/$new_pid"',
      '    if [ "$FIXTURE_MODE" = "listener-missing" ] && [ "$count" -eq 1 ]; then',
      '      rm -f "$LISTENER"',
      '    elif [ "$FIXTURE_MODE" = "listener-job-mismatch" ] && [ "$count" -eq 1 ]; then',
      '      printf "4201\\n" > "$LISTENER"',
      '      printf "start-4201\\n" > "$PROCESSES/4201"',
      '    else',
      '      printf "%s\\n" "$new_pid" > "$LISTENER"',
      '    fi',
      '    ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
  );
  writeExecutable(
    join(bin, 'lsof'),
    `#!/bin/sh\n[ ! -s ${shellValue(listenerState)} ] || cat ${shellValue(listenerState)}\n`,
  );
  writeExecutable(
    join(bin, 'ps'),
    [
      '#!/bin/sh',
      `PROCESSES=${shellValue(processState)}`,
      'pid=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-p" ]; then shift; pid="${1:-}"; fi',
      '  shift || true',
      'done',
      '[ -n "$pid" ] && [ -f "$PROCESSES/$pid" ] || exit 1',
      'cat "$PROCESSES/$pid"',
      '',
    ].join('\n'),
  );
  writeExecutable(
    join(bin, 'curl'),
    [
      '#!/bin/sh',
      `printf "curl %s\\n" "$*" >> ${shellValue(commandLog)}`,
      'if printf "%s" "$*" | grep -q api.github.com; then',
      '  if [ "$FIXTURE_MODE" = "ci-red" ]; then',
      '    printf \'{"workflow_runs":[{"name":"CI","head_sha":"fixture-revision","status":"completed","conclusion":"failure"}]}\'',
      '  else',
      '    printf \'{"workflow_runs":[{"name":"CI","head_sha":"fixture-revision","status":"completed","conclusion":"success"}]}\'',
      '  fi',
      '  exit 0',
      'fi',
      'if [ "$FIXTURE_MODE" = "old-health-fails" ]; then',
      '  printf \'{"status":"degraded","databaseWritable":false}\'',
      'else',
      '  printf \'{"status":"ok","databaseWritable":true}\'',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  writeExecutable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');

  const result = spawnSync('bash', [join(root, 'scripts/deploy.sh')], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CONTENT_AGENT_ROOT: work,
      CONTENT_AGENT_API_PLIST: apiPlist,
      CONTENT_AGENT_DEPLOY_HEALTH_WAIT_SECONDS: '1',
      CONTENT_AGENT_DEPLOY_POLL_INTERVAL_SECONDS: '1',
      OPS_ENV_FILE: join(work, 'missing-ops.env'),
      FIXTURE_ROOT: work,
      FIXTURE_MODE: mode,
      PUBLIC_SMOKE_BASE_URL: '',
      PUBLIC_HEALTH_URL: '',
      REQUIRE_PUBLIC_SMOKE: '0',
    },
  });

  return {
    work,
    result,
    commandLog,
    rollbackDirs: () => readdirSync(work).filter((name) => name.startsWith('.deploy-rollback.')),
  };
}

test('Node 24 合同由 nvm、package 与 CI 同源钉定', () => {
  assert.ok(existsSync(join(root, '.nvmrc')), '.nvmrc 必须存在');
  assert.equal(read('.nvmrc').trim(), '24');
  assert.match(read('package.json'), /"node":\s*">=24\.0"/u);
  assert.match(read('.github/workflows/ci.yml'), /node-version:\s*24/u);
});

test('三个 LaunchDaemon 模板均以普通用户运行且不携带秘密', () => {
  const paths = [
    'ops/launchd/com.xhsai.api.plist.template',
    'ops/launchd/com.xhsai.backup.plist.template',
    'ops/launchd/com.xhsai.health-watch.plist.template',
  ];
  for (const path of paths) {
    assert.ok(existsSync(join(root, path)), `${path} 必须存在`);
    const source = read(path);
    assert.match(source, /<key>UserName<\/key>\s*<string>__USER__<\/string>/u);
    assert.match(source, /<key>GroupName<\/key>\s*<string>__GROUP__<\/string>/u);
    assert.doesNotMatch(source, /ALERT_WEBHOOK|BACKUP_REMOTE/u);
  }

  const api = read(paths[0]!);
  assert.match(api, /__NODE_BIN__/u);
  assert.match(api, /--env-file=__REPO__\/\.env/u);
  assert.doesNotMatch(api, /env-file-if-exists/u);
  assert.match(api, /<key>NODE_ENV<\/key>\s*<string>production<\/string>/u);
  const backup = read(paths[1]!);
  const watcher = read(paths[2]!);
  assert.match(backup, /com\.xhsai\.backup/u);
  assert.match(backup, /CONTENT_AGENT_NODE_BIN/u);
  assert.match(backup, /prepare-backup\.mjs/u);
  assert.match(watcher, /com\.xhsai\.health-watch/u);
  assert.match(watcher, /CONTENT_AGENT_NODE_BIN/u);
  assert.match(watcher, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/u);
});

test('launchd 安装器先留回滚证据，健康后才卸载旧 Agents', () => {
  const installerPath = 'ops/launchd/install.sh';
  const verifierPath = 'ops/launchd/verify.sh';
  assert.ok(existsSync(join(root, installerPath)), 'install.sh 必须存在');
  assert.ok(existsSync(join(root, verifierPath)), 'verify.sh 必须存在');
  const installer = read(installerPath);
  assert.match(installer, /launchd-backups/u);
  assert.match(installer, /trap rollback ERR/u);
  assert.match(installer, /plutil -lint/u);
  assert.match(installer, /v24\./u);
  assert.match(installer, /launchd-installer/u, '普通用户阶段必须先把安装资产移出 Desktop');
  assert.match(installer, /exec sudo/u, '移出 TCC 路径后才进入特权阶段');
  assert.ok(
    installer.indexOf('cd "$STAGED_DIR"') < installer.indexOf('exec sudo'),
    'sudo 必须继承 Application Support 当前目录而不是 Desktop',
  );
  assert.match(installer, /launchctl asuser/u, '管理员安装器读取桌面仓库时必须切回普通用户 TCC 上下文');
  assert.match(installer, /copyFileSync/u, 'TCC 环境下应复用已获授权的 Node 读取仓库脚本');
  assert.match(installer, /prepare-backup\.mjs/u);
  assert.match(installer, /backup-manifest\.mjs/u);
  assert.match(installer, /storage-paths\.mjs/u);
  assert.match(installer, /wait_for_unloaded/u, '同标签替换必须等待旧 launchd job 完全移除');
  assert.match(installer, /wait_for_successful_oneshot/u, '卸载旧任务前必须确认新备份和看门狗实际成功');
  assert.match(installer, /CONTENT_AGENT_LAUNCHD_ONESHOT_TIMEOUT_SECONDS/u);
  assert.match(
    installer,
    /CONTENT_AGENT_LAUNCHD_ONESHOT_TIMEOUT_SECONDS="\$ONESHOT_TIMEOUT_SECONDS"/u,
    '普通用户入口必须把已校验的一次性任务超时传给 sudo 特权阶段',
  );
  assert.ok(
    installer.indexOf('case "$ONESHOT_TIMEOUT_SECONDS"') < installer.indexOf('exec sudo'),
    '一次性任务超时必须先完成正整数校验，再进入 sudo',
  );
  assert.match(
    installer,
    /ROLLBACK_DIR="\$\(mktemp -d "\$ROLLBACK_ROOT\/launchd\.XXXXXX"\)"/u,
    '安装回滚目录必须用 mktemp 唯一创建',
  );
  assert.match(
    installer,
    /: > "\$ROLLBACK_DIR\/loaded-labels\.txt"/u,
    'system loaded 状态清单必须截断新建',
  );
  assert.match(
    installer,
    /: > "\$ROLLBACK_DIR\/loaded-legacy-labels\.txt"/u,
    'GUI loaded 状态清单必须截断新建',
  );
  assert.match(installer, /bin-backups/u, '运维脚本必须与 plist 一起具备回滚副本');
  assert.match(installer, /rollback_failed/u, '安装回滚必须汇总并暴露恢复失败');
  assert.match(installer, /verify_rollback_health/u, '恢复旧 API 后必须重新验证健康');
  assert.doesNotMatch(installer, /launchctl bootstrap system [^\n]*\|\| true/u);
  assert.ok(
    installer.indexOf('trap rollback ERR') < installer.indexOf('copyFileSync(backupSource'),
    '覆盖已安装运维脚本前必须启用回滚',
  );
  assert.match(installer, /\$\{NODE_VERSION\}；/u, 'bash 3.2 下变量紧邻中文标点必须使用花括号');
  assert.match(installer, /com\.content-agent\.backup/u);
  assert.match(installer, /com\.content-agent\.health-watch/u);
  assert.match(installer, /\$TARGET_HOME\/Library\/LaunchAgents/u);
  assert.match(installer, /legacy-launchagents/u, '历史 plist 必须复制进本轮回滚目录');
  assert.match(installer, /loaded-legacy-labels\.txt/u, '必须记录安装前真实加载的 GUI job');
  assert.match(installer, /job_pid_from_file/u, '每次 bootout 前必须保存 launchctl job PID');
  assert.match(installer, /process_start_id/u, 'PID 等待必须防止复用误判');
  assert.match(installer, /wait_for_original_pid_exit/u);
  assert.match(installer, /wait_for_gui_unloaded/u);
  const guiWaitBody = installer.slice(
    installer.indexOf('wait_for_gui_unloaded()'),
    installer.indexOf('verify_rollback_health()'),
  );
  assert.match(
    guiWaitBody,
    /else\s+status=\$\?/u,
    '等待 GUI job 时必须保留 launchctl 的真实失败码，不能把 if 的 0 状态当成卸载成功',
  );
  assert.match(installer, /rm -f "\$legacy_plist"/u, '卸载后必须移除原 LaunchAgent plist');
  assert.match(installer, /run_as_user \/bin\/launchctl bootstrap "gui\/\$TARGET_UID"/u);
  const cleanupBody = installer.slice(
    installer.indexOf('cleanup_legacy_launch_agents()'),
    installer.indexOf('\nverify_health\n'),
  );
  assert.ok(
    cleanupBody.indexOf('bootout_gui_job "$label"') <
      cleanupBody.indexOf('rm -f "$legacy_plist"'),
    '历史 GUI job 必须完成带 PID 等待的 bootout 后才能删除 plist',
  );
  assert.ok(
    installer.lastIndexOf('wait_for_successful_oneshot com.xhsai.backup') <
      installer.lastIndexOf('cleanup_legacy_launch_agents'),
    '必须在新备份实际成功后才触碰旧 LaunchAgent',
  );
  assert.ok(
    installer.indexOf('cp -p "$legacy_plist"') < installer.indexOf('cleanup_legacy_launch_agents'),
    '历史 plist 必须在清理函数执行前备份',
  );
  assert.ok(
    installer.lastIndexOf('verify_latest_backup') <
      installer.lastIndexOf('cleanup_legacy_launch_agents'),
    '只有新 Daemon 与备份全部通过后才能清理旧 LaunchAgent',
  );
  const rollbackBody = installer.slice(
    installer.indexOf('rollback()'),
    installer.indexOf('trap rollback ERR'),
  );
  assert.ok(
    rollbackBody.indexOf('cp -p "$LEGACY_BACKUP_DIR/$label.plist"') <
      rollbackBody.indexOf('restore_loaded_legacy_jobs'),
    '回滚必须先恢复旧 plist，再按安装前 loaded 集合重新 bootstrap',
  );
  assert.match(
    rollbackBody,
    /restore_loaded_legacy_jobs/u,
    '回滚 bootstrap 的 GUI job 集合只能来自安装前 loaded 记录',
  );
  const verifier = read(verifierPath);
  assert.match(verifier, /databaseWritable/u);
  assert.match(verifier, /com\.xhsai\.api/u);
  assert.match(verifier, /com\.xhsai\.backup/u);
  assert.match(verifier, /com\.xhsai\.health-watch/u);
  assert.match(verifier, /gzip -t/u);
  assert.match(verifier, /tar -tzf/u);
  assert.match(verifier, /BACKUP_MODE/u);
  assert.match(verifier, /backup-manifest\.mjs/u);
  assert.match(verifier, /--inspect-lines/u);
  assert.match(verifier, /storage-paths\.mjs/u);
  assert.match(verifier, /lsof -tiTCP:8780 -sTCP:LISTEN/u);
  assert.ok(
    verifier.indexOf('gzip -t') < verifier.indexOf('SKIP_BACKUP_AGE'),
    'SKIP_BACKUP_AGE 只能跳过时间判断，不能跳过完整性校验',
  );
});

test('安装器提取的生命周期 helper 会等待原 PID，并只恢复安装前 loaded 的 GUI job', () => {
  const installer = read('ops/launchd/install.sh');
  const beginMarker = '# BEGIN launchd lifecycle helpers';
  const endMarker = '# END launchd lifecycle helpers';
  const begin = installer.indexOf(beginMarker);
  const end = installer.indexOf(endMarker);
  assert.notEqual(begin, -1, 'install.sh 必须暴露可提取测试的生命周期 helper');
  assert.ok(end > begin, '生命周期 helper 结束标记必须位于开始标记之后');

  const work = mkdtempSync(join(tmpdir(), 'content-agent-launchd-helpers-'));
  const script = join(work, 'exercise.sh');
  const rollback = join(work, 'rollback');
  const calls = join(work, 'calls.log');
  const counter = join(work, 'counter');
  const helpers = installer.slice(begin + beginMarker.length, end);
  try {
    mkdirSync(join(work, 'home/Library/LaunchAgents'), { recursive: true });
    mkdirSync(rollback, { recursive: true });
    writeFileSync(
      join(rollback, 'loaded-legacy-labels.txt'),
      'com.content-agent.backup\n',
      'utf8',
    );
    for (const label of ['com.content-agent.backup', 'com.content-agent.health-watch']) {
      writeFileSync(
        join(work, `home/Library/LaunchAgents/${label}.plist`),
        '<plist/>\n',
        'utf8',
      );
    }
    writeFileSync(
      script,
      [
        '#!/bin/bash',
        'set -e',
        `ROLLBACK_DIR=${JSON.stringify(rollback)}`,
        `TARGET_HOME=${JSON.stringify(join(work, 'home'))}`,
        'TARGET_UID=501',
        'LEGACY_LABELS=(com.content-agent.backup com.content-agent.health-watch)',
        helpers,
        `COUNTER=${JSON.stringify(counter)}`,
        `CALLS=${JSON.stringify(calls)}`,
        'process_matches_start_id() {',
        '  count=0',
        '  [ ! -f "$COUNTER" ] || count="$(cat "$COUNTER")"',
        '  count=$((count + 1))',
        '  printf "%s\\n" "$count" > "$COUNTER"',
        '  [ "$count" -lt 2 ]',
        '}',
        'sleep() { :; }',
        'run_as_user() { printf "%s\\n" "$*" >> "$CALLS"; }',
        'wait_for_original_pid_exit 77 fixture-start 3 fixture',
        'restore_loaded_legacy_jobs',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(script, 0o700);
    const result = spawnSync('/bin/bash', [script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(counter, 'utf8').trim(), '2');
    const lifecycleCalls = readFileSync(calls, 'utf8');
    assert.match(lifecycleCalls, /bootstrap gui\/501 .*com\.content-agent\.backup\.plist/u);
    assert.doesNotMatch(lifecycleCalls, /health-watch/u);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('普通用户安装入口实际向 sudo 透传已校验超时', () => {
  const work = mkdtempSync(join(tmpdir(), 'content-agent-launchd-sudo-'));
  const bin = join(work, 'bin');
  const sudoLog = join(work, 'sudo.log');
  try {
    mkdirSync(bin, { recursive: true });
    writeExecutable(
      join(bin, 'sudo'),
      `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(sudoLog)}\nexit 0\n`,
    );
    const result = spawnSync('/bin/bash', [join(root, 'ops/launchd/install.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: work,
        TARGET_HOME: work,
        TARGET_USER: process.env.USER ?? 'fixture-user',
        CONTENT_AGENT_ROOT: root,
        CONTENT_AGENT_LAUNCHD_ONESHOT_TIMEOUT_SECONDS: '17',
        NODE_BIN: process.execPath,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      readFileSync(sudoLog, 'utf8'),
      /CONTENT_AGENT_LAUNCHD_ONESHOT_TIMEOUT_SECONDS=17/u,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('安装器回滚初始化实际创建唯一目录并截断状态清单', () => {
  const installer = read('ops/launchd/install.sh');
  const beginMarker = '# BEGIN launchd lifecycle helpers';
  const endMarker = '# END launchd lifecycle helpers';
  const helpers = installer.slice(
    installer.indexOf(beginMarker) + beginMarker.length,
    installer.indexOf(endMarker),
  );
  assert.match(helpers, /initialize_rollback_state/u);

  const work = mkdtempSync(join(tmpdir(), 'content-agent-launchd-state-'));
  const script = join(work, 'exercise-state.sh');
  const resultFile = join(work, 'result.txt');
  try {
    writeFileSync(
      script,
      [
        '#!/bin/bash',
        'set -e',
        `ROLLBACK_ROOT=${JSON.stringify(join(work, 'root'))}`,
        'TARGET_USER=fixture',
        'TARGET_GROUP=fixture',
        helpers,
        'chown() { :; }',
        'mkdir -p "$ROLLBACK_ROOT"',
        'initialize_rollback_state',
        'first="$ROLLBACK_DIR"',
        'printf "stale\\n" > "$first/loaded-labels.txt"',
        'initialize_rollback_state',
        'second="$ROLLBACK_DIR"',
        '[ "$first" != "$second" ]',
        '[ ! -s "$second/loaded-labels.txt" ]',
        '[ ! -s "$second/loaded-legacy-labels.txt" ]',
        `printf '%s\\n%s\\n' "$first" "$second" > ${JSON.stringify(resultFile)}`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(script, 0o700);
    const result = spawnSync('/bin/bash', [script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const [first, second] = readFileSync(resultFile, 'utf8').trim().split('\n');
    assert.notEqual(first, second);
    assert.ok(first?.includes('/launchd.'));
    assert.ok(second?.includes('/launchd.'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('bootout helper 在 print 已消失时仍等待预捕获的 system/GUI 原 PID', () => {
  const installer = read('ops/launchd/install.sh');
  const lifecycleBegin = '# BEGIN launchd lifecycle helpers';
  const lifecycleEnd = '# END launchd lifecycle helpers';
  const bootoutBegin = '# BEGIN launchd bootout helpers';
  const bootoutEnd = '# END launchd bootout helpers';
  const lifecycleHelpers = installer.slice(
    installer.indexOf(lifecycleBegin) + lifecycleBegin.length,
    installer.indexOf(lifecycleEnd),
  );
  const bootoutStart = installer.indexOf(bootoutBegin);
  const bootoutFinish = installer.indexOf(bootoutEnd);
  assert.notEqual(bootoutStart, -1, 'install.sh 必须暴露可执行的 bootout helper');
  assert.ok(bootoutFinish > bootoutStart);
  const bootoutHelpers = installer.slice(bootoutStart + bootoutBegin.length, bootoutFinish);

  const work = mkdtempSync(join(tmpdir(), 'content-agent-launchd-bootout-'));
  const script = join(work, 'exercise-bootout.sh');
  const rollback = join(work, 'rollback');
  const systemCount = join(work, 'system-count');
  const guiCount = join(work, 'gui-count');
  try {
    mkdirSync(rollback, { recursive: true });
    writeFileSync(join(work, 'system.snapshot'), 'pid = 77\n', 'utf8');
    writeFileSync(join(work, 'system.start'), 'system-start\n', 'utf8');
    writeFileSync(join(work, 'gui.snapshot'), 'pid = 88\n', 'utf8');
    writeFileSync(join(work, 'gui.start'), 'gui-start\n', 'utf8');
    writeFileSync(
      script,
      [
        '#!/bin/bash',
        'set -e',
        `ROLLBACK_DIR=${JSON.stringify(rollback)}`,
        'TARGET_UID=501',
        lifecycleHelpers,
        bootoutHelpers,
        `SYSTEM_COUNT=${JSON.stringify(systemCount)}`,
        `GUI_COUNT=${JSON.stringify(guiCount)}`,
        'system_job_status() { return 1; }',
        'gui_job_status() { return 1; }',
        'launchctl() { return 99; }',
        'run_as_user() { return 99; }',
        'lsof() { return 1; }',
        'sleep() { :; }',
        'process_matches_start_id() {',
        '  pid="$1"',
        '  if [ "$pid" = "77" ]; then',
        '    count=0; [ ! -f "$SYSTEM_COUNT" ] || count="$(cat "$SYSTEM_COUNT")"',
        '    count=$((count + 1)); printf "%s\\n" "$count" > "$SYSTEM_COUNT"; return 0',
        '  fi',
        '  count=0; [ ! -f "$GUI_COUNT" ] || count="$(cat "$GUI_COUNT")"',
        '  count=$((count + 1)); printf "%s\\n" "$count" > "$GUI_COUNT"',
        '  [ "$count" -lt 2 ]',
        '}',
        `if bootout_system_job com.xhsai.api ${JSON.stringify(join(work, 'system-evidence'))} ` +
          `${JSON.stringify(join(work, 'system.snapshot'))} ${JSON.stringify(join(work, 'system.start'))}; then`,
        '  exit 91',
        'fi',
        `bootout_gui_job com.content-agent.backup ${JSON.stringify(join(work, 'gui-evidence'))} ` +
          `${JSON.stringify(join(work, 'gui.snapshot'))} ${JSON.stringify(join(work, 'gui.start'))}`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(script, 0o700);
    const result = spawnSync('/bin/bash', [script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Number(readFileSync(systemCount, 'utf8').trim()) >= 50);
    assert.equal(readFileSync(guiCount, 'utf8').trim(), '2');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('旧 API 已退出但未知 PID 占用 8780 时拒绝 bootstrap', () => {
  const installer = read('ops/launchd/install.sh');
  const lifecycleBegin = '# BEGIN launchd lifecycle helpers';
  const lifecycleEnd = '# END launchd lifecycle helpers';
  const bootoutBegin = '# BEGIN launchd bootout helpers';
  const bootoutEnd = '# END launchd bootout helpers';
  const lifecycleHelpers = installer.slice(
    installer.indexOf(lifecycleBegin) + lifecycleBegin.length,
    installer.indexOf(lifecycleEnd),
  );
  const bootoutHelpers = installer.slice(
    installer.indexOf(bootoutBegin) + bootoutBegin.length,
    installer.indexOf(bootoutEnd),
  );

  const work = mkdtempSync(join(tmpdir(), 'content-agent-launchd-unknown-listener-'));
  const script = join(work, 'exercise-api-bootstrap.sh');
  const rollback = join(work, 'rollback');
  const commandLog = join(work, 'commands.log');
  const statusFile = join(work, 'status.txt');
  try {
    mkdirSync(rollback, { recursive: true });
    writeFileSync(join(work, 'api.snapshot'), 'pid = 77\n', 'utf8');
    writeFileSync(join(work, 'api.start'), 'old-start\n', 'utf8');
    writeFileSync(
      script,
      [
        '#!/bin/bash',
        'set -u',
        `ROLLBACK_DIR=${JSON.stringify(rollback)}`,
        lifecycleHelpers,
        bootoutHelpers,
        `COMMAND_LOG=${JSON.stringify(commandLog)}`,
        'system_job_status() { return 1; }',
        'process_matches_start_id() { return 1; }',
        'lsof() { printf "999\\n"; }',
        'sleep() { :; }',
        'launchctl() { printf "%s\\n" "$*" >> "$COMMAND_LOG"; return 0; }',
        `bootout_system_job com.xhsai.api ${JSON.stringify(join(work, 'api-evidence'))} ` +
          `${JSON.stringify(join(work, 'api.snapshot'))} ${JSON.stringify(join(work, 'api.start'))} ` +
          '&& launchctl bootstrap system /Library/LaunchDaemons/com.xhsai.api.plist',
        'status=$?',
        `printf '%s\\n' "$status" > ${JSON.stringify(statusFile)}`,
        'exit 0',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(script, 0o700);
    const result = spawnSync('/bin/bash', [script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(readFileSync(statusFile, 'utf8').trim(), '0');
    assert.equal(existsSync(commandLog) ? readFileSync(commandLog, 'utf8') : '', '');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('部署脚本拒绝错误分支与脏树，并完整执行上线门禁', () => {
  const deploy = read('scripts/deploy.sh');
  const ci = read('.github/workflows/ci.yml');
  const runbook = read('docs/RUNBOOK.md');
  assert.match(deploy, /CURRENT_BRANCH.*main/u);
  assert.match(deploy, /git status --porcelain/u);
  assert.match(deploy, /prepare_isolated_build/u, '构建必须在隔离目录进行');
  assert.match(deploy, /install_runtime_from_build/u, '门禁通过后才能换入活树运行时');
  assert.match(deploy, /ROLLBACK_DIR\/build/u);
  assert.match(deploy, /require_origin_ci_success/u, '部署前必须确认 origin/main 对应 SHA 的 CI 已成功');
  assert.match(deploy, /api\.github\.com\/repos/u);
  assert.match(deploy, /clear_legacy_gui_api/u, '部署必须清理残留 GUI API LaunchAgent');
  assert.match(read('ops/launchd/verify.sh'), /gui\/.*com\.xhsai\.api/u);
  assert.match(ci, /permissions:\s*\n\s+contents:\s*read/u);
  assert.match(ci, /persist-credentials:\s*false/u);
  assert.match(deploy, /npm ci/u);
  assert.doesNotMatch(deploy, /npm ci[^\\n]*\|\|[^\\n]*npm install/u);
  for (const command of [
    'npm run build',
    'npm run typecheck',
    'npm test',
    'npx playwright install chromium',
    'npm run smoke:browser',
    'backup-production.sh',
    'npm run smoke:production',
  ]) {
    assert.ok(deploy.includes(command), `部署门禁缺少 ${command}`);
  }
  assert.match(deploy, /databaseWritable/u);
  assert.match(deploy, /REQUIRE_PUBLIC_SMOKE/u);
  assert.match(deploy, /CONTENT_AGENT_DEPLOY_HEALTH_WAIT_SECONDS/u);
  assert.match(deploy, /CONTENT_AGENT_DEPLOY_POLL_INTERVAL_SECONDS/u);
  assert.match(deploy, /node_modules/u, 'npm ci 前必须保存可运行依赖用于失败回滚');
  assert.match(deploy, /lsof -tiTCP:"\$PORT" -sTCP:LISTEN/u, '重启只能终止监听进程');
  assert.doesNotMatch(deploy, /lsof -ti ":\$PORT"/u);
  assert.match(deploy, /restore-stage/u, '旧运行时必须先完整解压到隔离目录');
  assert.match(deploy, /保留回滚证据/u);
  assert.match(deploy, /ops-bin/u, '已安装运维脚本必须纳入部署回滚');
  assert.match(deploy, /service\.before/u, '触碰新服务前必须保存旧 launchd 与监听状态');
  assert.match(deploy, /OLD_API_PID/u);
  assert.match(deploy, /OLD_API_START_ID/u);
  assert.match(deploy, /verify_recorded_api_still_current/u);
  assert.match(deploy, /wait_for_replaced_api_listener/u);
  assert.match(deploy, /sudo launchctl bootout "system\/com\.xhsai\.api"/u);
  assert.match(deploy, /sudo launchctl bootstrap system "\$API_PLIST"/u);
  assert.match(deploy, /sudo launchctl kickstart -k system\/com\.xhsai\.api/u);
  assert.match(deploy, /wait_for_api_listener/u);
  assert.match(deploy, /wait_for_structured_health/u);
  assert.match(deploy, /trap 'rollback_dist 129' HUP/u);
  assert.match(deploy, /trap 'rollback_dist 130' INT/u);
  assert.match(deploy, /trap 'rollback_dist 143' TERM/u);
  assert.doesNotMatch(deploy, /SKIP_TESTS/u);

  assert.ok(
    deploy.indexOf('npx playwright install chromium') < deploy.indexOf('npm run smoke:browser'),
    '本机 Chromium 必须在浏览器冒烟前按锁文件版本供应',
  );
  assert.match(ci, /npx playwright install --with-deps chromium/u);
  const rollbackBody = deploy.slice(
    deploy.indexOf('rollback_dist()'),
    deploy.indexOf("trap 'rollback_dist 129' HUP"),
  );
  assert.ok(
    rollbackBody.indexOf('stop_api_service_for_rollback') < rollbackBody.indexOf('restore_runtime'),
    '回滚交换运行时前必须先停掉仍在使用文件的 API',
  );
  assert.match(
    rollbackBody,
    /if \[ "\$SERVICE_TOUCHED" = "1" \]/u,
    '只有部署事务明确触碰服务后，rollback 才允许操作 launchd',
  );
  const destructiveTrap = deploy.indexOf("trap 'rollback_dist 129' HUP");
  assert.ok(
    deploy.lastIndexOf('\nrecord_api_state\n') < destructiveTrap,
    '服务、plist 与 PID 预检必须在启用破坏性 trap 前完成',
  );
  assert.ok(
    rollbackBody.indexOf('start_old_api_service') < rollbackBody.lastIndexOf('rm -rf "$ROLLBACK_DIR"'),
    '旧 API 显式重新加载后才能删除回滚目录',
  );
  assert.ok(
    rollbackBody.indexOf('wait_for_structured_health') < rollbackBody.lastIndexOf('rm -rf "$ROLLBACK_DIR"'),
    '旧 API 结构化健康通过后才能宣告恢复',
  );

  const firstInstall = runbook.slice(
    runbook.indexOf('首次把服务切到'),
    runbook.indexOf('常规部署：'),
  );
  assert.ok(
    firstInstall.indexOf('npm ci') < firstInstall.indexOf('npx playwright install chromium'),
    'RUNBOOK 首次安装必须在锁文件安装后供应 Chromium',
  );
  const rollbackRunbook = runbook.slice(
    runbook.indexOf('## 5. 变更：回滚'),
    runbook.indexOf('## 6. 灾难：'),
  );
  assert.ok(
    rollbackRunbook.indexOf('git revert') < rollbackRunbook.indexOf('git push'),
    '回滚提交必须先生成再按授权流程推送',
  );
  assert.ok(
    rollbackRunbook.indexOf('git push') < rollbackRunbook.indexOf('origin/main'),
    '回滚提交必须进入 origin/main',
  );
  assert.ok(
    rollbackRunbook.indexOf('origin/main') < rollbackRunbook.indexOf('CI'),
    '合并主线后必须等待 CI',
  );
  assert.ok(
    rollbackRunbook.indexOf('CI') < rollbackRunbook.indexOf('bash scripts/deploy.sh'),
    '只有 origin/main 的 CI 通过后才能部署',
  );
  assert.match(rollbackRunbook, /不得.*放宽.*origin\/main/u);
});

test('首次 kickstart 失败后会显式重载旧 API，健康通过才清理回滚证据', () => {
  const fixture = runDeployFailure('restart-fails');
  try {
    assert.equal(fixture.result.status, 9, '恢复成功后必须保留首次重启命令的原退出码');
    const commands = readFileSync(fixture.commandLog, 'utf8');
    assert.ok(
      commands.match(/^launchctl kickstart -k system\/com\.xhsai\.api$/gmu)?.length === 2,
      '首次失败与恢复旧服务各应有一次 kickstart',
    );
    assert.match(commands, /launchctl bootout system\/com\.xhsai\.api/u);
    assert.match(commands, /launchctl bootstrap system /u);
    assert.match(commands, /curl .*\/health/u, '恢复旧服务后必须轮询结构化健康');
    assert.equal(readFileSync(join(fixture.work, 'node_modules/marker.txt'), 'utf8'), 'old\n');
    assert.equal(
      readFileSync(
        join(fixture.work, 'home/Library/Application Support/xhsai/bin/health-watch.sh'),
        'utf8',
      ),
      'old health-watch.sh\n',
    );
    assert.deepEqual(fixture.rollbackDirs(), []);
  } finally {
    rmSync(fixture.work, { recursive: true, force: true });
  }
});

test('origin/main 的 CI 未绿时拒绝部署且不触碰运行时', () => {
  const fixture = runDeployFailure('ci-red');
  try {
    assert.notEqual(fixture.result.status, 0);
    assert.match(fixture.result.stderr, /CI|GitHub Actions/u);
    const commands = readFileSync(fixture.commandLog, 'utf8');
    assert.doesNotMatch(commands, /^npm /mu);
    assert.doesNotMatch(commands, /launchctl kickstart/u);
    assert.equal(readFileSync(join(fixture.work, 'node_modules/marker.txt'), 'utf8'), 'old\n');
  } finally {
    rmSync(fixture.work, { recursive: true, force: true });
  }
});

test('隔离构建失败时不得改写活树运行时也不得重启 API', () => {
  const fixture = runDeployFailure('typecheck-fails');
  try {
    assert.notEqual(fixture.result.status, 0);
    assert.match(fixture.result.stderr, /活树运行时与 API 未被触碰|typecheck/u);
    const commands = readFileSync(fixture.commandLog, 'utf8');
    assert.match(commands, /^npm ci$/mu);
    assert.doesNotMatch(commands, /launchctl kickstart/u);
    assert.doesNotMatch(commands, /launchctl bootout/u);
    assert.equal(readFileSync(join(fixture.work, 'node_modules/marker.txt'), 'utf8'), 'old\n');
    assert.equal(readFileSync(join(fixture.work, 'apps/api/dist/marker.txt'), 'utf8'), 'old\n');
  } finally {
    rmSync(fixture.work, { recursive: true, force: true });
  }
});

test('门禁通过后才把隔离构建产物换入活树', () => {
  const fixture = runDeployFailure('success');
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.equal(readFileSync(join(fixture.work, 'node_modules/marker.txt'), 'utf8'), 'new\n');
    assert.equal(readFileSync(join(fixture.work, 'apps/api/dist/marker.txt'), 'utf8'), 'new\n');
  } finally {
    rmSync(fixture.work, { recursive: true, force: true });
  }
});

test('API 未 loaded 的预检失败会安全退出且不运行破坏性回滚', () => {
  const fixture = runDeployFailure('preflight-not-loaded');
  try {
    assert.notEqual(fixture.result.status, 0);
    const commands = readFileSync(fixture.commandLog, 'utf8');
    assert.doesNotMatch(commands, /^npm /mu);
    assert.doesNotMatch(
      commands,
      /launchctl (?:bootout|bootstrap|kickstart) /u,
      '前置状态失败不得停止或意外启动服务',
    );
  } finally {
    rmSync(fixture.work, { recursive: true, force: true });
  }
});

test('长门禁期间 API 自行换代时，拒绝换入新运行时且不重启', () => {
  const fixture = runDeployFailure('service-changed-before-restart');
  try {
    assert.notEqual(fixture.result.status, 0);
    assert.match(fixture.result.stderr, /门禁期间.*PID|启动标识/u);
    const commands = readFileSync(fixture.commandLog, 'utf8');
    assert.doesNotMatch(
      commands,
      /launchctl (?:bootout|bootstrap|kickstart) /u,
      '尚未换入新运行时时，过期 PID 不得触发服务重启或回滚拉起',
    );
    assert.equal(readFileSync(join(fixture.work, 'node_modules/marker.txt'), 'utf8'), 'old\n');
  } finally {
    rmSync(fixture.work, { recursive: true, force: true });
  }
});

test('新服务重启后没有监听 PID 时失败并恢复旧运行时与服务', () => {
  const fixture = runDeployFailure('listener-missing');
  try {
    assert.notEqual(fixture.result.status, 0);
    assert.match(fixture.result.stderr, /监听/u);
    const commands = readFileSync(fixture.commandLog, 'utf8');
    assert.match(commands, /launchctl bootstrap system /u);
    assert.ok(
      commands.match(/^launchctl kickstart -k system\/com\.xhsai\.api$/gmu)?.length === 2,
      '无监听的新服务与恢复后的旧服务都必须经历显式 kickstart',
    );
    assert.equal(readFileSync(join(fixture.work, 'apps/api/dist/marker.txt'), 'utf8'), 'old\n');
    assert.deepEqual(fixture.rollbackDirs(), []);
  } finally {
    rmSync(fixture.work, { recursive: true, force: true });
  }
});

test('旧服务恢复后健康仍失败时保留回滚目录和生命周期证据', () => {
  const fixture = runDeployFailure('old-health-fails');
  try {
    assert.notEqual(fixture.result.status, 0);
    const rollbackDirs = fixture.rollbackDirs();
    assert.equal(rollbackDirs.length, 1);
    const evidence = join(fixture.work, rollbackDirs[0]!, 'rollback-service.log');
    assert.ok(existsSync(evidence), '恢复失败必须保存服务生命周期证据');
    assert.match(readFileSync(evidence, 'utf8'), /健康/u);
    assert.match(fixture.result.stderr, /保留回滚证据/u);
  } finally {
    rmSync(fixture.work, { recursive: true, force: true });
  }
});

test('kickstart 后旧 PID 仍监听时拒绝健康冒充并回滚', () => {
  const fixture = runDeployFailure('old-pid-still-listening');
  try {
    assert.notEqual(fixture.result.status, 0);
    assert.match(fixture.result.stderr, /旧 PID|新进程/u);
    const commands = readFileSync(fixture.commandLog, 'utf8');
    assert.ok(
      commands.match(/^launchctl kickstart -k system\/com\.xhsai\.api$/gmu)?.length === 2,
      '检测到旧 PID 后必须进入旧运行时恢复',
    );
    assert.equal(
      commands.match(/^curl .*\/health$/gmu)?.length,
      1,
      '旧 PID 仍监听时只能在回滚后的旧服务上做健康检查',
    );
  } finally {
    rmSync(fixture.work, { recursive: true, force: true });
  }
});

test('新监听 PID 与 launchd job PID 不一致时拒绝健康冒充并回滚', () => {
  const fixture = runDeployFailure('listener-job-mismatch');
  try {
    assert.notEqual(fixture.result.status, 0);
    assert.match(fixture.result.stderr, /launchd job PID|监听 PID|进程换代/u);
    const commands = readFileSync(fixture.commandLog, 'utf8');
    assert.ok(
      commands.match(/^launchctl kickstart -k system\/com\.xhsai\.api$/gmu)?.length === 2,
      '孤儿监听失败后必须恢复旧运行时',
    );
    assert.equal(readFileSync(join(fixture.work, 'apps/api/dist/marker.txt'), 'utf8'), 'old\n');
  } finally {
    rmSync(fixture.work, { recursive: true, force: true });
  }
});

test('本机 smoke 失败会恢复旧服务并保留 smoke 原退出码', () => {
  const fixture = runDeployFailure('smoke-fails');
  try {
    assert.equal(fixture.result.status, 17, fixture.result.stderr);
    assert.equal(readFileSync(join(fixture.work, 'node_modules/marker.txt'), 'utf8'), 'old\n');
    assert.deepEqual(fixture.rollbackDirs(), []);
  } finally {
    rmSync(fixture.work, { recursive: true, force: true });
  }
});

test('launchd verify 失败会恢复旧服务并保留 verify 原退出码', () => {
  const fixture = runDeployFailure('verify-fails');
  try {
    assert.equal(fixture.result.status, 23, fixture.result.stderr);
    const installedSnapshot = new DatabaseSync(
      join(fixture.work, 'installed-backup-stage/app.db'),
      { readOnly: true },
    );
    try {
      assert.equal(
        installedSnapshot.prepare('SELECT value FROM proof').get()?.value,
        'installed-helper-ran',
        '必须从模拟安装目录真实执行 prepare-backup，而不是只比对脚本文本',
      );
    } finally {
      installedSnapshot.close();
    }
    assert.equal(
      readFileSync(
        join(fixture.work, 'home/Library/Application Support/xhsai/bin/storage-paths.mjs'),
        'utf8',
      ),
      'old storage-paths.mjs\n',
      '失败回滚必须恢复原 storage-paths.mjs',
    );
    assert.equal(readFileSync(join(fixture.work, 'apps/api/dist/marker.txt'), 'utf8'), 'old\n');
    assert.deepEqual(fixture.rollbackDirs(), []);
  } finally {
    rmSync(fixture.work, { recursive: true, force: true });
  }
});

test('TERM 信号走同一回滚路径并返回 143', () => {
  const fixture = runDeployFailure('signal');
  try {
    assert.equal(fixture.result.status, 143);
    const commands = readFileSync(fixture.commandLog, 'utf8');
    assert.match(commands, /launchctl bootstrap system /u);
    assert.deepEqual(fixture.rollbackDirs(), []);
  } finally {
    rmSync(fixture.work, { recursive: true, force: true });
  }
});

test('rollback bootout 竞态返回非零但 job 与原 PID 已退出时继续恢复', () => {
  const fixture = runDeployFailure('bootout-race');
  try {
    const rollbackDirs = fixture.rollbackDirs();
    const evidence = rollbackDirs.length === 1
      ? readFileSync(join(fixture.work, rollbackDirs[0]!, 'rollback-service.log'), 'utf8')
      : '';
    assert.equal(
      fixture.result.status,
      17,
      `${fixture.result.stderr}\n${evidence}\n成功恢复后必须返回触发回滚的 smoke 原退出码`,
    );
    const commands = readFileSync(fixture.commandLog, 'utf8');
    assert.match(commands, /launchctl bootout system\/com\.xhsai\.api/u);
    assert.match(commands, /launchctl bootstrap system /u);
    assert.equal(readFileSync(join(fixture.work, 'node_modules/marker.txt'), 'utf8'), 'old\n');
    assert.deepEqual(fixture.rollbackDirs(), []);
  } finally {
    rmSync(fixture.work, { recursive: true, force: true });
  }
});
