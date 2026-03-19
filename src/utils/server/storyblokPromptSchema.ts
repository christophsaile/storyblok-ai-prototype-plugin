type StoryblokComponentSchemaField = {
	type?: string;
	required?: boolean;
	options?: Array<{ value?: string }>;
	component_whitelist?: string[];
	minimum?: number | string;
	maximum?: number | string;
};

type StoryblokComponent = {
	name?: string;
	display_name?: string;
	description?: string | null;
	is_root?: boolean;
	schema?: Record<string, StoryblokComponentSchemaField>;
};

export type PromptSchemaField = {
	name: string;
	type: string;
	required: boolean;
	options?: string[];
	allowedComponents?: string[];
	minimum?: number;
	maximum?: number;
};

export type PromptSchemaComponent = {
	name: string;
	displayName?: string;
	description?: string;
	isRoot: boolean;
	fields: PromptSchemaField[];
};

export type StoryblokPromptSchemaContext = {
	components: PromptSchemaComponent[];
	allowedComponents: string[];
	rootComponents: string[];
	rawComponentsJson: string;
	storyblokTypes: string;
};

export const toPromptSchemaContext = (
	input: unknown,
	options: { storyblokTypes: string },
): StoryblokPromptSchemaContext | null => {
	if (!isPlainObject(input) || !Array.isArray(input.components)) {
		return null;
	}

	const storyblokTypes = normalizeStoryblokTypes(options.storyblokTypes);
	if (!storyblokTypes) {
		return null;
	}

	const rawComponentsJson = JSON.stringify(input.components, null, 2);
	if (!rawComponentsJson || rawComponentsJson === '[]') {
		return null;
	}

	const components = input.components
		.filter(isPlainObject)
		.map((component) => normalizeComponent(component as StoryblokComponent))
		.filter((component): component is PromptSchemaComponent => component !== null);

	if (components.length === 0) {
		return null;
	}

	const allowedComponents = Array.from(new Set(components.map((component) => component.name)));
	const rootComponents = components
		.filter((component) => component.isRoot)
		.map((component) => component.name);

	return {
		components,
		allowedComponents,
		rootComponents,
		rawComponentsJson,
		storyblokTypes,
	};
};

const normalizeStoryblokTypes = (value?: string) => {
	if (typeof value !== 'string') {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeComponent = (input: StoryblokComponent): PromptSchemaComponent | null => {
	if (typeof input.name !== 'string' || input.name.trim().length === 0) {
		return null;
	}

	const fields = normalizeFields(input.schema);
	return {
		name: input.name,
		displayName:
			typeof input.display_name === 'string' && input.display_name.trim().length > 0
				? input.display_name
				: undefined,
		description:
			typeof input.description === 'string' && input.description.trim().length > 0
				? input.description
				: undefined,
		isRoot: Boolean(input.is_root),
		fields,
	};
};

const normalizeFields = (
	schema?: Record<string, StoryblokComponentSchemaField>,
): PromptSchemaField[] => {
	if (!schema || !isPlainObject(schema)) {
		return [];
	}

	return Object.entries(schema)
		.filter(([name]) => name.trim().length > 0)
		.map(([name, field]) => {
			const normalized: PromptSchemaField = {
				name,
				type: typeof field.type === 'string' ? field.type : 'unknown',
				required: Boolean(field.required),
			};

			const options = normalizeOptions(field.options);
			if (options.length > 0) {
				normalized.options = options;
			}

			const allowedComponents = normalizeStringArray(field.component_whitelist);
			if (allowedComponents.length > 0) {
				normalized.allowedComponents = allowedComponents;
			}

			const minimum = normalizeNumber(field.minimum);
			if (minimum !== undefined) {
				normalized.minimum = minimum;
			}

			const maximum = normalizeNumber(field.maximum);
			if (maximum !== undefined) {
				normalized.maximum = maximum;
			}

			return normalized;
		});
};

const normalizeOptions = (options?: Array<{ value?: string }>) => {
	if (!Array.isArray(options)) {
		return [];
	}

	return options
		.map((option) => option?.value)
		.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
};

const normalizeStringArray = (value: unknown) => {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter(
		(item): item is string => typeof item === 'string' && item.trim().length > 0,
	);
};

const normalizeNumber = (value: unknown) => {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === 'string' && value.trim().length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}

	return undefined;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
};