## What this changes


## Why


## Checklist
- [ ] `npm test` passes (unit tests + web syntax check)
- [ ] `npm run typecheck` passes
- [ ] CHANGELOG.md has an entry under the next version
- [ ] No personal data, tokens or `.env` contents in the diff (`git diff --cached | grep -iE 'sk-ant-|oat01-|bot[0-9]{6,}:'`)
- [ ] If it changes what runs inside agent containers: tested against a real agent, not just the mock provider
