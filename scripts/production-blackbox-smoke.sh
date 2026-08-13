#!/bin/bash
# 生产服务黑盒冒烟:对**正在运行**的服务做无凭据可测面的全量检查。
# 只读、不登录、不写数据——随时可跑,适合部署后与每周巡检(RUNBOOK §9)。
#
# 用法:
#   bash scripts/production-blackbox-smoke.sh                      # 本机 8780
#   BASE=https://xhsai.maycran.com bash scripts/production-blackbox-smoke.sh  # 公网
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8780}"
PASS=0
FAIL=0

check() { # $1=名称 $2=期望 $3=实际
  if [ "$2" = "$3" ]; then
    PASS=$((PASS+1)); echo "  ✓ $1"
  else
    FAIL=$((FAIL+1)); echo "  ✗ $1  期望 [$2] 实际 [$3]"
  fi
}

fetch_code() { curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$@" 2>/dev/null; }

echo "== 生产黑盒冒烟 @ ${BASE} =="

echo "-- 1. 健康与版本"
HEALTH="$(curl -s --max-time 10 "${BASE}/health")"
check "/health 返回 status ok" "ok" "$(echo "${HEALTH}" | grep -oE '"status":"[a-z]+"' | head -1 | cut -d'"' -f4)"
check "/health 数据库可写" "true" "$(echo "${HEALTH}" | grep -oE '"databaseWritable":(true|false)' | cut -d: -f2)"
CORE_VERSION="$(echo "${HEALTH}" | grep -oE '"coreVersion":"[^"]+"' | cut -d'"' -f4)"
[ -n "${CORE_VERSION}" ] && { PASS=$((PASS+1)); echo "  ✓ 版本可读: core ${CORE_VERSION}"; } || { FAIL=$((FAIL+1)); echo "  ✗ 版本缺失"; }

echo "-- 2. 前端静态面(防白屏)"
INDEX="$(curl -s --max-time 10 "${BASE}/")"
check "首页 200" "200" "$(fetch_code "${BASE}/")"
BUNDLE="$(echo "${INDEX}" | grep -oE 'src="[^"]+\.js"' | head -1 | cut -d'"' -f2)"
if [ -n "${BUNDLE}" ]; then
  check "入口 bundle 可加载 (${BUNDLE})" "200" "$(fetch_code "${BASE}${BUNDLE}")"
else
  FAIL=$((FAIL+1)); echo "  ✗ 首页 HTML 里找不到入口 bundle"
fi
check "公开页 /reset-password 200" "200" "$(fetch_code "${BASE}/reset-password")"
check "公开页 /login 200" "200" "$(fetch_code "${BASE}/login")"

echo "-- 3. 认证边界(未登录必须一律拒绝,不泄露资源存在性)"
check "GET /api/projects 未认证 401" "401" "$(fetch_code "${BASE}/api/projects")"
check "GET /api/settings 未认证 401" "401" "$(fetch_code "${BASE}/api/settings")"
check "GET /api/settings/quota/ledger 未认证 401" "401" "$(fetch_code "${BASE}/api/settings/quota/ledger")"
check "GET /api/admin/users 未认证 401" "401" "$(fetch_code "${BASE}/api/admin/users")"
check "GET /api/generations/x 未认证 401" "401" "$(fetch_code "${BASE}/api/generations/does-not-exist")"
check "POST /api/generations 未认证 401" "401" "$(fetch_code -X POST -H 'content-type: application/json' -d '{}' "${BASE}/api/generations")"

echo "-- 4. V1 集成面(API key 通道,路由前缀是 /v1 不带 /api)"
check "V1 无 key 401" "401" "$(fetch_code "${BASE}/v1/projects")"
check "V1 伪造 key 401" "401" "$(fetch_code -H 'Authorization: Bearer fake-key-for-smoke' "${BASE}/v1/projects")"

echo "-- 5. 已移除/不存在面收敛"
check "人工确认端点已移除 404" "404" "$(fetch_code -X POST "${BASE}/api/generations/x/candidates/y/manual-delivery-confirmation")"
check "不存在的 API 路径 404" "404" "$(fetch_code "${BASE}/api/no-such-endpoint")"

echo "-- 6. 错误响应卫生(不回吐堆栈)"
NOT_FOUND_BODY="$(curl -s --max-time 10 "${BASE}/api/no-such-endpoint")"
if echo "${NOT_FOUND_BODY}" | grep -qE "at .*\.(ts|js):[0-9]+|node_modules"; then
  FAIL=$((FAIL+1)); echo "  ✗ 404 响应泄露堆栈"
else
  PASS=$((PASS+1)); echo "  ✓ 404 响应无堆栈泄露"
fi

echo "== 结果: ${PASS} 通过, ${FAIL} 失败 =="
[ "${FAIL}" -eq 0 ]
