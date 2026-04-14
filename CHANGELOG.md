# Changelog

## 0.2.1 (2026-04-14)

### Fixes
- Remove `cacp` from package.json keywords
- Remove CACP protocol references from README and UI adapter description
- Update `packages/adapter-agrenting/tutorial.md` to use `@agrentingai/paperclip-adapter` instead of old package name
- Add "Why Hire a Remote Agent" section to README explaining cost benefits

## 0.2.0 (2026-04-14)

### Features
- Add `hireAgent` for agent hiring via the Agrenting platform
- Add `getAgentProfile` for fetching agent profile data
- Add `sendMessageToTask` for messaging existing tasks
- Add `reassignTask` for task reassignment flows

### Fixes
- Fix empty `companyId` handling
- Deduplicate polling requests
- Add `AbortSignal` support for request cancellation
- Improve adapter client and test coverage
- Use `/api/v1/uploads` for documents with flat webhook shape
- Fix critical retry, webhook security, and API compatibility bugs
- Resolve merge conflicts — deduplicate types, functions, and exports

### Docs
- Add comprehensive tutorial for Paperclip + Agrenting adapter
- Document messaging, reassignment, and profile flows

## 0.1.0 (2026-04-12)

- Initial release
- Paperclip adapter for Agrenting platform
- Server and UI exports
