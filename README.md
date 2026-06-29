# sdd-platform

[English](README.md) | [中文](README.zh-CN.md)

Shared control plane for creating and operating Spec-Driven Development (SDD) projects.

`sdd-platform` will provide the CLI, repository factory, backlog compiler, schemas, component
templates, and reusable GitHub Actions workflows used by generated product repositories.

> **Status:** bootstrap phase. The repository and target interface exist, but the CLI and
> automation described below are not implemented yet.

Implementation sequencing, gates, and acceptance scenarios are maintained in the
[single-repo implementation runbook](docs/sdd/single-repo-implementation-runbook.md).

## Repository roles

The first supported topology uses two active repositories:

```text
sdd-platform    Shared tooling, root/component templates, and automation (this repository)
<product-repo>  Generated single-product monorepo
```

The existing `sdd-agent-starter` repository is a historical reference and optional manual
GitHub Template. It is not a runtime or generation dependency of `sdd-platform`.

## Planned capabilities

- Create a product repository from the root template in a fixed `sdd-platform` revision.
- Configure repository labels, CODEOWNERS, environments, rulesets, and workflows.
- Validate `projects.yaml`, task, and impact documents against versioned schemas.
- Scaffold Backend, Web, iOS, and Android components after Architecture Gate approval.
- Compile approved spec/design/plan artifacts into stable, platform-specific backlog tasks.
- Dry-run and idempotently publish tasks to GitHub Issues.
- Detect spec, design, and contract changes and calculate affected platforms and Issues.
- Supply reusable CI workflows for Java, Web, iOS, and Android projects.

## Target workflow

```text
Create root repository
  -> approve Spec
  -> approve Architecture and projects.yaml
  -> scaffold approved components
  -> approve Design when required
  -> approve Plan
  -> compile backlog (dry-run)
  -> publish GitHub Issues
  -> implement through PR, CI, independent review, and human approval
```

GitHub Issues are the backlog and task-status source of truth. Generated reports and plans are
planning snapshots; they must not become a second task tracker.

## Target CLI usage

The following commands define the intended interface. They are documentation for the MVP and
will fail until the corresponding CLI milestones are implemented and released.

```bash
# Preview creation of a product repository. No GitHub state is changed.
sdd product init demo --mode monorepo --dry-run

# Create only the root/control skeleton. Components are decided later.
sdd product init demo --mode monorepo

# Preview and then scaffold components approved in projects.yaml.
sdd product scaffold --repo . --projects projects.yaml --dry-run
sdd product scaffold --repo . --projects projects.yaml

# Validate SDD artifacts and calculate the impact of a change.
sdd validate --repo .
sdd impact --base origin/main --head HEAD --format json

# Compile first; publish only after reviewing the dry-run output.
sdd backlog compile --repo . --version v1 --dry-run
sdd backlog publish --repo . --version v1
```

All mutating commands must support a reviewable dry-run or have an equivalent preview command.
Backlog publishing must use stable task IDs and remain idempotent across retries.

## Planned repository layout

```text
sdd-platform/
├── cli/
├── factory/
├── backlog-compiler/
├── schemas/
│   ├── projects.schema.json
│   ├── task.schema.json
│   └── impact.schema.json
├── templates/
│   ├── monorepo-root/
│   ├── spring-boot/
│   ├── web/
│   ├── ios-tuist/
│   └── android/
└── .github/workflows/
    ├── java.yml
    ├── web.yml
    ├── ios.yml
    └── android.yml
```

The root and component templates are versioned with the Factory. A product's `template.lock`
records the `sdd-platform` release/commit and template checksums used for generation.

## Development

The implementation language, package manager, and local verification commands will be added
with the first CLI scaffold. Until then, cloning the repository is sufficient:

```bash
git clone https://github.com/Geeph/sdd-platform.git
cd sdd-platform
```

Changes will be delivered as small Issues and pull requests. Each implementation PR must pass
lint, typecheck, tests, and build checks once those toolchains are present.

## Initial scope

The first release targets one product monorepo. It does not include multi-repo dispatch,
cross-repository contract synchronization, generated SDK registries, automatic template
merging, Pact, Terraform, or Pulumi.
