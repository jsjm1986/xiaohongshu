import {
  DEFAULT_FORMULA_VERSION,
  GENERATION_PARAMETER_REGISTRY,
  type GenerationParameterDefinition as CoreParameterDefinition,
  type ParameterValue,
} from '@content-agent/agent-core';
import { BadRequestException } from '@nestjs/common';

export const PARAMETER_SCHEMA_VERSION = '1.0';

const FORMULA_EQUATIONS = new Map(
  DEFAULT_FORMULA_VERSION.formulas.map((formula) => [formula.id, formula.equation]),
);

/** API projection only. The registry and all defaults remain owned by agent-core. */
export const GENERATION_PARAMETERS = GENERATION_PARAMETER_REGISTRY.map((definition) => ({
  id: definition.id,
  path: definition.path,
  label: definition.label,
  group: definition.group,
  control: definition.control.kind,
  controlMeta: structuredClone(definition.control),
  min: definition.control.min,
  max: definition.control.max,
  step: definition.control.step,
  options: structuredClone(definition.control.options ?? []),
  defaultValue: structuredClone(definition.defaultValue),
  formulaIds: [...definition.formulaIds],
  equation: definition.formulaIds.map((id) => FORMULA_EQUATIONS.get(id)).filter(Boolean).join('；'),
  plainLanguage: definition.noviceExplanation,
  increaseEffect: definition.increaseEffect,
  decreaseEffect: definition.decreaseEffect,
  changeEffect: definition.changeEffect,
  risk: riskFor(definition),
  effects: [...definition.channels],
  evidenceStatus: definition.evidenceStatus,
  evidenceNote: definition.evidenceNote,
}));

export const DEFAULT_PARAMETER_VALUES: Record<string, ParameterValue> = Object.fromEntries(
  GENERATION_PARAMETER_REGISTRY.map((definition) => [definition.id, structuredClone(definition.defaultValue)]),
);

const PARAMETER_MAP = new Map(GENERATION_PARAMETER_REGISTRY.map((definition) => [definition.id, definition]));

export function parameterSchema(): Record<string, unknown> {
  return {
    schemaVersion: PARAMETER_SCHEMA_VERSION,
    parameters: structuredClone(GENERATION_PARAMETERS),
  };
}

export function normalizeParameterValues(
  input: unknown,
  options: { partial?: boolean; clamp?: boolean; rejectUnknown?: boolean } = {},
): { values: Record<string, ParameterValue>; warnings: string[] } {
  if (input === undefined || input === null) {
    return {
      values: options.partial === false ? structuredClone(DEFAULT_PARAMETER_VALUES) : {},
      warnings: [],
    };
  }
  if (typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('参数 values 必须是对象');
  const values: Record<string, ParameterValue> = options.partial === false
    ? structuredClone(DEFAULT_PARAMETER_VALUES)
    : {};
  const warnings: string[] = [];
  for (const [id, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const definition = PARAMETER_MAP.get(id);
    if (!definition) {
      const warning = `未知参数：${id}`;
      if (options.rejectUnknown) throw new BadRequestException(warning);
      warnings.push(warning);
      continue;
    }
    values[id] = normalizeValue(definition, rawValue, options.clamp === true, warnings);
  }
  return { values, warnings };
}

function normalizeValue(
  definition: CoreParameterDefinition,
  value: unknown,
  clamp: boolean,
  warnings: string[],
): ParameterValue {
  const control = definition.control;
  if (control.kind === 'slider' || control.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BadRequestException(`${definition.id} 必须是数字`);
    }
    let result = control.step && Number.isInteger(control.step) ? Math.round(value) : value;
    if (control.min !== undefined && result < control.min) {
      if (!clamp) throw new BadRequestException(`${definition.id} 不能小于 ${control.min}`);
      warnings.push(`${definition.id} 已从 ${result} 修正为 ${control.min}`);
      result = control.min;
    }
    if (control.max !== undefined && result > control.max) {
      if (!clamp) throw new BadRequestException(`${definition.id} 不能大于 ${control.max}`);
      warnings.push(`${definition.id} 已从 ${result} 修正为 ${control.max}`);
      result = control.max;
    }
    return result;
  }
  if (control.kind === 'toggle') {
    if (typeof value !== 'boolean') throw new BadRequestException(`${definition.id} 必须是布尔值`);
    return value;
  }
  if (control.kind === 'text_list' || control.kind === 'multi_select') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new BadRequestException(`${definition.id} 必须是字符串数组`);
    }
    return [...new Set(value.map((item) => item.trim()).filter(Boolean))].slice(0, 500);
  }
  if (typeof value !== 'string') throw new BadRequestException(`${definition.id} 必须是字符串`);
  const text = value.trim().slice(0, 1_000);
  if (control.kind === 'select' && control.options && !control.options.some((option) => option.value === text)) {
    throw new BadRequestException(`${definition.id} 不是允许的选项`);
  }
  return text;
}

function riskFor(definition: CoreParameterDefinition): 'low' | 'medium' | 'high' {
  if (definition.evidenceStatus === 'normative_boundary') return 'high';
  if (definition.evidenceStatus === 'unvalidated_proxy' || definition.evidenceStatus === 'hypothesis') return 'medium';
  return 'low';
}
