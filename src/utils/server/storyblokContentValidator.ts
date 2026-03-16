const ALLOWED_COMPONENTS = new Set([
	'page',
	'grid',
	'accordion',
	'accordionItem',
	'teaser',
	'feature',
]);

const MAX_DEPTH = 20;

export type ValidationIssue = {
	path: string;
	message: string;
};

export type ValidationResult =
	| {
		ok: true;
		value: Record<string, unknown>;
	  }
	| {
		ok: false;
		errors: ValidationIssue[];
	  };

export const validateGeneratedStoryContent = (
	input: unknown,
): ValidationResult => {
	const errors: ValidationIssue[] = [];

	if (!isPlainObject(input)) {
		return {
			ok: false,
			errors: [{ path: 'content', message: 'Content must be an object.' }],
		};
	}

	validateBlock(input, 'content', errors, 0, { expectedComponent: 'page' });

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return { ok: true, value: input };
};

const validateBlock = (
	value: unknown,
	path: string,
	errors: ValidationIssue[],
	depth: number,
	options?: { expectedComponent?: string },
) => {
	if (depth > MAX_DEPTH) {
		errors.push({ path, message: `Nesting is too deep (>${MAX_DEPTH}).` });
		return;
	}

	if (!isPlainObject(value)) {
		errors.push({ path, message: 'Block must be an object.' });
		return;
	}

	const component = value.component;
	const uid = value._uid;

	if (typeof component !== 'string' || component.length === 0) {
		errors.push({ path: `${path}.component`, message: 'Missing component name.' });
		return;
	}

	if (!ALLOWED_COMPONENTS.has(component)) {
		errors.push({
			path: `${path}.component`,
			message: `Unsupported component \"${component}\".`,
		});
		return;
	}

	if (options?.expectedComponent && component !== options.expectedComponent) {
		errors.push({
			path: `${path}.component`,
			message: `Expected component \"${options.expectedComponent}\".`,
		});
	}

	if (typeof uid !== 'string' || uid.trim().length === 0) {
		errors.push({ path: `${path}._uid`, message: 'Missing _uid string.' });
	}

	switch (component) {
		case 'page':
			validateBlockArray(value.body, `${path}.body`, errors, depth + 1);
			return;
		case 'grid':
			validateBlockArray(value.columns, `${path}.columns`, errors, depth + 1);
			return;
		case 'accordion':
			validateAccordionItems(value.accordionItem, `${path}.accordionItem`, errors, depth + 1);
			return;
		case 'accordionItem':
			validateAccordionItem(value, path, errors, depth + 1);
			return;
		case 'teaser':
			if (
				value.headline !== undefined &&
				typeof value.headline !== 'string'
			) {
				errors.push({
					path: `${path}.headline`,
					message: 'headline must be a string when provided.',
				});
			}
			return;
		case 'feature':
			if (value.name !== undefined && typeof value.name !== 'string') {
				errors.push({
					path: `${path}.name`,
					message: 'name must be a string when provided.',
				});
			}
			return;
		default:
			return;
	}
};

const validateBlockArray = (
	value: unknown,
	path: string,
	errors: ValidationIssue[],
	depth: number,
) => {
	if (value === undefined) {
		return;
	}

	if (!Array.isArray(value)) {
		errors.push({ path, message: 'Value must be an array of blocks.' });
		return;
	}

	value.forEach((item, index) => {
		validateBlock(item, `${path}[${index}]`, errors, depth);
	});
};

const validateAccordionItems = (
	value: unknown,
	path: string,
	errors: ValidationIssue[],
	depth: number,
) => {
	if (!Array.isArray(value)) {
		errors.push({
			path,
			message: 'accordionItem is required and must be an array.',
		});
		return;
	}

	if (value.length < 1) {
		errors.push({
			path,
			message: 'accordionItem must contain at least one item.',
		});
	}

	value.forEach((item, index) => {
		validateBlock(item, `${path}[${index}]`, errors, depth, {
			expectedComponent: 'accordionItem',
		});
	});
};

const validateAccordionItem = (
	value: Record<string, unknown>,
	path: string,
	errors: ValidationIssue[],
	depth: number,
) => {
	if (value.titel !== undefined && typeof value.titel !== 'string') {
		errors.push({
			path: `${path}.titel`,
			message: 'titel must be a string when provided.',
		});
	}

	if (value.content !== undefined) {
		validateRichtextNode(value.content, `${path}.content`, errors, depth);
	}
};

const validateRichtextNode = (
	value: unknown,
	path: string,
	errors: ValidationIssue[],
	depth: number,
) => {
	if (depth > MAX_DEPTH) {
		errors.push({ path, message: `Richtext nesting is too deep (>${MAX_DEPTH}).` });
		return;
	}

	if (!isPlainObject(value)) {
		errors.push({ path, message: 'Richtext node must be an object.' });
		return;
	}

	if (typeof value.type !== 'string' || value.type.trim().length === 0) {
		errors.push({ path: `${path}.type`, message: 'Richtext node requires type.' });
	}

	if (value.text !== undefined && typeof value.text !== 'string') {
		errors.push({
			path: `${path}.text`,
			message: 'Richtext text must be a string when provided.',
		});
	}

	if (value.attrs !== undefined && !isPlainObject(value.attrs)) {
		errors.push({
			path: `${path}.attrs`,
			message: 'Richtext attrs must be an object when provided.',
		});
	}

	if (value.content !== undefined) {
		if (!Array.isArray(value.content)) {
			errors.push({
				path: `${path}.content`,
				message: 'Richtext content must be an array when provided.',
			});
		} else {
			value.content.forEach((node, index) => {
				validateRichtextNode(node, `${path}.content[${index}]`, errors, depth + 1);
			});
		}
	}

	if (value.marks !== undefined) {
		if (!Array.isArray(value.marks)) {
			errors.push({
				path: `${path}.marks`,
				message: 'Richtext marks must be an array when provided.',
			});
		} else {
			value.marks.forEach((mark, index) => {
				validateRichtextNode(mark, `${path}.marks[${index}]`, errors, depth + 1);
			});
		}
	}
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	return (
		typeof value === 'object' && value !== null && !Array.isArray(value)
	);
};
