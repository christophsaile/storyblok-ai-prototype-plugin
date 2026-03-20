import { File } from 'formidable';
import { readFile } from 'node:fs/promises';
import OpenAI from 'openai';
import { StoryblokPromptSchemaContext } from './storyblokPromptSchema';

const OPENAI_TIMEOUT_MS = parsePositiveInt(process.env.OPENAI_TIMEOUT_MS, 90000);
const OPENAI_MAX_RETRIES = parsePositiveInt(process.env.OPENAI_MAX_RETRIES, 2);
const OPENAI_MAX_COMPLETION_TOKENS = parsePositiveInt(
	process.env.OPENAI_MAX_COMPLETION_TOKENS,
	4000,
);
const OPENAI_DEBUG_LOGS_ENABLED =
	process.env.OPENAI_DEBUG_LOGS === '1' || process.env.OPENAI_DEBUG_LOGS === 'true';
type OpenAIChatCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type OpenAIChatCompletion = OpenAI.Chat.Completions.ChatCompletion;

const STRICT_OBJECT_RESPONSE_FORMAT = {
	type: 'json_schema',
	json_schema: {
		name: 'storyblok_content_object',
		strict: true,
		schema: {
			type: 'object',
			additionalProperties: true,
		},
	},
} as const;

export const generateStoryContentFromImage = async (params: {
	image: File;
	prompt: string;
	requestId: string;
	schemaContext: StoryblokPromptSchemaContext;
}): Promise<Record<string, unknown>> => {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		throw new Error('OPENAI_API_KEY is not configured.');
	}

	const client = new OpenAI({
		apiKey,
		timeout: OPENAI_TIMEOUT_MS,
		maxRetries: OPENAI_MAX_RETRIES,
	});

	const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
	const mimeType = params.image.mimetype || 'image/png';
	const imageBuffer = await readFile(params.image.filepath);
	const imageDataUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;

	let content: string | null | undefined;
	try {
		const completionBaseParams: OpenAIChatCreateParams = {
			model,
			temperature: 0.2,
			max_completion_tokens: OPENAI_MAX_COMPLETION_TOKENS,
			messages: [
				{
					role: 'system',
					content: buildSystemPrompt(params.schemaContext),
				},
				{
					role: 'user',
					content: [
						{
							type: 'text',
							text: [
								'Use the screenshot and user prompt to generate Storyblok content JSON.',
								buildUserComponentHint(params.schemaContext),
								'Never include folder placement metadata in output.',
								`User prompt: ${params.prompt}`,
							].join('\n'),
						},
						{
							type: 'image_url',
							image_url: {
								url: imageDataUrl,
							},
						},
					],
				},
			],
		};

		const completion = await createStructuredCompletionWithFallback({
			client,
			requestId: params.requestId,
			baseParams: completionBaseParams,
		});

		content = completion.choices?.[0]?.message?.content;
	} catch (error) {
		if (error instanceof Error && /timed out/i.test(error.message)) {
			throw new Error(
				`Request timed out after ${Math.round(OPENAI_TIMEOUT_MS / 1000)}s. Try a smaller image or increase OPENAI_TIMEOUT_MS.`,
			);
		}
		const message = error instanceof Error ? error.message : 'OpenAI request failed.';
		throw new Error(message);
	}

	if (!content || typeof content !== 'string') {
		throw new Error('OpenAI did not return content JSON.');
	}

	logOpenAiDebug(params.requestId, 'Model completion received.', {
		model,
		contentLength: content.length,
		contentPreviewStart: sanitizePreview(content.slice(0, 300)),
		contentPreviewEnd: sanitizePreview(content.slice(-180)),
	});

	const cleaned = unwrapJsonCodeFence(content);

	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned) as unknown;
	} catch {
		logOpenAiDebug(params.requestId, 'JSON parse failed for model completion.', {
			cleanedLength: cleaned.length,
			cleanedPreviewStart: sanitizePreview(cleaned.slice(0, 300)),
			cleanedPreviewEnd: sanitizePreview(cleaned.slice(-180)),
			suspectedReason: detectLikelyJsonFailureReason(cleaned),
		});
		throw new Error('OpenAI returned invalid JSON content (parse failure).');
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		logOpenAiDebug(params.requestId, 'Model returned JSON with invalid root type.', {
			rootType: Array.isArray(parsed) ? 'array' : typeof parsed,
		});
		throw new Error('OpenAI returned invalid JSON content (root must be an object).');
	}

	return parsed as Record<string, unknown>;
};

const unwrapJsonCodeFence = (value: string) => {
	const trimmed = value.trim();
	if (!trimmed.startsWith('```')) {
		return trimmed;
	}

	const lines = trimmed.split('\n');
	if (lines.length < 3) {
		return trimmed;
	}

	const withoutStart = lines.slice(1);
	if (withoutStart[withoutStart.length - 1]?.trim().startsWith('```')) {
		withoutStart.pop();
	}

	return withoutStart.join('\n').trim();
};

