import { APP_BRIDGE_TOKEN_HEADER_KEY, KEY_TOKEN } from '@/utils/const';
import { FormEvent, useMemo, useState } from 'react';
import {
	Alert,
	Box,
	Button,
	Card,
	CardContent,
	Divider,
	Stack,
	TextField,
	Typography,
} from '@mui/material';

const MAX_UPLOAD_IMAGE_SIZE_MB = 4;
const MAX_UPLOAD_IMAGE_SIZE_BYTES = MAX_UPLOAD_IMAGE_SIZE_MB * 1024 * 1024;
const MAX_SOURCE_IMAGE_SIZE_MB = 25;
const MAX_SOURCE_IMAGE_SIZE_BYTES = MAX_SOURCE_IMAGE_SIZE_MB * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 2400;
const JPEG_QUALITIES = [0.9, 0.82, 0.74, 0.66, 0.58, 0.5] as const;

type ValidationErrors = {
	image?: string;
	storyName?: string;
	prompt?: string;
	folder?: string;
};

type GenerateResponse = {
	ok: boolean;
	requestId?: string;
	code?: string;
	message?: string;
	error?: string;
	validationErrors?: {
		path: string;
		message: string;
	}[];
	story?: {
		id: number;
		name: string;
		slug: string;
		fullSlug?: string;
		editorUrl: string;
		parentId: number;
	};
	input?: {
		fileName: string;
		storyName: string;
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
	if (file.size > MAX_UPLOAD_IMAGE_SIZE_BYTES) return false;
	return true;
};

const readImageElement = (file: File): Promise<HTMLImageElement> => {
	return new Promise((resolve, reject) => {
		const objectUrl = URL.createObjectURL(file);
		const img = new Image();

		img.onload = () => {
			URL.revokeObjectURL(objectUrl);
			resolve(img);
		};

		img.onerror = () => {
			URL.revokeObjectURL(objectUrl);
			reject(new Error('Image could not be decoded in browser.'));
		};

		img.src = objectUrl;
	});
};

const canvasToBlob = (
	canvas: HTMLCanvasElement,
	type: string,
	quality?: number,
): Promise<Blob> => {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (!blob) {
					reject(new Error('Failed to encode image.'));
					return;
				}
				resolve(blob);
			},
			type,
			quality,
		);
	});
};

const buildCompressedFileName = (fileName: string) => {
	const lastDot = fileName.lastIndexOf('.');
	const baseName = lastDot > 0 ? fileName.slice(0, lastDot) : fileName;
	return `${baseName}.jpg`;
};

const prepareImageForUpload = async (source: File): Promise<File> => {
	if (!source.type.startsWith('image/')) {
		throw new Error('Only image files are allowed.');
	}

	if (source.size <= MAX_UPLOAD_IMAGE_SIZE_BYTES) {
		return source;
	}

	const image = await readImageElement(source);
	const canvas = document.createElement('canvas');
	const context = canvas.getContext('2d');
	if (!context) {
		throw new Error('Could not initialize image canvas.');
	}

	let width = image.naturalWidth;
	let height = image.naturalHeight;
	const initialScale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height));
	width = Math.max(1, Math.round(width * initialScale));
	height = Math.max(1, Math.round(height * initialScale));

	for (let round = 0; round < 4; round += 1) {
		canvas.width = width;
		canvas.height = height;
		context.clearRect(0, 0, width, height);
		context.drawImage(image, 0, 0, width, height);

		for (const quality of JPEG_QUALITIES) {
			const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
			if (blob.size <= MAX_UPLOAD_IMAGE_SIZE_BYTES) {
				return new File([blob], buildCompressedFileName(source.name), {
					type: 'image/jpeg',
					lastModified: Date.now(),
				});
			}
		}

		width = Math.max(1, Math.round(width * 0.8));
		height = Math.max(1, Math.round(height * 0.8));
	}

	throw new Error(
		`Image is too large to prepare for upload. Please use an image below ${MAX_SOURCE_IMAGE_SIZE_MB}MB or lower resolution.`,
	);
};

