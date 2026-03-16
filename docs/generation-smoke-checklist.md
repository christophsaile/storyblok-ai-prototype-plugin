# Generation Smoke Checklist

## Preconditions
- Plugin is loaded inside Storyblok iframe.
- OAuth connection is valid for the space.
- Environment includes OPENAI_API_KEY.

## Happy path
1. Upload a valid screenshot image (<10MB).
2. Enter a prompt and target folder.
3. Leave debug generatedContentJson empty.
4. Click Generate Story.
5. Confirm response includes story.id and story.editorUrl.
6. Open editorUrl and verify draft story exists in the selected folder.

## Validation failures
1. Submit without prompt: expect validation_error.
2. Submit with non-image file: expect validation_error.
3. Submit with invalid generatedContentJson object: expect validation_error with validationErrors list.

## Folder resolution failures
1. Use unknown folder slug/path: expect storyblok_error with 404 behavior.
2. Use invalid folder id: expect storyblok_error from Storyblok API.

## Upstream resilience checks
1. Simulate transient OpenAI failure (429/5xx): verify request retries.
2. Simulate transient Storyblok failure (429/5xx): verify request retries.
3. Observe requestId in response for diagnostics.
