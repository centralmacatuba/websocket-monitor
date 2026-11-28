# Security Policy

## Supported versions

Security fixes are provided for the latest code on the `principal` branch.
Older commits and branches are not guaranteed to receive security updates.

## Reporting a vulnerability

Please do **not** report security vulnerabilities through public GitHub issues,
discussions, pull requests, or other public channels.

Use GitHub's private vulnerability reporting for this repository:

https://github.com/centralmacatuba/websocket-monitor/security/advisories/new

Include, when possible:

- A clear description of the vulnerability and its potential impact.
- The affected file, component, commit, or dependency version.
- Reproduction steps or a minimal proof of concept.
- Any suggested mitigation.

Do not include real service URLs, credentials, access tokens, private repository
details, personal data, or production payloads in the report unless strictly
necessary. Redact secrets from logs and proof-of-concept material.

## Response and disclosure

The maintainers will acknowledge reports as soon as reasonably possible,
investigate the issue, and coordinate a fix and disclosure with the reporter.
Please allow time for remediation before making a vulnerability public.

There is no guaranteed response or remediation SLA. Reports that are not
security vulnerabilities, or that concern third-party services outside this
repository's control, may be redirected to the appropriate maintainer.

## Scope

This policy covers the code, workflows, dependency configuration, and
documentation maintained in this repository.

The monitor is designed to send limited protocol health-check traffic to
explicitly configured endpoints. Do not use it to test endpoints you do not
own or have permission to assess. Findings about upstream services or
third-party packages should be reported to their respective maintainers.
