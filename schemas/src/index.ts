// Re-export generated types from the JSON Schemas.
// These are produced by `pnpm generate` from schemas/*.schema.json using
// json-schema-to-typescript and are the canonical TypeScript shape of each
// accepted document.
export type {
  AffectedIssue,
  Component,
  SDDImpact,
  SDDProjects,
  SDDTask,
  SuggestedChangeIssue,
} from '../generated/types.js';
export type { ValidateResult, ValidationError } from './validators.js';
export {
  impactSchema,
  projectsSchema,
  taskSchema,
  validateImpactDocument,
  validateProjectsDocument,
  validateTaskDocument,
} from './validators.js';
