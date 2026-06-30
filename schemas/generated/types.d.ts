// Generated from impact.schema.json. Do not edit by hand.

/**
 * Impact report produced by sdd impact.
 */
export interface SDDImpact {
  base: string;
  head: string;
  changed?: {
    requirements?: string[];
    screens?: string[];
    operations?: string[];
  };
  platforms?: {
    backend: boolean;
    web: boolean;
    ios: boolean;
    android: boolean;
  };
  breaking: boolean;
  affected_issues?: AffectedIssue[];
  suggested_change_issues?: SuggestedChangeIssue[];
}
export interface AffectedIssue {
  task_id: string;
  issue: number;
  change: 'update' | 'change' | 'migration';
}
export interface SuggestedChangeIssue {
  task_id: string;
  platform: 'common' | 'backend' | 'web' | 'ios' | 'android';
  kind: 'change' | 'migration';
  reason: string;
}

// Generated from projects.schema.json. Do not edit by hand.

/**
 * Product topology: components, templates, CI wiring.
 */
export interface SDDProjects {
  schema_version: 1;
  product: string;
  repository_mode: 'monorepo';
  components: Component[];
}
export interface Component {
  id: string;
  path: string;
  template: 'spring-boot' | 'web' | 'ios-tuist' | 'android';
  template_ref: string;
  owner: string;
  ci: 'java' | 'web' | 'ios' | 'android';
}

// Generated from task.schema.json. Do not edit by hand.

/**
 * A single task emitted by a platform strategy.
 */
export interface SDDTask {
  id: string;
  platform: 'common' | 'backend' | 'web' | 'ios' | 'android';
  track: 'spec' | 'design' | 'contract' | 'code';
  title: string;
  scope?: string[];
  acceptance?: string[];
  references?: {
    requirements?: string[];
    screens?: string[];
    operations?: string[];
  };
  depends_on?: string[];
}
