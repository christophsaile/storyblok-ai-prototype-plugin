import {
	generateStoryContentFromImage,
	getAppSession,
	StoryblokPromptSchemaContext,
	toPromptSchemaContext,
	validateGeneratedStoryContent,
	verifyAppBridgeHeader,
} from '@/utils/server';
import formidable, { Fields, File, Files } from 'formidable';
import type { NextApiRequest, NextApiResponse } from 'next';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const config = {
	api: {
		bodyParser: false,
	},
};

type GenerateSuccessResponse = {
	ok: true;
	requestId: string;
	message: string;
	story: {
		id: number;
		name: string;
		slug: string;
		fullSlug?: string;
		editorUrl: string;
		parentId: number;
	};
	input: {
		fileName: string;
		storyName: string;
		mimeType: string;
		size: number;
		promptLength: number;
		targetFolder: string;
	};
	auth: {
		spaceId?: number;
		userId?: number;
	};
};

type GenerateErrorResponse = {
	ok: false;
	requestId: string;
	code:
		| 'method_not_allowed'
		| 'auth_error'
		| 'request_error'
		| 'validation_error'
		| 'openai_error'
		| 'storyblok_error'
		| 'internal_error';
	error: string;
	storyblokStatus?: number;
	validationErrors?: {
		path: string;
		message: string;
	}[];
};