const buildSystemPrompt = (schemaContext: StoryblokPromptSchemaContext) => {
	const includeRichTextGuidance = hasRichTextFields(schemaContext);
	const baseRules = [
		'You generate Storyblok story content JSON.',
		'Output a single JSON object only. No markdown and no explanations.',
		'The root object must be a page component.',
		"Please fill out all required fields for each component, but you can omit optional fields if you don't have a good value to put there.",
		'Every block must include component and _uid.',
		'Do not include Storyblok editor metadata fields such as _editable.',
		'For any image filename or placeholder used with next/image, do not output relative paths like "design-dev.jpg". Use a root-relative path that starts with "/" (for example "/design-dev.jpg").',
	];

	const rootComponent = schemaContext.rootComponents.includes('page')
		? 'page'
		: schemaContext.rootComponents[0] || 'page';

	const typeSection = [
		'Storyblok TypeScript Definitions (source of truth for field and nested component constraints):',
		schemaContext.storyblokTypes,
	].join('\n');

	const sections = [
		...baseRules,
		`Root component must be ${rootComponent}.`,
		`Allowed components: ${schemaContext.allowedComponents.join(', ')}.`,
		'Use the full Storyblok component payload and type definitions below as the authoritative schema.',
		'Components JSON (full payload):',
		schemaContext.rawComponentsJson,
		typeSection,
	];

	if (includeRichTextGuidance) {
		sections.push(
			'For any richtext field, output a valid Storyblok richtext JSON object with type/content nodes.',
			'Use this compact richtext shape as a structure reference (example only):',
			buildRichTextExample(),
		);
	}

	return sections.join('\n\n');
};

const hasRichTextFields = (schemaContext: StoryblokPromptSchemaContext) => {
	return schemaContext.components.some((component) =>
		component.fields.some((field) => field.type === 'richtext'),
	);
};

const buildRichTextExample = () => {
	return JSON.stringify(
		{
			type: 'doc',
			content: [
				{
					type: 'heading',
					attrs: { level: 2, textAlign: null },
					content: [{ type: 'text', text: 'Sample heading' }],
				},
				{
					type: 'paragraph',
					attrs: { textAlign: null },
					content: [
						{ type: 'text', text: 'Intro with an ' },
						{
							type: 'text',
							text: 'external link',
							marks: [
								{
									type: 'link',
									attrs: {
										href: 'https://example.com',
										uuid: null,
										anchor: null,
										target: '_blank',
										linktype: 'url',
									},
								},
							],
						},
					],
				},
				{
					type: 'bullet_list',
					content: [
						{
							type: 'list_item',
							content: [
								{
									type: 'paragraph',
									attrs: { textAlign: null },
									content: [{ type: 'text', text: 'List item' }],
								},
							],
						},
					],
				},
			],
		},
		null,
		2,
	);
};

const buildUserComponentHint = (schemaContext: StoryblokPromptSchemaContext) => {
	return `Include only these components: ${schemaContext.allowedComponents.join(', ')}.`;
};

const createStructuredCompletionWithFallback = async (params: {
	client: OpenAI;
	requestId: string;
	baseParams: OpenAIChatCreateParams;
}): Promise<OpenAIChatCompletion> => {
	try {
		return await params.client.chat.completions.create({
			...params.baseParams,
			response_format: STRICT_OBJECT_RESPONSE_FORMAT as never,
		});
	} catch (error) {
		if (!shouldFallbackToJsonObject(error)) {
			throw error;
		}

		logOpenAiDebug(
			params.requestId,
			'Strict structured output rejected by model/API. Falling back to json_object response format.',
			{ message: error instanceof Error ? error.message : 'unknown' },
		);

		return await params.client.chat.completions.create({
			...params.baseParams,
			response_format: { type: 'json_object' },
		});
	}
};

const shouldFallbackToJsonObject = (error: unknown) => {
	if (!(error instanceof Error)) {
		return false;
	}

	const msg = error.message.toLowerCase();
	return msg.includes('json_schema') || msg.includes('response_format') || msg.includes('strict');
};

const logOpenAiDebug = (requestId: string, message: string, data?: Record<string, unknown>) => {
	if (!OPENAI_DEBUG_LOGS_ENABLED) {
		return;
	}

	if (data) {
		console.info(`[generate-story:${requestId}] ${message}`, data);
		return;
	}

	console.info(`[generate-story:${requestId}] ${message}`);
};

const sanitizePreview = (value: string) => {
	return value.replace(/\s+/g, ' ').trim();
};

const detectLikelyJsonFailureReason = (value: string) => {
	const trimmed = value.trim();
	if (!trimmed) {
		return 'empty-content';
	}

	if (!trimmed.endsWith('}') && !trimmed.endsWith(']')) {
		return 'possibly-truncated';
	}

	if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
		return 'non-json-prefix';
	}

	return 'malformed-json';
};

function parsePositiveInt(value: string | undefined, fallback: number) {
	if (!value) {
		return fallback;
	}

	const parsed = Number.parseInt(value, 10);
	if (Number.isFinite(parsed) && parsed > 0) {
		return parsed;
	}

	return fallback;
}
