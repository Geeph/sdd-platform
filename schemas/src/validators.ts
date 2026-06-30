import type { ErrorObject, ValidateFunction } from 'ajv';
import impactSchema from '../impact.schema.json' with { type: 'json' };
import productInitSchema from '../product-init.schema.json' with { type: 'json' };
import projectsSchema from '../projects.schema.json' with { type: 'json' };
import taskSchema from '../task.schema.json' with { type: 'json' };

export interface ValidationError {
  path: string;
  message: string;
  keyword: string;
}

// Dynamic imports for CJS packages to avoid NodeNext interop issues
let _validators: {
  projects: ValidateFunction;
  task: ValidateFunction;
  impact: ValidateFunction;
  productInit: ValidateFunction;
} | null = null;

async function initValidators() {
  if (_validators) return _validators;
  const [Ajv2020Module, addFormatsModule] = await Promise.all([
    import('ajv/dist/2020.js'),
    import('ajv-formats'),
  ]);
  const AjvClass = (Ajv2020Module.default ?? Ajv2020Module) as unknown as new (
    opts: unknown,
  ) => {
    compile: (schema: unknown) => ValidateFunction;
  };
  const addFormatsFn = (addFormatsModule.default ?? addFormatsModule) as unknown as (
    ajv: unknown,
  ) => void;
  const ajv = new AjvClass({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
  });
  addFormatsFn(ajv);
  _validators = {
    projects: ajv.compile(projectsSchema),
    task: ajv.compile(taskSchema),
    impact: ajv.compile(impactSchema),
    productInit: ajv.compile(productInitSchema),
  };
  return _validators;
}

// Eager initialization
const validatorsPromise = initValidators();

function formatErrors(errors: ErrorObject[] | null | undefined): ValidationError[] {
  if (!errors || errors.length === 0) return [];
  return errors.map((e) => ({
    path: e.instancePath || '/',
    message: e.message ?? 'unknown error',
    keyword: e.keyword,
  }));
}

export interface ValidateResult {
  ok: boolean;
  errors: ValidationError[];
}

export async function validateProjectsDocument(data: unknown): Promise<ValidateResult> {
  const v = await validatorsPromise;
  const ok = v.projects(data) as boolean;
  return { ok, errors: formatErrors(v.projects.errors) };
}

export async function validateTaskDocument(data: unknown): Promise<ValidateResult> {
  const v = await validatorsPromise;
  const ok = v.task(data) as boolean;
  return { ok, errors: formatErrors(v.task.errors) };
}

export async function validateImpactDocument(data: unknown): Promise<ValidateResult> {
  const v = await validatorsPromise;
  const ok = v.impact(data) as boolean;
  return { ok, errors: formatErrors(v.impact.errors) };
}

export async function validateProductInitDocument(data: unknown): Promise<ValidateResult> {
  const v = await validatorsPromise;
  const ok = v.productInit(data) as boolean;
  return { ok, errors: formatErrors(v.productInit.errors) };
}

export { impactSchema, productInitSchema, projectsSchema, taskSchema };
