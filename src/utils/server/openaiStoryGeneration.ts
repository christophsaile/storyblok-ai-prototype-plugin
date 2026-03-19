import { File } from 'formidable';
import { readFile } from 'node:fs/promises';
import OpenAI from 'openai';
import { StoryblokPromptSchemaContext } from './storyblokPromptSchema';

const OPENAI_TIMEOUT_MS = parsePositiveInt(process.env.OPENAI_TIMEOUT_MS, 90000);
const OPENAI_MAX_RETRIES = parsePositiveInt(process.env.OPENAI_MAX_RETRIES, 2);
const OPENAI_MAX_COMPLETION_TOKENS = parsePositiveInt(
	process.env.OPENAI_MAX_COMPLETION_TOKENS,
	2200,
);

export const generateStoryContentFromImage = async (params: {
	image: File;
	prompt: string;
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
		const completion = await client.chat.completions.create({
			model,
			temperature: 0.2,
			max_completion_tokens: OPENAI_MAX_COMPLETION_TOKENS,
			response_format: { type: 'json_object' },
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

	const cleaned = unwrapJsonCodeFence(content);
	try {
		const parsed = JSON.parse(cleaned) as unknown;
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			throw new Error('Generated content is not an object.');
		}
		return parsed as Record<string, unknown>;
	} catch {
		throw new Error('OpenAI returned invalid JSON content.');
	}
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
	const baseRules = [
		'You generate Storyblok story content JSON.',
		'Output a single JSON object only. No markdown and no explanations.',
		'The root object must be a page component.',
		'Every block must include component and _uid.',
	];

	const rootComponent = schemaContext.rootComponents.includes('page')
		? 'page'
		: schemaContext.rootComponents[0] || 'page';

	const typeSection = [
		'Storyblok TypeScript Definitions (source of truth for field and nested component constraints):',
		schemaContext.storyblokTypes,
	].join('\n');

	return [
		...baseRules,
		`Root component must be ${rootComponent}.`,
		`Allowed components: ${schemaContext.allowedComponents.join(', ')}.`,
		'Use the full Storyblok component payload and type definitions below as the authoritative schema.',
		'Components JSON (full payload):',
		schemaContext.rawComponentsJson,
		typeSection,
		'For any richtext field, output a valid Storyblok richtext JSON object with type/content nodes.',
	].join('\n\n');
};

const buildUserComponentHint = (schemaContext: StoryblokPromptSchemaContext) => {
	return `Include only these components: ${schemaContext.allowedComponents.join(', ')}.`;
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
