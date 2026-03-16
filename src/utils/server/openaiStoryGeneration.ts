import { File } from 'formidable';
import { readFile } from 'node:fs/promises';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_TIMEOUT_MS = 25000;
const OPENAI_MAX_RETRIES = 2;

type OpenAIChoice = {
	message?: {
		content?: string | null;
	};
};

type OpenAIChatResponse = {
	choices?: OpenAIChoice[];
	error?: {
		message?: string;
	};
};

export const generateStoryContentFromImage = async (params: {
	image: File;
	prompt: string;
}): Promise<Record<string, unknown>> => {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		throw new Error('OPENAI_API_KEY is not configured.');
	}

	const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
	const mimeType = params.image.mimetype || 'image/png';
	const imageBuffer = await readFile(params.image.filepath);
	const imageDataUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
	const payload = {
		model,
		temperature: 0.2,
		response_format: { type: 'json_object' },
		messages: [
			{
				role: 'system',
				content: buildSystemPrompt(),
			},
			{
				role: 'user',
				content: [
					{
						type: 'text',
						text: [
							'Use the screenshot and user prompt to generate Storyblok content JSON.',
							'Include only these components: page, grid, accordion, accordionItem, teaser, feature.',
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

	const response = await postOpenAiWithRetry({
		apiKey,
		body: payload,
	});
	const json = (await response.json()) as OpenAIChatResponse;

	if (!response.ok) {
		throw new Error(json.error?.message || `OpenAI request failed (${response.status}).`);
	}

	const content = json.choices?.[0]?.message?.content;
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

const buildSystemPrompt = () => {
	return [
		'You generate Storyblok story content JSON.',
		'Output a single JSON object only. No markdown and no explanations.',
		'The root object must be a page component.',
		'Every block must include component and _uid.',
		'Allowed components: page, grid, accordion, accordionItem, teaser, feature.',
		'Accordion rules: accordionItem is required, must be an array, and each item must be component accordionItem.',
		'page.body and grid.columns may contain arrays of allowed components.',
		'Field types: teaser.headline string, feature.name string, accordionItem.titel string.',
		'accordionItem.content, when provided, must be Storyblok richtext JSON object with type/content nodes.',
	].join('\n');
};

const postOpenAiWithRetry = async (params: {
	apiKey: string;
	body: Record<string, unknown>;
}): Promise<Response> => {
	let lastError: unknown;

	for (let attempt = 0; attempt <= OPENAI_MAX_RETRIES; attempt += 1) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

		try {
			const response = await fetch(OPENAI_API_URL, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${params.apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(params.body),
				signal: controller.signal,
			});

			if (!isRetryableStatus(response.status) || attempt === OPENAI_MAX_RETRIES) {
				return response;
			}

			await wait(backoffDelayMs(attempt));
		} catch (error) {
			lastError = error;
			if (attempt === OPENAI_MAX_RETRIES) {
				break;
			}
			await wait(backoffDelayMs(attempt));
		} finally {
			clearTimeout(timeout);
		}
	}

	if (lastError instanceof Error && lastError.name === 'AbortError') {
		throw new Error('OpenAI request timed out.');
	}

	throw new Error('OpenAI request failed after retries.');
};

const isRetryableStatus = (status: number) => {
	return status === 408 || status === 409 || status === 429 || status >= 500;
};

const backoffDelayMs = (attempt: number) => {
	return 300 * 2 ** attempt;
};

const wait = async (ms: number) => {
	await new Promise((resolve) => setTimeout(resolve, ms));
};