const MAX_IMAGE_SIZE_BYTES = 4 * 1024 * 1024;
const STORYBLOK_TIMEOUT_MS = 12000;
const STORYBLOK_MAX_RETRIES = 2;
const SCHEMA_SNAPSHOT_DIR = path.resolve(
	process.cwd(),
	'src/utils/server/storyblokSchemaSnapshot',
);
const COMPONENTS_SNAPSHOT_FILE = path.resolve(SCHEMA_SNAPSHOT_DIR, 'components.json');
const STORYBLOK_BASE_TYPES_FILE = path.resolve(SCHEMA_SNAPSHOT_DIR, 'storyblok.d.ts');
const STORYBLOK_COMPONENT_TYPES_FILE = path.resolve(
	SCHEMA_SNAPSHOT_DIR,
	'storyblok-components.d.ts',
);

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse<GenerateSuccessResponse | GenerateErrorResponse>,
) {
	const requestId = createRequestId();

	if (req.method !== 'POST') {
		return res.status(405).json({
			ok: false,
			requestId,
			code: 'method_not_allowed',
			error: 'Method not allowed.',
		});
	}

	const verified = await verifyAppBridgeHeader(req);
	if (!verified.ok) {
		return res.status(401).json({
			ok: false,
			requestId,
			code: 'auth_error',
			error: 'Invalid app bridge token.',
		});
	}

	const appSession = await getAppSession(req, res);
	if (!appSession) {
		return res.status(401).json({
			ok: false,
			requestId,
			code: 'auth_error',
			error: 'OAuth session not found.',
		});
	}

	let fields: Fields;
	let files: Files;

	try {
		({ fields, files } = await parseForm(req));
	} catch (error) {
		return res.status(400).json({
			ok: false,
			requestId,
			code: 'request_error',
			error: 'Invalid multipart payload.',
		});
	}

	const image = getSingleFile(files.image);
	const storyName = getSingleField(fields.storyName);
	const prompt = getSingleField(fields.prompt);
	const targetFolder = getSingleField(fields.targetFolder);
	const generatedContentJson = getSingleField(fields.generatedContentJson);

	if (!image) {
		return res.status(422).json({
			ok: false,
			requestId,
			code: 'validation_error',
			error: 'Screenshot image is required.',
		});
	}

	if (!image.mimetype?.startsWith('image/')) {
		return res
			.status(422)
			.json({
				ok: false,
				requestId,
				code: 'validation_error',
				error: 'Only image files are supported.',
			});
	}

	if (image.size > MAX_IMAGE_SIZE_BYTES) {
		return res.status(422).json({
			ok: false,
			requestId,
			code: 'validation_error',
			error: 'Image exceeds 4MB limit.',
		});
	}

	if (!prompt.trim()) {
		return res.status(422).json({
			ok: false,
			requestId,
			code: 'validation_error',
			error: 'Prompt is required.',
		});
	}

	if (!storyName.trim()) {
		return res.status(422).json({
			ok: false,
			requestId,
			code: 'validation_error',
			error: 'Story name is required.',
		});
	}

	if (!targetFolder.trim()) {
		return res
			.status(422)
			.json({
				ok: false,
				requestId,
				code: 'validation_error',
				error: 'Target folder name, id, or path is required.',
			});
	}

	const spaceId = verified.result?.space_id;
	if (!spaceId) {
		return res.status(500).json({
			ok: false,
			requestId,
			code: 'internal_error',
			error: 'Missing space id in app bridge session.',
		});
	}

	const schemaContextResult = await fetchPromptSchemaContext();

	if (!schemaContextResult.ok) {
		console.warn(
			`[generate-story:${requestId}] Failed to load Storyblok component schema: ${schemaContextResult.error}`,
		);
		return res.status(500).json({
			ok: false,
			requestId,
			code: 'internal_error',
			error: 'Schema context is required and could not be loaded.',
		});
	}

	const candidateContent = await parseCandidateContent({
		requestId,
		generatedContentJson,
		prompt,
		image,
		schemaContext: schemaContextResult.schemaContext,
	});
	if (!candidateContent.ok) {
		return res.status(candidateContent.status).json({
			ok: false,
			requestId,
			code: candidateContent.status === 500 ? 'openai_error' : 'validation_error',
			error: candidateContent.error,
		});
	}

	const validation = validateGeneratedStoryContent(candidateContent.value, {
		allowedComponents: schemaContextResult.schemaContext.allowedComponents,
	});
	if (!validation.ok) {
		return res.status(422).json({
			ok: false,
			requestId,
			code: 'validation_error',
			error: 'Generated content failed Storyblok schema validation.',
			validationErrors: validation.errors,
		});
	}

	const targetFolderResult = await resolveFolderId({
		spaceId,
		targetFolder,
		accessToken: appSession.accessToken,
	});
	if (!targetFolderResult.ok) {
		return res.status(targetFolderResult.status).json({
			ok: false,
			requestId,
			code: 'storyblok_error',
			error: targetFolderResult.error,
			storyblokStatus: targetFolderResult.storyblokStatus,
		});
	}

	const draftName = buildStoryName(storyName, prompt);
	const draftSlug = buildStorySlug(draftName);

	const createResult = await createDraftStory({
		spaceId,
		accessToken: appSession.accessToken,
		name: draftName,
		slug: draftSlug,
		parentId: targetFolderResult.folderId,
		content: validation.value,
	});
	if (!createResult.ok) {
		return res.status(createResult.status).json({
			ok: false,
			requestId,
			code: 'storyblok_error',
			error: createResult.error,
			storyblokStatus: createResult.storyblokStatus,
		});
	}

	return res.status(200).json({
		ok: true,
		requestId,
		message:
			'OpenAI generation succeeded, content passed schema validation, and draft story was created.',
		story: {
			id: createResult.story.id,
			name: createResult.story.name,
			slug: createResult.story.slug,
			fullSlug: createResult.story.full_slug,
			editorUrl: buildStoryEditorUrl(spaceId, createResult.story.id),
			parentId: targetFolderResult.folderId,
		},
		input: {
			fileName: image.originalFilename || 'uploaded-image',
			storyName: draftName,
			mimeType: image.mimetype || 'application/octet-stream',
			size: image.size,
			promptLength: prompt.trim().length,
			targetFolder: targetFolder.trim(),
		},
		auth: {
			spaceId: verified.result?.space_id,
			userId: verified.result?.user_id,
		},
	});
}

type StoryblokStory = {
	id: number;
	name: string;
	slug: string;
	full_slug?: string;
	is_folder?: boolean;
};

type StoryblokListStoriesResponse = {
	stories?: StoryblokStory[];
	perPage?: number;
	total?: number;
};

type StoryblokCreateStoryResponse = {
	story?: StoryblokStory;
	error?: string;
};

const resolveFolderId = async (params: {
	spaceId: number;
	targetFolder: string;
	accessToken: string;
}): Promise<
	| { ok: true; folderId: number }
	| { ok: false; status: 400 | 404 | 502; error: string; storyblokStatus?: number }
