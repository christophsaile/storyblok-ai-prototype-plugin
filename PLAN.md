## Plan: Screenshot To Story Generation Plugin

Implement a Storyblok space plugin flow where users upload a screenshot, provide a story name and prompt, and set a target folder (name/path/id). The backend uses OpenAI vision to infer a component layout from your existing schema, then creates a new draft story in Storyblok via Management API. The safest approach is a strict JSON contract + server-side validation before create-story API calls.

**Steps**
1. Phase 1 - Contracts and flow definition
1. Define a canonical AI output contract aligned to existing components: page, grid, accordion, accordionItem, teaser, feature.
2. Define server-side normalization/validation rules: enforce component whitelist, _uid creation, required accordion.accordionItem minimum 1, and Storyblok richtext format for accordionItem.content.
3. Define request/response payloads for the plugin API endpoint: input fields (image file, story name, prompt, parent folder name/path/id as separate metadata field, not part of prompt text), output fields (story id, slug, editor URL, warnings).

2. Phase 2 - Plugin UI and request pipeline
1. Add a generation panel to the plugin root page with: image upload, story name input, prompt textarea, folder input, and generate button. Depends on Phase 1 contract.
2. Add client-side validation (file type, size, required story name, required prompt, required folder selection), loading state, and result/error UI.
3. Submit multipart form-data with sb_app_bridge_token header using the same auth pattern already used by existing plugin components.

3. Phase 3 - Backend generation service
1. Create a new API route for generation that verifies App Bridge token and resolves OAuth session access token. Depends on Phase 2 request format.
2. Parse multipart input and validate image constraints; reject unsupported files early.
3. Call OpenAI vision with screenshot + prompt only (exclude folder target from prompt), plus a strict component-schema instruction; request JSON-only output.
4. Validate and normalize AI JSON into Storyblok-safe story.content (repair minor issues, reject hard schema violations).
5. Create story via POST mapi.storyblok.com/v1/spaces/:space_id/stories with publish=false, user-provided story name, and user-selected parent folder targeting.
6. Return created story metadata to UI for immediate navigation/inspection.

4. Phase 4 - Hardening and observability
1. Add structured error categories/codes (auth, validation, OpenAI, Storyblok API) and human-readable messages.
2. Add retries/backoff for transient OpenAI/Storyblok failures and include timeout limits.
3. Add lightweight request logging with correlation ids/request ids (no sensitive payload logging).
4. Add rate limiting guardrails and max generation size limits.

5. Phase 5 - Validation and rollout
1. Add tests for JSON normalization/validation logic and story payload builder. Parallel with Phase 4.
2. Add manual end-to-end checklist in plugin iframe context: auth, upload, generation, story creation, open-in-editor.
3. Verify generated stories render correctly in the frontend app using existing Storyblok component renderer.

**Relevant files**
- /Users/christophsaile/Work/storyblok-ai-prototype-plugin/src/pages/index.tsx - mount point for generation UI block on the plugin root page.
- /Users/christophsaile/Work/storyblok-ai-prototype-plugin/src/components/UserInfo.tsx - reference pattern for authenticated frontend-to-backend fetch flows.
- /Users/christophsaile/Work/storyblok-ai-prototype-plugin/src/hooks/useAppBridge.ts - required auth/session lifecycle behavior to reuse.
- /Users/christophsaile/Work/storyblok-ai-prototype-plugin/src/pages/api/user_info.ts - reference pattern for OAuth session + Storyblok Management API access.
- /Users/christophsaile/Work/storyblok-ai-prototype-plugin/src/pages/api/example.ts - App Bridge token verification pattern.
- /Users/christophsaile/Work/storyblok-ai-prototype-plugin/src/utils/server/appBridge.ts - JWT verification helper for sb_app_bridge_token.
- /Users/christophsaile/Work/storyblok-ai-prototype-plugin/src/utils/server/oauth.ts - OAuth session retrieval and token handling.
- /Users/christophsaile/Work/storyblok-ai-prototype/.storyblok/components/307181/components.json - source of truth for available component schema.
- /Users/christophsaile/Work/storyblok-ai-prototype/.storyblok/types/307181/storyblok-components.d.ts - type constraints to mirror in generation validation.
- /Users/christophsaile/Work/storyblok-ai-prototype/src/lib/storyblok.js - renderer registration map used to verify supported component names.

**Verification**
1. Unit-test normalization with valid/invalid AI outputs: missing _uid, unknown component, invalid accordion nesting, malformed richtext.
2. Integration-test API route with mocked OpenAI + mocked Storyblok responses for success, 401, 422, and 429 paths.
3. Manual test in Storyblok plugin iframe: upload image + story name + prompt + folder, confirm draft story appears in selected location with correct name.
4. Manual test rendering in frontend app route using created story slug and confirm all blocks render without runtime errors.
5. Confirm create-story payload aligns with Storyblok docs: POST /v1/spaces/:space_id/stories, Authorization bearer OAuth token, body includes story and optional publish false.

**Decisions**
- Story status: draft by default (publish=false).
- Input mode: screenshot + story name + prompt.
- Target location: user chooses folder each time (folder name/path/id supported).
- Folder target is provided by dedicated input field and sent separately from AI prompt text.

- Generation objective: balanced structure and copy.
- OpenAI usage: enabled now via OPENAI_API_KEY.

**Scope boundaries**
- Included: plugin UI, backend generation route, OpenAI call, Storyblok story creation, validation, error handling, tests/checklist.
- Excluded for now: automatic post-generation visual diffing, multi-language generation, auto-publish workflow, advanced component ranking/training.

**Further considerations**
1. Folder selection UX recommendation: keep name/path/id input for flexibility, then optionally upgrade to a folder picker API integration.
2. OpenAI model recommendation: use a current multimodal model with JSON response control to minimize parsing failures.
3. Start with strict schema rejection, then optionally add a repair layer once failure telemetry is available.

**Current implementation status**
1. Implemented: UI input fields for story name, prompt, folder, screenshot, plus optional debug JSON override.
2. Implemented: OpenAI image-to-JSON generation with timeout/retry and strict schema validation.
3. Implemented: Storyblok draft creation with folder resolution by id or name/path/slug.
4. Implemented: structured backend error codes and requestId for diagnostics.
5. Implemented: smoke checklist in docs.
