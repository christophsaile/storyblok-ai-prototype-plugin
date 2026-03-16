# Generation Smoke Checklist

## Preconditions
- Plugin is loaded inside Storyblok iframe.
- OAuth connection is valid for the space.
- Environment includes OPENAI_API_KEY.

## Happy path
1. Upload a valid screenshot image (<10MB).
2. Enter a story name.
3. Enter a prompt and target folder (name, path, or id).
4. Leave debug generatedContentJson empty.
5. Click Generate Story.
6. Confirm response includes requestId, story.id, and story.editorUrl.
7. Confirm created story name matches the provided story name.
8. Open editorUrl and verify draft story exists in the selected folder.

## Validation failures
1. Submit without story name: expect validation_error.
2. Submit without prompt: expect validation_error.
3. Submit with non-image file: expect validation_error.
4. Submit with invalid generatedContentJson object: expect validation_error with validationErrors list.

## Folder resolution failures
1. Use unknown folder name or slug/path: expect storyblok_error with 404 behavior.
2. Use invalid folder id: expect storyblok_error from Storyblok API.

## Upstream resilience checks
1. Simulate transient OpenAI failure (429/5xx): verify request retries.
2. Simulate transient Storyblok failure (429/5xx): verify request retries.
3. Observe requestId and error code in responses for diagnostics.
