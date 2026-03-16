import { APP_BRIDGE_TOKEN_HEADER_KEY, KEY_TOKEN } from '@/utils/const';
import { FormEvent, useMemo, useState } from 'react';

const MAX_IMAGE_SIZE_MB = 10;
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;

type ValidationErrors = {
	image?: string;
	prompt?: string;
	folder?: string;
};

type GenerateResponse = {
	ok: boolean;
	message?: string;
	error?: string;
	input?: {
		fileName: string;
		mimeType: string;
		size: number;
		promptLength: number;
		targetFolder: string;
	};
	auth?: {
		spaceId?: number;
		userId?: number;
	};
};

const isValidImage = (file: File | null) => {
	if (!file) return false;
	if (!file.type.startsWith('image/')) return false;
	if (file.size > MAX_IMAGE_SIZE_BYTES) return false;
	return true;
};

export default function StoryGenerationForm() {
	const [image, setImage] = useState<File | null>(null);
	const [prompt, setPrompt] = useState('');
	const [folder, setFolder] = useState('');
	const [generatedContentJson, setGeneratedContentJson] = useState('');
	const [errors, setErrors] = useState<ValidationErrors>({});
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [result, setResult] = useState<GenerateResponse | null>(null);
	const [requestError, setRequestError] = useState<string | null>(null);

	const formReady = useMemo(() => {
		return Boolean(image) && prompt.trim().length > 0 && folder.trim().length > 0;
	}, [image, prompt, folder]);

	const validate = (): ValidationErrors => {
		const nextErrors: ValidationErrors = {};

		if (!image) {
			nextErrors.image = 'Please upload a screenshot image.';
		} else if (!image.type.startsWith('image/')) {
			nextErrors.image = 'Only image files are allowed.';
		} else if (image.size > MAX_IMAGE_SIZE_BYTES) {
			nextErrors.image = `Image is too large. Max size is ${MAX_IMAGE_SIZE_MB} MB.`;
		}

		if (!prompt.trim()) {
			nextErrors.prompt = 'Please provide a generation prompt.';
		}

		if (!folder.trim()) {
			nextErrors.folder = 'Please provide a target folder id or path.';
		}

		return nextErrors;
	};

	const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setRequestError(null);
		setResult(null);

		const nextErrors = validate();
		setErrors(nextErrors);

		if (Object.keys(nextErrors).length > 0 || !image) {
			return;
		}

		setIsSubmitting(true);
		try {
			const data = new FormData();
			data.append('image', image);
			data.append('prompt', prompt.trim());
			data.append('targetFolder', folder.trim());
			if (generatedContentJson.trim()) {
				data.append('generatedContentJson', generatedContentJson.trim());
			}

			const response = await fetch('/api/generate-story', {
				method: 'POST',
				headers: {
					[APP_BRIDGE_TOKEN_HEADER_KEY]:
						sessionStorage.getItem(KEY_TOKEN) || '',
				},
				body: data,
			});

			const json = (await response.json()) as GenerateResponse;
			if (!response.ok) {
				setRequestError(json.error || 'Failed to generate story.');
				return;
			}

			setResult(json);
		} catch (error) {
			setRequestError('Unexpected error while submitting generation request.');
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<section>
			<h2>Generate Story From Screenshot</h2>
			<p>
				Upload a screenshot and prompt. Folder targeting is entered separately and
				not included in the AI prompt.
			</p>
			<form onSubmit={onSubmit}>
				<div>
					<label htmlFor="screenshot">Screenshot</label>
					<input
						id="screenshot"
						type="file"
						accept="image/*"
						onChange={(event) => {
							setImage(event.target.files?.[0] || null);
							setErrors((prev) => ({ ...prev, image: undefined }));
						}}
					/>
					{errors.image && <p>{errors.image}</p>}
					{image && isValidImage(image) && (
						<p>
							Selected: {image.name} ({Math.round(image.size / 1024)} KB)
						</p>
					)}
				</div>

				<div>
					<label htmlFor="prompt">Prompt</label>
					<textarea
						id="prompt"
						rows={5}
						placeholder="Describe what should be generated from the screenshot..."
						value={prompt}
						onChange={(event) => {
							setPrompt(event.target.value);
							setErrors((prev) => ({ ...prev, prompt: undefined }));
						}}
					/>
					{errors.prompt && <p>{errors.prompt}</p>}
				</div>

				<div>
					<label htmlFor="folder">Target Folder</label>
					<input
						id="folder"
						type="text"
						placeholder="Example: 123456 or ai-generated"
						value={folder}
						onChange={(event) => {
							setFolder(event.target.value);
							setErrors((prev) => ({ ...prev, folder: undefined }));
						}}
					/>
					{errors.folder && <p>{errors.folder}</p>}
				</div>

				<div>
					<label htmlFor="generatedContentJson">
						Generated Content JSON (optional debug override)
					</label>
					<textarea
						id="generatedContentJson"
						rows={8}
						placeholder="Leave empty to use OpenAI. If set, this JSON is validated directly."
						value={generatedContentJson}
						onChange={(event) => {
							setGeneratedContentJson(event.target.value);
						}}
					/>
				</div>

				<button type="submit" disabled={!formReady || isSubmitting}>
					{isSubmitting ? 'Generating...' : 'Generate Story'}
				</button>
			</form>

			{requestError && <p>{requestError}</p>}
			{result && <pre>{JSON.stringify(result, null, 2)}</pre>}
		</section>
	);
}