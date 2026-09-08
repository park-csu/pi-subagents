# pi-subagents

Code-first Pi subagent framework.

This fork ships only the extension runtime and programmatic APIs. It does not
register custom commands or shortcuts, and it includes no predefined agents,
prompt templates, skills, or workflow skeletons.

Consumers must provide agent definitions through user, project, package, or
runtime registration and invoke them through the `subagent` tool or exported
TypeScript APIs.

## Development

```bash
npm install
npm run typecheck
npm test
```

Upstream: <https://github.com/nicobailon/pi-subagents>
