# CodeQL Static Analysis

CodeQL scans all JavaScript and TypeScript source files in this repository for security vulnerabilities and code-quality issues. Results appear in the GitHub Security tab (requires GitHub Advanced Security) and are also saved as a workflow artifact for repositories without that feature.

## Trigger conditions

| Event | Condition |
| --- | --- |
| Push to `main` | Any change to `apps/**`, `scripts/**`, or the workflow file itself |
| Pull request targeting `main` | Same path filter |
| Scheduled | Weekly, Monday 02:17 UTC |

The path filter means the workflow is skipped on pushes that only change documentation, Docker files, or configuration that doesn't affect JS/TS code. The weekly schedule ensures vulnerabilities in dependencies or query improvements are caught even when the filtered paths haven't changed.

## Languages and query suite

The workflow uses the `javascript-typescript` language bundle, which covers `.js`, `.jsx`, `.ts`, and `.tsx` files. The `security-and-quality` query suite is selected. It includes all queries from `security-extended` (CWE-mapped security checks such as injection, path traversal, prototype pollution, XSS, and SSRF) plus additional quality queries.

To reduce noise at the cost of fewer findings, change `queries: security-and-quality` to `queries: security-extended` in `.github/workflows/codeql.yml`.

## Excluded paths

| Pattern | Reason |
| --- | --- |
| `**/node_modules/**` | Third-party code — excluded by CodeQL default |
| `**/dist/**` | Compiled NestJS output — not source |
| `**/.next/**` | Next.js build cache — not source |
| `**/coverage/**` | Jest coverage artefacts |
| `**/__mocks__/**` | Test mock stubs — not production logic |

## Reviewing results

**With GitHub Advanced Security**: findings appear under _Security → Code scanning alerts_. Each alert links to the source line, the query documentation, and the CWE reference.

**Without Advanced Security**: download the `codeql-sarif` artifact from the workflow run. SARIF files can be viewed locally with the [SARIF Viewer VS Code extension](https://marketplace.visualstudio.com/items?itemName=MS-SarifVSCode.sarif-viewer) or any SARIF-compatible tool.

## Suppressing a false positive

Add a comment immediately above the flagged line:

```ts
// lgtm[js/query-name]
```

or use a CodeQL `// codeql[js/query-name]` suppression comment. Document the reason so reviewers understand the decision.

## Local analysis

Install the [CodeQL CLI](https://docs.github.com/en/code-security/codeql-cli/getting-started-with-the-codeql-cli/setting-up-the-codeql-cli) and run:

```bash
# Create a database from the repo root
codeql database create codeql-db --language=javascript-typescript

# Run the same suite used in CI
codeql database analyze codeql-db \
  javascript-security-and-quality.qls \
  --format=sarif-latest \
  --output=codeql-results.sarif
```

## Relationship to other security workflows

| Workflow | What it checks |
| --- | --- |
| `codeql.yml` (this) | Source-code vulnerabilities (SAST) |
| `dependency-review.yml` | Vulnerable or license-noncompliant dependencies introduced by a PR |
| CI `review:deps` step | Local audit of the full dependency tree |