> => {
	const trimmed = params.targetFolder.trim();
	if (/^\d+$/.test(trimmed)) {
		return { ok: true, folderId: Number(trimmed) };
	}

	const normalized = normalizeFolderSlug(trimmed);
	for (let page = 1; page <= 10; page += 1) {
		const listUrl = new URL(
			`https://mapi.storyblok.com/v1/spaces/${params.spaceId}/stories`,
		);
		listUrl.searchParams.set('is_folder', '1');
		listUrl.searchParams.set('page', String(page));
		listUrl.searchParams.set('per_page', '100');

		const response = await fetchStoryblokWithRetry({
			url: listUrl.toString(),
			accessToken: params.accessToken,
			method: 'GET',
		});

		if (!response.ok) {
			return {
				ok: false,
				status: 502,
				error: 'Failed to resolve target folder from Storyblok.',
				storyblokStatus: response.status,
			};
		}

		const data = (await response.json()) as StoryblokListStoriesResponse;
		const folders = data.stories || [];
		const found = folders.find((folder) => {
			const slug = normalizeFolderSlug(folder.slug || '');
			const fullSlug = normalizeFolderSlug(folder.full_slug || '');
			const name = normalizeFolderSlug(folder.name || '');
			return slug === normalized || fullSlug === normalized || name === normalized;
		});

		if (found?.id) {
			return { ok: true, folderId: found.id };
		}

		if (folders.length < 100) {
			break;
		}
	}

	return {
		ok: false,
		status: 404,
		error:
			'Target folder was not found. Use a numeric folder id or an existing folder slug/path.',
	};
};

const createDraftStory = async (params: {
	spaceId: number;
	accessToken: string;
	name: string;
	slug: string;
	parentId: number;
	content: Record<string, unknown>;
}): Promise<
	| { ok: true; story: StoryblokStory }
	| { ok: false; status: 409 | 502; error: string; storyblokStatus?: number }
> => {
	const response = await fetchStoryblokWithRetry({
		url: `https://mapi.storyblok.com/v1/spaces/${params.spaceId}/stories`,
		accessToken: params.accessToken,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			publish: false,
			story: {
				name: params.name,
				slug: params.slug,
				parent_id: params.parentId,
				content: params.content,
			},
		}),
	});

	const data = (await response.json()) as StoryblokCreateStoryResponse;

	if (!response.ok) {
		if (response.status === 422 || response.status === 409) {
			return {
				ok: false,
				status: 409,
				error: data.error || 'Story could not be created (possibly slug conflict).',
				storyblokStatus: response.status,
			};
		}

		return {
			ok: false,
			status: 502,
			error: data.error || 'Storyblok story creation failed.',
			storyblokStatus: response.status,
		};
	}

	if (!data.story?.id) {
		return {
			ok: false,
			status: 502,
			error: 'Storyblok did not return created story metadata.',
		};
	}

	return { ok: true, story: data.story };
};

const createRequestId = () => {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `req-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
};

type StoryblokFetchParams = {
	url: string;
	accessToken: string;
	method: 'GET' | 'POST';
	body?: string;
	headers?: Record<string, string>;
};

const fetchStoryblokWithRetry = async (
	params: StoryblokFetchParams,
): Promise<Response> => {
	let lastError: unknown;

	for (let attempt = 0; attempt <= STORYBLOK_MAX_RETRIES; attempt += 1) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), STORYBLOK_TIMEOUT_MS);

		try {
			const response = await fetch(params.url, {
				method: params.method,
				headers: {
					Authorization: `Bearer ${params.accessToken}`,
					...params.headers,
				},
				body: params.body,
				signal: controller.signal,
			});

			if (!isRetryableStatus(response.status) || attempt === STORYBLOK_MAX_RETRIES) {
				return response;
			}

			await wait(backoffDelayMs(attempt));
		} catch (error) {
			lastError = error;
			if (attempt === STORYBLOK_MAX_RETRIES) {
				break;
			}
			await wait(backoffDelayMs(attempt));
		} finally {
			clearTimeout(timeout);
		}
	}

	if (lastError instanceof Error && lastError.name === 'AbortError') {
		throw new Error('Storyblok request timed out.');
	}

	throw new Error('Storyblok request failed after retries.');
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

const normalizeFolderSlug = (value: string) => {
	return value.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
};

const buildStoryName = (storyName: string, prompt: string) => {
	const fromStoryName = storyName.trim().replace(/\s+/g, ' ').slice(0, 80);
	if (fromStoryName) {
		return fromStoryName;
	}

	const fromPrompt = prompt.trim().replace(/\s+/g, ' ').slice(0, 60);
	return fromPrompt || `AI Generated Story ${new Date().toISOString()}`;
};

const buildStorySlug = (source: string) => {
	const base = source
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.slice(0, 50)
		.replace(/^-+|-+$/g, '');

	const suffix = new Date()
		.toISOString()
		.replace(/[-:.TZ]/g, '')
		.slice(0, 14);

	return `${base || 'ai-generated-story'}-${suffix}`;
};

const buildStoryEditorUrl = (spaceId: number, storyId: number) => {
	return `https://app.storyblok.com/#/me/spaces/${spaceId}/stories/0/0/${storyId}`;
};

