import { Controller, Get } from '@nestjs/common';
import {
  DEFAULT_FORMULA_VERSION,
  FORMULA_EXECUTION_POLICY_VERSION,
} from '@content-agent/agent-core';

@Controller()
export class HealthController {
  @Get('health')
  health() {
    // 版本取运行时常量,不写字面量:UI 侧栏展示的 CORE/POLICY 版本曾是硬编码
    // 字符串,formula.ts 一升版它就开始说谎——与 catalog digest 漂移同性质。
    return {
      status: 'ok',
      service: 'content-agent-api',
      coreVersion: DEFAULT_FORMULA_VERSION.version,
      executionPolicyVersion: FORMULA_EXECUTION_POLICY_VERSION,
    };
  }
}
