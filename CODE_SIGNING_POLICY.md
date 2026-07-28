# Code signing policy

Free code signing is provided by [SignPath.io](https://signpath.io/), with the
certificate issued by the [SignPath Foundation](https://signpath.org/).

## Team roles

- Committers and reviewers: [god2father](https://github.com/god2father)
- Approvers: [god2father](https://github.com/god2father)

Every signing request must be manually approved by an approver. Only release
artifacts built from this repository's source and build configuration may be
submitted for signing.

## Privacy policy

This program will not transfer any information to other networked systems
unless specifically requested by the user or the person installing or
operating it.

When Codex Meter is running, it invokes the locally installed Codex CLI/App
Server to request account rate-limit information. That component may
communicate with OpenAI under its own terms and privacy policy. Codex Meter
does not read authentication secrets, upload local token counts, or transfer
prompt, response, or code content.