export default function StoryGenerationForm() {
	const [image, setImage] = useState<File | null>(null);
	const [originalImageMeta, setOriginalImageMeta] = useState<{
		name: string;
		size: number;
	} | null>(null);
	const [storyName, setStoryName] = useState('');
	const [prompt, setPrompt] = useState('');
	const [folder, setFolder] = useState('');
	const [generatedContentJson, setGeneratedContentJson] = useState('');
	const [errors, setErrors] = useState<ValidationErrors>({});
	const [isPreparingImage, setIsPreparingImage] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [result, setResult] = useState<GenerateResponse | null>(null);
	const [requestError, setRequestError] = useState<string | null>(null);
	const [responseMeta, setResponseMeta] = useState<string | null>(null);

	const formReady = useMemo(() => {
		return (
			Boolean(image) &&
			!isPreparingImage &&
			storyName.trim().length > 0 &&
			prompt.trim().length > 0 &&
			folder.trim().length > 0
		);
	}, [image, isPreparingImage, storyName, prompt, folder]);

	const validate = (): ValidationErrors => {
		const nextErrors: ValidationErrors = {};

		if (!image) {
			nextErrors.image = 'Please upload a screenshot image.';
		} else if (!image.type.startsWith('image/')) {
			nextErrors.image = 'Only image files are allowed.';
		} else if (image.size > MAX_UPLOAD_IMAGE_SIZE_BYTES) {
			nextErrors.image = `Image is too large. Max upload size is ${MAX_UPLOAD_IMAGE_SIZE_MB} MB.`;
		}

		if (!prompt.trim()) {
			nextErrors.prompt = 'Please provide a generation prompt.';
		}

		if (!storyName.trim()) {
			nextErrors.storyName = 'Please provide a story name.';
		}

		if (!folder.trim()) {
			nextErrors.folder = 'Please provide a target folder name, id, or path.';
		}

		return nextErrors;
	};

	const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setRequestError(null);
		setResult(null);
		setResponseMeta(null);

		const nextErrors = validate();
		setErrors(nextErrors);

		if (Object.keys(nextErrors).length > 0 || !image) {
			return;
		}

		setIsSubmitting(true);
		try {
			const data = new FormData();
			data.append('image', image);
			data.append('storyName', storyName.trim());
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

			const contentType = response.headers.get('content-type') || '';
			if (!contentType.includes('application/json')) {
				if (response.status === 413) {
					setRequestError(
						'Uploaded image is too large for the deployed API. Please use an image smaller than 4MB.',
					);
					return;
				}

				const fallbackText = await response.text();
				setRequestError(
					fallbackText || `Generation request failed with status ${response.status}.`,
				);
				return;
			}

			const json = (await response.json()) as GenerateResponse;
			setResponseMeta(
				json.requestId
					? `Request id: ${json.requestId}${json.code ? `, code: ${json.code}` : ''}`
					: null,
			);
			if (!response.ok) {
				const detail =
					json.validationErrors && json.validationErrors.length > 0
						? ` (${json.validationErrors.length} validation issue(s))`
						: '';
				setRequestError((json.error || 'Failed to generate story.') + detail);
				setResult(json);
				return;
			}

			setResult(json);
		} catch (error) {
			setRequestError('Unexpected error while submitting generation request.');
		} finally {
			setIsSubmitting(false);
		}
	};

	const onImageChange = async (selectedFile: File | null) => {
		setErrors((prev) => ({ ...prev, image: undefined }));

		if (!selectedFile) {
			setImage(null);
			setOriginalImageMeta(null);
			return;
		}

		if (!selectedFile.type.startsWith('image/')) {
			setImage(null);
			setOriginalImageMeta(null);
			setErrors((prev) => ({ ...prev, image: 'Only image files are allowed.' }));
			return;
		}

		if (selectedFile.size > MAX_SOURCE_IMAGE_SIZE_BYTES) {
			setImage(null);
			setOriginalImageMeta(null);
			setErrors((prev) => ({
				...prev,
				image: `Source image is too large. Max source size is ${MAX_SOURCE_IMAGE_SIZE_MB} MB.`,
			}));
			return;
		}

		setIsPreparingImage(true);
		try {
			const prepared = await prepareImageForUpload(selectedFile);
			setImage(prepared);
			setOriginalImageMeta({
				name: selectedFile.name,
				size: selectedFile.size,
			});
		} catch (error) {
			setImage(null);
			setOriginalImageMeta(null);
			setErrors((prev) => ({
				...prev,
				image:
					error instanceof Error ? error.message : 'Image could not be prepared for upload.',
			}));
		} finally {
			setIsPreparingImage(false);
		}
	};

	return (
		<Card variant="outlined">
			<CardContent>
				<Stack spacing={2.5}>
					<Box>
						<Typography variant="h6" component="h2" gutterBottom>
							Generate Story From Screenshot
						</Typography>
						<Typography variant="body2" color="text.secondary">
							Upload a screenshot and prompt. Folder targeting is entered
							separately and not included in the AI prompt.
						</Typography>
					</Box>

					<Divider />

					<Box component="form" onSubmit={onSubmit} noValidate>
						<Stack spacing={2}>
							<TextField
								id="storyName"
								label="Story Name"
								placeholder="Example: Spring Campaign Landing Page"
								value={storyName}
								onChange={(event) => {
									setStoryName(event.target.value);
									setErrors((prev) => ({ ...prev, storyName: undefined }));
								}}
								error={Boolean(errors.storyName)}
								helperText={errors.storyName}
								fullWidth
							/>

							<Box>
								<Typography variant="body2" fontWeight={600} gutterBottom>
									Screenshot
								</Typography>
								<Button component="label" variant="outlined">
									Choose Image
									<input
										hidden
										type="file"
										accept="image/*"
										onChange={(event) => {
											void onImageChange(event.target.files?.[0] || null);
										}}
									/>
								</Button>
								{isPreparingImage && (
									<Typography variant="body2" color="text.secondary" mt={1}>
										Preparing image for upload...
									</Typography>
								)}
								{errors.image && (
									<Typography color="error" variant="body2" mt={1}>
										{errors.image}
									</Typography>
								)}
								{image && isValidImage(image) && (
									<Typography variant="body2" color="text.secondary" mt={1}>
										Upload file: {image.name} ({Math.round(image.size / 1024)} KB)
										{originalImageMeta && originalImageMeta.size !== image.size
											? ` (compressed from ${Math.round(originalImageMeta.size / 1024)} KB)`
											: ''}
									</Typography>
								)}
							</Box>

							<TextField
								id="prompt"
								label="Prompt"
								placeholder="Describe what should be generated from the screenshot..."
								value={prompt}
								onChange={(event) => {
									setPrompt(event.target.value);
									setErrors((prev) => ({ ...prev, prompt: undefined }));
								}}
								error={Boolean(errors.prompt)}
								helperText={errors.prompt}
								fullWidth
								multiline
								minRows={5}
							/>

							<TextField
								id="folder"
								label="Target Folder (name, path, or id)"
								placeholder="Example: Homepage, ai-generated, or 123456"
								value={folder}
								onChange={(event) => {
									setFolder(event.target.value);
									setErrors((prev) => ({ ...prev, folder: undefined }));
								}}
								error={Boolean(errors.folder)}
								helperText={errors.folder}
								fullWidth
							/>

							<TextField
								id="generatedContentJson"
								label="Generated Content JSON (optional debug override)"
								placeholder="Leave empty to use OpenAI. If set, this JSON is validated directly."
								value={generatedContentJson}
								onChange={(event) => {
									setGeneratedContentJson(event.target.value);
								}}
								fullWidth
								multiline
								minRows={8}
							/>

							<Button
								type="submit"
								variant="contained"
								disableElevation
								disabled={!formReady || isSubmitting || isPreparingImage}
							>
								{isSubmitting ? 'Generating...' : 'Generate Story'}
							</Button>
						</Stack>
					</Box>

					{requestError && <Alert severity="error">{requestError}</Alert>}
					{responseMeta && <Alert severity="info">{responseMeta}</Alert>}
					{result?.validationErrors && result.validationErrors.length > 0 && (
						<Alert severity="warning">
							<Typography variant="body2" fontWeight={600} mb={1}>
								Validation errors
							</Typography>
							<ul>
								{result.validationErrors.map((issue) => (
									<li key={`${issue.path}:${issue.message}`}>
										{issue.path}: {issue.message}
									</li>
								))}
							</ul>
						</Alert>
					)}
					{result?.story && (
						<Alert severity="success">
							<Typography variant="body2">
								Created draft story {result.story.name} (#{result.story.id}) in
								 folder {result.story.parentId}.
							</Typography>
							<Box mt={1}>
								<Button
									component="a"
									href={result.story.editorUrl}
									target="_blank"
									rel="noreferrer"
									size="small"
								>
									Open in Storyblok editor
								</Button>
							</Box>
						</Alert>
					)}
					{result && (
						<TextField
							label="Raw API Response"
							value={JSON.stringify(result, null, 2)}
							fullWidth
							multiline
							minRows={10}
							InputProps={{ readOnly: true }}
						/>
					)}
				</Stack>
			</CardContent>
		</Card>
	);
}