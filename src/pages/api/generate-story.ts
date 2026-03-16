import {
    generateStoryContentFromImage,
    getAppSession,
    validateGeneratedStoryContent,
    verifyAppBridgeHeader,
} from '@/utils/server';
import formidable, { Fields, File, Files } from 'formidable';
import type { NextApiRequest, NextApiResponse } from 'next';

export const config = {
	api: {
		bodyParser: false,
	},
};

type GenerateSuccessResponse = {
	ok: true;
	message: string;
	input: {
		fileName: string;
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
	error: string;
	validationErrors?: {
		path: string;
		message: string;
	}[];
};

const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse<GenerateSuccessResponse | GenerateErrorResponse>,
) {
	if (req.method !== 'POST') {
		return res.status(405).json({ ok: false, error: 'Method not allowed.' });
	}

	const verified = await verifyAppBridgeHeader(req);
	if (!verified.ok) {
		return res.status(401).json({ ok: false, error: 'Invalid app bridge token.' });
	}

	const appSession = await getAppSession(req, res);
	if (!appSession) {
		return res.status(401).json({ ok: false, error: 'OAuth session not found.' });
	}

	let fields: Fields;
	let files: Files;

	try {
		({ fields, files } = await parseForm(req));
	} catch (error) {
		return res.status(400).json({ ok: false, error: 'Invalid multipart payload.' });
	}

	const image = getSingleFile(files.image);
	const prompt = getSingleField(fields.prompt);
	const targetFolder = getSingleField(fields.targetFolder);
	const generatedContentJson = getSingleField(fields.generatedContentJson);

	if (!image) {
		return res.status(422).json({ ok: false, error: 'Screenshot image is required.' });
	}

	if (!image.mimetype?.startsWith('image/')) {
		return res
			.status(422)
			.json({ ok: false, error: 'Only image files are supported.' });
	}

	if (image.size > MAX_IMAGE_SIZE_BYTES) {
		return res.status(422).json({ ok: false, error: 'Image exceeds 10MB limit.' });
	}

	if (!prompt.trim()) {
		return res.status(422).json({ ok: false, error: 'Prompt is required.' });
	}

	if (!targetFolder.trim()) {
		return res
			.status(422)
			.json({ ok: false, error: 'Target folder is required.' });
	}

	const candidateContent = await parseCandidateContent({
		generatedContentJson,
		prompt,
		image,
	});
	if (!candidateContent.ok) {
		return res.status(candidateContent.status).json({
			ok: false,
			error: candidateContent.error,
		});
	}

	const validation = validateGeneratedStoryContent(candidateContent.value);
	if (!validation.ok) {
		return res.status(422).json({
			ok: false,
			error: 'Generated content failed Storyblok schema validation.',
			validationErrors: validation.errors,
		});
	}

	return res.status(200).json({
		ok: true,
		message:
			'OpenAI generation succeeded and generated content passed schema validation.',
		input: {
			fileName: image.originalFilename || 'uploaded-image',
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

const parseCandidateContent = async (params: {
	generatedContentJson: string;
	prompt: string;
	image: File;
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
			image: params.image,
			prompt: params.prompt,
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