const parseCandidateContent = async (params: {
	requestId: string;
	generatedContentJson: string;
	prompt: string;
	image: File;
	schemaContext: StoryblokPromptSchemaContext;
}): Promise<
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; status: 422 | 500; error: string }
> => {
	if (params.generatedContentJson.trim()) {
		try {
			const parsed = JSON.parse(params.generatedContentJson) as unknown;
			if (
				typeof parsed !== 'object' ||
				parsed === null ||
				Array.isArray(parsed)
			) {
				return {
					ok: false,
					status: 422,
					error: 'generatedContentJson is not a valid JSON object.',
				};
			}
			return { ok: true, value: parsed as Record<string, unknown> };
		} catch {
			return {
				ok: false,
				status: 422,
				error: 'generatedContentJson is not valid JSON.',
			};
		}
	}

	try {
		const generated = await generateStoryContentFromImage({
			requestId: params.requestId,
			image: params.image,
			prompt: params.prompt,
			schemaContext: params.schemaContext,
		});
		return { ok: true, value: generated };
	} catch (error) {
		const message = error instanceof Error ? error.message : 'OpenAI generation failed.';
		return {
			ok: false,
			status: 500,
			error: message,
		};
	}
};

const fetchPromptSchemaContext = async (): Promise<
	| { ok: true; schemaContext: StoryblokPromptSchemaContext }
	| { ok: false; error: string }
> => {
	try {
		const [componentsJson, storyblokBaseTypes, storyblokComponentTypes] = await Promise.all([
			readFile(COMPONENTS_SNAPSHOT_FILE, 'utf8'),
			readFile(STORYBLOK_BASE_TYPES_FILE, 'utf8'),
			readFile(STORYBLOK_COMPONENT_TYPES_FILE, 'utf8'),
		]);

		const parsedComponents = JSON.parse(componentsJson) as unknown;
		if (!Array.isArray(parsedComponents)) {
			return {
				ok: false,
				error: 'Hardcoded components.json is not an array.',
			};
		}

		const storyblokTypes = [storyblokBaseTypes.trim(), storyblokComponentTypes.trim()]
			.filter(Boolean)
			.join('\n\n');

		const schemaContext = toPromptSchemaContext(
			{ components: parsedComponents },
			{ storyblokTypes },
		);

		if (!schemaContext) {
			return {
				ok: false,
				error: 'Hardcoded schema snapshot could not be transformed.',
			};
		}

		return { ok: true, schemaContext };
	} catch (error) {
		return {
			ok: false,
			error:
				error instanceof Error
					? `Failed to load hardcoded schema snapshot: ${error.message}`
					: 'Failed to load hardcoded schema snapshot.',
		};
	}
};

const parseForm = (req: NextApiRequest): Promise<{ fields: Fields; files: Files }> => {
	return new Promise((resolve, reject) => {
		const form = formidable({
			multiples: false,
			maxFiles: 1,
			maxFileSize: MAX_IMAGE_SIZE_BYTES,
		});

		form.parse(req, (err, fields, files) => {
			if (err) {
				reject(err);
				return;
			}
			resolve({ fields, files });
		});
	});
};

const getSingleField = (value?: string | string[]) => {
	if (Array.isArray(value)) {
		return value[0] || '';
	}
	return value || '';
};

const getSingleFile = (value?: File | File[]) => {
	if (Array.isArray(value)) {
		return value[0];
	}
	return value;
};